import type { DetectedPorts } from 'boards-list'
import deepEqual from 'fast-deep-equal'
import * as vscode from 'vscode'

import type { MonitorBridgeClient } from '../monitor/monitorBridgeClient'

export type PortId = string

export interface DefaultBaudrateHint {
  readonly portId: PortId
  readonly baudrate: number
}

/** Subscribes to the shared monitor bridge to surface detected port changes. */
export class BoardsListWatcher implements vscode.Disposable {
  private readonly onDidChangeDetectedPortsEmitter =
    new vscode.EventEmitter<DetectedPorts>()

  private readonly onDidChangeDefaultBaudrateHintEmitter =
    new vscode.EventEmitter<DefaultBaudrateHint | undefined>()

  private readonly onDidChangeCliDaemonConnectionEmitter =
    new vscode.EventEmitter<boolean>()

  private readonly disposables: vscode.Disposable[] = [
    this.onDidChangeDetectedPortsEmitter,
    this.onDidChangeDefaultBaudrateHintEmitter,
    this.onDidChangeCliDaemonConnectionEmitter,
  ]

  private started = false
  private disposed = false
  private _detectedPorts: DetectedPorts = {}

  constructor(private readonly bridgeClient: MonitorBridgeClient) {}

  get onDidChangeDetectedPorts(): vscode.Event<DetectedPorts> {
    return this.onDidChangeDetectedPortsEmitter.event
  }

  get detectedPorts(): DetectedPorts {
    return this._detectedPorts
  }

  get onDidChangeDefaultBaudrateHint(): vscode.Event<
    DefaultBaudrateHint | undefined
  > {
    return this.onDidChangeDefaultBaudrateHintEmitter.event
  }

  get onDidChangeCliDaemonConnection(): vscode.Event<boolean> {
    return this.onDidChangeCliDaemonConnectionEmitter.event
  }

  start(): void {
    if (this.started || this.disposed) {
      return
    }
    this.started = true
    this.disposables.push(
      this.bridgeClient.onDidChangeDetectedPorts((ports) =>
        this.handleDetectedPorts(ports)
      )
    )
    this.bridgeClient
      .requestDetectedPorts()
      .then((ports) => {
        this.onDidChangeCliDaemonConnectionEmitter.fire(true)
        this.handleDetectedPorts(ports)
      })
      .catch((error) => {
        console.error('[BoardsListWatcher] Failed to request ports', error)
      })
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop()
      try {
        disposable?.dispose()
      } catch (error) {
        console.error('[BoardsListWatcher] dispose failed', error)
      }
    }
    this.onDidChangeCliDaemonConnectionEmitter.fire(false)
  }

  private handleDetectedPorts(detectedPorts: DetectedPorts): void {
    if (deepEqual(this._detectedPorts, detectedPorts)) {
      return
    }
    this._detectedPorts = detectedPorts
    this.onDidChangeDetectedPortsEmitter.fire(detectedPorts)
  }
}
