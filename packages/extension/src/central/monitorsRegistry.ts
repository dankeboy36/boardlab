import * as vscode from 'vscode'

export type PortId = string

export interface MonitorState {
  readonly running: boolean
  readonly paused: boolean
  readonly ownerWindowId: string | null
  readonly lastKnownBaud?: number
}

export type MonitorsSnapshot = Record<PortId, MonitorState>

export interface MonitorsRegistry extends vscode.Disposable {
  readonly onDidChange: vscode.Event<MonitorsSnapshot>
  get(port: PortId): MonitorState | undefined
  set(port: PortId, state: MonitorState): void
  delete(port: PortId): void
  list(): MonitorsSnapshot
}

/**
 * Central registry for tracking monitors across VS Code windows.
 *
 * Day 1 skeleton: simple in-memory map with change notifications.
 */
export class InMemoryMonitorsRegistry implements MonitorsRegistry {
  private readonly states = new Map<PortId, MonitorState>()
  private readonly onDidChangeEmitter =
    new vscode.EventEmitter<MonitorsSnapshot>()

  private readonly disposables: vscode.Disposable[] = [this.onDidChangeEmitter]

  get onDidChange(): vscode.Event<MonitorsSnapshot> {
    return this.onDidChangeEmitter.event
  }

  get(port: PortId): MonitorState | undefined {
    const state = this.states.get(port)
    return state ? { ...state } : undefined
  }

  set(port: PortId, state: MonitorState): void {
    this.states.set(port, { ...state })
    this.fireDidChange()
  }

  delete(port: PortId): void {
    if (this.states.delete(port)) {
      this.fireDidChange()
    }
  }

  list(): MonitorsSnapshot {
    const snapshot: MonitorsSnapshot = {}
    for (const [portId, state] of this.states.entries()) {
      snapshot[portId] = { ...state }
    }
    return snapshot
  }

  dispose(): void {
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop()
      try {
        disposable?.dispose()
      } catch (err) {
        console.error('[MonitorsRegistry] dispose failed', err)
      }
    }
  }

  private fireDidChange(): void {
    this.onDidChangeEmitter.fire(this.list())
  }
}
