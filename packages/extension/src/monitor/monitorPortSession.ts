import { createPortKey, type PortIdentifier } from 'boards-list'

import type {
  MonitorSessionDesired,
  MonitorSessionError,
  MonitorSessionPauseReason,
  MonitorSessionState,
  MonitorSessionStatus,
} from '@boardlab/protocol'

const GLOBAL_INTENT_CLIENT_ID = '__global__'

export type MonitorPortSessionAction =
  | {
      readonly type: 'open'
      readonly port: PortIdentifier
      readonly attemptId: number
      readonly baudrate?: string
    }
  | { readonly type: 'close'; readonly port: PortIdentifier }

export class MonitorPortSession {
  private port: PortIdentifier
  private readonly portKey: string
  private desired: MonitorSessionDesired = 'stopped'
  private status: MonitorSessionStatus = 'idle'
  private detected = false
  private openPending = false
  private closePending = false
  private readonly clients = new Set<string>()
  private readonly runningClients = new Set<string>()
  private currentAttemptId: number | null = null
  private lastCompletedAttemptId: number | null = null
  private pauseReason: MonitorSessionPauseReason | undefined
  private lastError: MonitorSessionError | undefined
  private monitorSessionId: string | undefined
  private baudrate: string | undefined
  private attemptCounter = 0

  constructor(port: PortIdentifier) {
    this.port = port
    this.portKey = createPortKey(port)
  }

  updatePort(port: PortIdentifier): void {
    if (createPortKey(port) !== this.portKey) {
      return
    }
    this.port = port
  }

  setBaudrate(baudrate?: string): void {
    if (baudrate) {
      this.baudrate = baudrate
    }
  }

  attachClient(clientId: string): void {
    if (!clientId) {
      return
    }
    this.clients.add(clientId)
  }

  detachClient(clientId: string): void {
    if (!clientId) {
      return
    }
    this.clients.delete(clientId)
    this.runningClients.delete(clientId)
    if (this.clients.size === 0) {
      this.resetForNoClients()
    }
  }

  intentStart(clientId?: string): void {
    if (clientId) {
      this.runningClients.add(clientId)
    } else {
      this.runningClients.add(GLOBAL_INTENT_CLIENT_ID)
    }
    this.recomputeDesired()
  }

  intentStop(clientId?: string): void {
    if (clientId) {
      this.runningClients.delete(clientId)
    } else {
      this.runningClients.clear()
    }
    this.recomputeDesired()
    if (
      this.desired === 'stopped' &&
      (this.status === 'paused' || this.status === 'idle')
    ) {
      this.pauseReason = 'user'
    }
  }

  intentResume(clientId?: string): void {
    this.intentStart(clientId)
  }

  markDetected(detected: boolean): void {
    this.detected = detected
    if (!detected) {
      if (this.status === 'active' || this.status === 'connecting') {
        this.status = 'paused'
        this.pauseReason = 'resource-missing'
      }
      if (this.openPending || this.closePending) {
        this.openPending = false
        this.closePending = false
        this.currentAttemptId = null
      }
    }
  }

  markPaused(reason: MonitorSessionPauseReason): void {
    this.openPending = false
    this.status = 'paused'
    this.pauseReason = reason
  }

  markMonitorStarted(params: {
    monitorSessionId?: string
    baudrate?: string
  }): void {
    this.status = 'active'
    this.openPending = false
    this.closePending = false
    this.pauseReason = undefined
    this.lastError = undefined
    this.monitorSessionId = params.monitorSessionId
    if (params.baudrate) {
      this.baudrate = params.baudrate
    }
    if (this.currentAttemptId !== null) {
      this.lastCompletedAttemptId = this.currentAttemptId
    }
    this.currentAttemptId = null
  }

  markMonitorStopped(reason?: MonitorSessionPauseReason): void {
    this.openPending = false
    this.closePending = false
    this.monitorSessionId = undefined
    if (this.desired === 'running' && this.clients.size > 0) {
      this.status = 'paused'
      this.pauseReason =
        reason ?? (this.detected ? 'resource-busy' : 'resource-missing')
    } else {
      this.status = 'idle'
      this.pauseReason = undefined
    }
  }

  markOpenError(error: MonitorSessionError): void {
    this.openPending = false
    this.status = 'error'
    this.pauseReason = undefined
    this.lastError = error
    if (this.currentAttemptId !== null) {
      this.lastCompletedAttemptId = this.currentAttemptId
    }
    this.currentAttemptId = null
  }

  markOpenTimeout(): void {
    this.markOpenError({
      code: 'timeout',
      message: 'Monitor open timed out',
    })
  }

  nextAction(): MonitorPortSessionAction | null {
    if (this.openPending || this.closePending) {
      return null
    }
    if (this.desired === 'running' && this.clients.size > 0 && this.detected) {
      if (
        this.status === 'idle' ||
        this.status === 'paused' ||
        this.status === 'error'
      ) {
        const attemptId = this.nextAttemptId()
        this.currentAttemptId = attemptId
        this.openPending = true
        this.status = 'connecting'
        this.pauseReason = undefined
        this.lastError = undefined
        return {
          type: 'open',
          port: this.port,
          attemptId,
          baudrate: this.baudrate,
        }
      }
    }
    if (
      this.desired === 'stopped' &&
      (this.status === 'active' || this.status === 'connecting')
    ) {
      this.closePending = true
      return { type: 'close', port: this.port }
    }
    return null
  }

  snapshot(): MonitorSessionState {
    return {
      portKey: this.portKey,
      port: this.port,
      status: this.status,
      desired: this.desired,
      detected: this.detected,
      clients: Array.from(this.clients).sort(),
      openPending: this.openPending,
      closePending: this.closePending,
      currentAttemptId: this.currentAttemptId,
      lastCompletedAttemptId: this.lastCompletedAttemptId,
      pauseReason: this.pauseReason,
      lastError: this.lastError,
      monitorSessionId: this.monitorSessionId,
      baudrate: this.baudrate,
    }
  }

  private nextAttemptId(): number {
    this.attemptCounter += 1
    return this.attemptCounter
  }

  private resetForNoClients(): void {
    this.runningClients.clear()
    this.recomputeDesired()
    const shouldCloseActive =
      this.status === 'active' || this.status === 'connecting'
    if (!shouldCloseActive) {
      this.status = 'idle'
    }
    this.openPending = false
    this.closePending = false
    this.pauseReason = undefined
    this.lastError = undefined
    this.currentAttemptId = null
    if (!shouldCloseActive) {
      this.monitorSessionId = undefined
    }
  }

  private recomputeDesired(): void {
    this.desired = this.runningClients.size > 0 ? 'running' : 'stopped'
  }
}
