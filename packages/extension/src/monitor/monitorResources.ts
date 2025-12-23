import { createPortKey, type PortIdentifier } from 'boards-list'
import * as vscode from 'vscode'

import { type MonitorManager, type MonitorRuntimeState } from './monitorManager'

export class MonitorResource implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private readonly onDidChangeStateEmitter =
    new vscode.EventEmitter<MonitorRuntimeState>()

  private refCount = 0
  private currentState: MonitorRuntimeState

  readonly onDidChangeState = this.onDidChangeStateEmitter.event

  constructor(
    readonly port: PortIdentifier,
    private readonly monitorManager: MonitorManager
  ) {
    this.currentState = monitorManager.getMonitorState(port)
    this.disposables.push(
      monitorManager.onDidChangeMonitorState((event) => {
        if (
          createPortKey(event.port) === createPortKey(this.port) &&
          event.state !== this.currentState
        ) {
          this.currentState = event.state
          this.onDidChangeStateEmitter.fire(event.state)
        }
      })
    )
  }

  get state(): MonitorRuntimeState {
    return this.currentState
  }

  retain(): void {
    this.refCount += 1
  }

  release(): number {
    if (this.refCount > 0) {
      this.refCount -= 1
    }
    return this.refCount
  }

  setState(state: MonitorRuntimeState): void {
    if (state === this.currentState) {
      return
    }
    this.currentState = state
    this.onDidChangeStateEmitter.fire(state)
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose()
    }
    this.onDidChangeStateEmitter.dispose()
  }

  async resume(): Promise<void> {
    if (this.currentState === 'running') {
      return
    }
    if (this.currentState !== 'suspended') {
      return
    }
    const resumed = await this.monitorManager.resumeMonitor(this.port)
    if (!resumed) {
      console.warn('Monitor resume request returned false', {
        port: this.port,
      })
      return
    }
    this.setState('running')
  }
}

export class MonitorResourceStore implements vscode.Disposable {
  private readonly resources = new Map<string, MonitorResource>()

  constructor(private readonly monitorManager: MonitorManager) {}

  acquire(port: PortIdentifier): MonitorResource {
    const key = createPortKey(port)
    let resource = this.resources.get(key)
    if (!resource) {
      resource = new MonitorResource(port, this.monitorManager)
      this.resources.set(key, resource)
    }
    resource.retain()
    return resource
  }

  release(port: PortIdentifier): void {
    const key = createPortKey(port)
    const resource = this.resources.get(key)
    if (!resource) {
      return
    }
    const remaining = resource.release()
    if (remaining <= 0) {
      this.resources.delete(key)
      resource.dispose()
    }
  }

  dispose(): void {
    for (const resource of this.resources.values()) {
      resource.dispose()
    }
    this.resources.clear()
  }
}
