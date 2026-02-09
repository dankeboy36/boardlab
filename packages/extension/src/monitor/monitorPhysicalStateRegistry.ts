import { createPortKey, type PortIdentifier } from 'boards-list'
import * as vscode from 'vscode'

import type {
  MonitorPhysicalState,
  PhysicalSessionState,
} from '@boardlab/protocol'

function now(): string {
  return new Date().toISOString()
}

interface MarkParams {
  readonly monitorSessionId?: string
  readonly baudrate?: string
  readonly reason?: string
  readonly attemptId?: number
  readonly error?: string
}

export class MonitorPhysicalStateRegistry implements vscode.Disposable {
  private readonly states = new Map<string, MonitorPhysicalState>()
  private readonly attemptIds = new Map<string, number>()
  private readonly onDidChangeEmitter =
    new vscode.EventEmitter<MonitorPhysicalState>()

  readonly onDidChange = this.onDidChangeEmitter.event

  dispose(): void {
    this.onDidChangeEmitter.dispose()
  }

  snapshot(): MonitorPhysicalState[] {
    return Array.from(this.states.values())
  }

  get(port: PortIdentifier): MonitorPhysicalState | undefined {
    return this.states.get(createPortKey(port))
  }

  markStarting(port: PortIdentifier, params?: MarkParams): void {
    const attemptId = params?.attemptId ?? this.bumpAttempt(port)
    this.applyState(port, 'STARTING', {
      ...params,
      attemptId,
    })
  }

  markStart(port: PortIdentifier, params?: MarkParams): void {
    const attemptId = params?.attemptId ?? this.bumpAttempt(port)
    this.applyState(port, 'STARTED', {
      ...params,
      attemptId,
    })
  }

  markStop(port: PortIdentifier, params?: MarkParams): void {
    const attemptId =
      params?.attemptId ?? this.attemptIds.get(createPortKey(port))
    this.applyState(port, 'STOPPED', {
      ...params,
      attemptId,
    })
  }

  markFailed(port: PortIdentifier, params: MarkParams): void {
    const attemptId =
      params?.attemptId ?? this.attemptIds.get(createPortKey(port))
    this.applyState(port, 'FAILED', {
      ...params,
      attemptId,
    })
  }

  private bumpAttempt(port: PortIdentifier): number {
    const key = createPortKey(port)
    const next = (this.attemptIds.get(key) ?? 0) + 1
    this.attemptIds.set(key, next)
    return next
  }

  private applyState(
    port: PortIdentifier,
    state: PhysicalSessionState,
    params: MarkParams
  ): void {
    const key = createPortKey(port)
    const previous = this.states.get(key)
    const next: MonitorPhysicalState = {
      port,
      state,
      monitorSessionId: params.monitorSessionId,
      baudrate: params.baudrate,
      attemptId: params.attemptId,
      reason: params.reason,
      error: params.error,
      updatedAt: now(),
    }
    if (
      previous &&
      previous.state === next.state &&
      previous.monitorSessionId === next.monitorSessionId &&
      previous.attemptId === next.attemptId &&
      previous.reason === next.reason &&
      previous.error === next.error &&
      previous.baudrate === next.baudrate
    ) {
      return
    }
    this.states.set(key, next)
    this.onDidChangeEmitter.fire(next)
  }
}
