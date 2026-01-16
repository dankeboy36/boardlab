import {
  createPortKey,
  type DetectedPorts,
  type PortIdentifier,
} from 'boards-list'

/**
 * Logical monitor FSM types mirror the webview reducer but live in the
 * extension so we can reason about bridge-originated physical states with
 * deterministic attempt correlation.
 */

export type WaitingReason =
  | 'no-port-selected'
  | 'waiting-for-detection'
  | 'port-temporarily-missing'

export type PauseReason =
  | 'user'
  | 'suspend'
  | 'resource-busy'
  | 'resource-missing'

export type MonitorError =
  | { kind: 'busy'; detail?: string }
  | { kind: 'gone'; detail?: string }
  | { kind: 'bridgeDisconnected'; detail?: string }
  | { kind: 'internal'; detail?: string }

export type DesiredState = 'running' | 'stopped'

export type LogicalMonitorState =
  | { kind: 'idle' }
  | { kind: 'waitingForPort'; reason: WaitingReason; port?: PortIdentifier }
  | { kind: 'connecting'; port: PortIdentifier }
  | { kind: 'active'; port: PortIdentifier }
  | { kind: 'paused'; port: PortIdentifier; reason: PauseReason }
  | {
      kind: 'error'
      port: PortIdentifier | undefined
      error: MonitorError
      resumable: boolean
    }
  | { kind: 'closed' }

export interface MonitorContext {
  readonly logical: LogicalMonitorState
  readonly desired: DesiredState
  readonly currentAttemptId: number | null
  readonly lastCompletedAttemptId: number | null
  readonly selectedPort?: PortIdentifier
  readonly selectedDetected?: boolean
  readonly lastError?: MonitorError
}

export type MonitorEvent =
  | { type: 'RESET' }
  | { type: 'PORT_SELECTED'; port?: PortIdentifier; detected?: boolean }
  | { type: 'PORT_DETECTED'; port: PortIdentifier }
  | { type: 'PORT_LOST'; port: PortIdentifier }
  | { type: 'USER_START'; port?: PortIdentifier }
  | { type: 'USER_STOP'; port?: PortIdentifier }
  | { type: 'OPEN_REQUESTED'; port?: PortIdentifier; attemptId?: number }
  | { type: 'OPEN_OK'; port?: PortIdentifier; attemptId?: number }
  | {
      type: 'OPEN_FAIL'
      port?: PortIdentifier
      attemptId?: number
      error: MonitorError
    }
  | { type: 'STREAM_CLOSED'; port?: PortIdentifier; attemptId?: number }
  | { type: 'BRIDGE_DISCONNECTED' }
  | { type: 'BAUDRATE_CHANGED'; port?: PortIdentifier }

export interface MonitorPhysicalState {
  readonly port: PortIdentifier
  readonly state:
    | 'CREATED'
    | 'STARTING'
    | 'STARTED'
    | 'STOPPING'
    | 'STOPPED'
    | 'FAILED'
  readonly monitorSessionId?: string
  readonly baudrate?: string
  readonly attemptId?: number
  readonly reason?: string
  readonly error?: string
  readonly updatedAt?: string
}

export function initialMonitorContext(): MonitorContext {
  return {
    logical: { kind: 'idle' },
    desired: 'stopped',
    currentAttemptId: null,
    lastCompletedAttemptId: null,
    selectedPort: undefined,
    selectedDetected: false,
    lastError: undefined,
  }
}

export function reduceMonitorContext(
  state: MonitorContext | undefined,
  event: MonitorEvent
): MonitorContext {
  const ctx = state ?? initialMonitorContext()
  if (!event || typeof event !== 'object') {
    return ctx
  }
  switch (event.type) {
    case 'RESET':
      return initialMonitorContext()
    case 'PORT_SELECTED': {
      const selectedPort = event.port
      const selectedDetected = event.detected ?? false
      const next = {
        ...ctx,
        selectedPort,
        selectedDetected,
        currentAttemptId: null,
        lastError: undefined,
      }
      return alignWithDesired(next, selectedDetected)
    }
    case 'PORT_DETECTED': {
      if (!ctx.selectedPort || !isSamePort(ctx.selectedPort, event.port)) {
        return ctx
      }
      const next = { ...ctx, selectedDetected: true, lastError: undefined }
      return alignWithDesired(next, true)
    }
    case 'PORT_LOST': {
      if (!ctx.selectedPort || !isSamePort(ctx.selectedPort, event.port)) {
        return ctx
      }
      return {
        ...ctx,
        selectedDetected: false,
        logical: {
          kind: 'waitingForPort',
          reason: 'port-temporarily-missing',
          port: ctx.selectedPort,
        },
        currentAttemptId: null,
      }
    }
    case 'USER_START': {
      const next = {
        ...ctx,
        desired: 'running' as const,
        lastError: undefined,
      }
      return alignWithDesired(next)
    }
    case 'USER_STOP':
      return {
        ...ctx,
        desired: 'stopped',
        logical: ctx.selectedPort
          ? { kind: 'paused', port: ctx.selectedPort, reason: 'user' }
          : { kind: 'idle' },
        currentAttemptId: null,
      }
    case 'OPEN_REQUESTED': {
      const attemptId = nextAttemptId(ctx, event.attemptId)
      const port = event.port ?? ctx.selectedPort
      return {
        ...ctx,
        desired: 'running',
        selectedPort: port ?? ctx.selectedPort,
        selectedDetected: port ? true : ctx.selectedDetected,
        logical: port ? { kind: 'connecting', port } : ctx.logical,
        currentAttemptId: attemptId,
        lastError: undefined,
      }
    }
    case 'OPEN_OK': {
      if (
        ctx.currentAttemptId &&
        event.attemptId &&
        event.attemptId !== ctx.currentAttemptId
      ) {
        return ctx
      }
      if (
        event.port &&
        ctx.selectedPort &&
        !isSamePort(ctx.selectedPort, event.port)
      ) {
        return ctx
      }
      const resolvedPort = event.port ?? ctx.selectedPort
      const logical: LogicalMonitorState =
        ctx.desired === 'stopped' && resolvedPort
          ? { kind: 'paused', port: resolvedPort, reason: 'user' }
          : resolvedPort
            ? { kind: 'active', port: resolvedPort }
            : ctx.logical
      return {
        ...ctx,
        logical,
        lastCompletedAttemptId:
          event.attemptId ?? ctx.currentAttemptId ?? ctx.lastCompletedAttemptId,
        currentAttemptId: null,
        lastError: undefined,
      }
    }
    case 'OPEN_FAIL': {
      if (
        ctx.currentAttemptId &&
        event.attemptId &&
        event.attemptId !== ctx.currentAttemptId
      ) {
        return ctx
      }
      return {
        ...ctx,
        logical: {
          kind: 'error',
          port: event.port ?? ctx.selectedPort,
          error: event.error,
          resumable: ctx.desired === 'running',
        },
        lastError: event.error,
        lastCompletedAttemptId:
          event.attemptId ?? ctx.currentAttemptId ?? ctx.lastCompletedAttemptId,
        currentAttemptId: null,
      }
    }
    case 'STREAM_CLOSED': {
      if (ctx.desired === 'running' && ctx.selectedPort) {
        return {
          ...ctx,
          logical: {
            kind: 'waitingForPort',
            reason: 'port-temporarily-missing',
            port: ctx.selectedPort,
          },
          currentAttemptId: null,
        }
      }
      if (ctx.desired === 'stopped' && ctx.selectedPort) {
        return {
          ...ctx,
          logical: {
            kind: 'paused',
            port: ctx.selectedPort,
            reason: 'user',
          },
          currentAttemptId: null,
        }
      }
      return {
        ...ctx,
        logical: ctx.selectedPort
          ? { kind: 'paused', port: ctx.selectedPort, reason: 'suspend' }
          : { kind: 'idle' },
        currentAttemptId: null,
      }
    }
    case 'BRIDGE_DISCONNECTED': {
      const error = { kind: 'bridgeDisconnected' as const }
      return {
        ...ctx,
        logical: {
          kind: 'error',
          port: ctx.selectedPort,
          error,
          resumable: true,
        },
        lastError: error,
        currentAttemptId: null,
      }
    }
    case 'BAUDRATE_CHANGED':
      return ctx
    default:
      return ctx
  }
}

function nextAttemptId(ctx: MonitorContext, provided: number | undefined) {
  if (typeof provided === 'number' && Number.isFinite(provided)) {
    return provided
  }
  const last = ctx.lastCompletedAttemptId ?? 0
  return last + 1
}

function alignWithDesired(
  ctx: MonitorContext,
  detectedOverride?: boolean
): MonitorContext {
  const selectedPort = ctx.selectedPort
  const detected =
    typeof detectedOverride === 'boolean'
      ? detectedOverride
      : (ctx.selectedDetected ?? false)

  if (ctx.desired !== 'running') {
    return {
      ...ctx,
      logical: selectedPort
        ? { kind: 'paused', port: selectedPort, reason: 'user' }
        : { kind: 'idle' },
      currentAttemptId: null,
    }
  }

  if (!selectedPort) {
    return {
      ...ctx,
      logical: { kind: 'waitingForPort', reason: 'no-port-selected' },
      currentAttemptId: null,
    }
  }

  if (!detected) {
    return {
      ...ctx,
      logical: {
        kind: 'waitingForPort',
        reason: 'waiting-for-detection',
        port: selectedPort,
      },
      currentAttemptId: ctx.currentAttemptId,
    }
  }

  return {
    ...ctx,
    logical: { kind: 'connecting', port: selectedPort },
    currentAttemptId: ctx.currentAttemptId,
  }
}

function isSamePort(a: PortIdentifier, b: PortIdentifier): boolean {
  return createPortKey(a) === createPortKey(b)
}

function isSamePortOrUndefined(
  a: PortIdentifier | undefined,
  b: PortIdentifier | undefined
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return isSamePort(a, b)
}

function errorsEqual(a?: MonitorError, b?: MonitorError): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.kind === b.kind && (a as any).detail === (b as any).detail
}

function logicalEqual(
  a: LogicalMonitorState,
  b: LogicalMonitorState
): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'idle':
    case 'closed':
      return true
    case 'waitingForPort':
      return (
        b.kind === 'waitingForPort' &&
        a.reason === b.reason &&
        isSamePortOrUndefined(a.port, b.port)
      )
    case 'connecting':
    case 'active':
      return b.kind === a.kind && isSamePort(a.port, (b as any).port)
    case 'paused':
      return (
        b.kind === 'paused' &&
        a.reason === b.reason &&
        isSamePort(a.port, b.port)
      )
    case 'error':
      return (
        b.kind === 'error' &&
        isSamePortOrUndefined(a.port, b.port) &&
        errorsEqual(a.error, b.error) &&
        a.resumable === b.resumable
      )
    default:
      return false
  }
}

function contextsEqual(a: MonitorContext, b: MonitorContext): boolean {
  return (
    a.desired === b.desired &&
    a.currentAttemptId === b.currentAttemptId &&
    a.lastCompletedAttemptId === b.lastCompletedAttemptId &&
    a.selectedDetected === b.selectedDetected &&
    isSamePortOrUndefined(a.selectedPort, b.selectedPort) &&
    logicalEqual(a.logical, b.logical) &&
    errorsEqual(a.lastError, b.lastError)
  )
}

type Listener = (args: { portKey: string; context: MonitorContext }) => void

/**
 * Tracks FSM contexts by port key based on bridge physical state updates.
 * Consumers can subscribe to changes; no VS Code dependencies.
 */
export class MonitorLogicalTracker {
  private readonly contexts = new Map<string, MonitorContext>()
  private readonly listeners = new Set<Listener>()

  onDidChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): ReadonlyArray<{ portKey: string; context: MonitorContext }> {
    return Array.from(this.contexts.entries()).map(([portKey, context]) => ({
      portKey,
      context,
    }))
  }

  applyEvent(
    event: MonitorEvent,
    portOverride?: PortIdentifier
  ): MonitorContext | undefined {
    const portInEvent = 'port' in event ? (event as any).port : undefined
    const port = portInEvent ?? portOverride

    let key: string | undefined
    let previous: MonitorContext | undefined

    if (port) {
      key = createPortKey(port)
      previous = this.contexts.get(key)
    } else if (this.contexts.size === 1) {
      const first = this.contexts.entries().next().value
      if (first) {
        const [existingKey, ctx] = first
        key = existingKey
        previous = ctx
      }
    } else {
      return undefined
    }

    const resolvedKey = key ?? (port ? createPortKey(port) : undefined)
    if (!resolvedKey) return undefined
    const next = reduceMonitorContext(
      previous ?? initialMonitorContext(),
      event
    )
    if (!previous || !contextsEqual(previous, next)) {
      this.contexts.set(resolvedKey, next)
      this.emit({ portKey: resolvedKey, context: next })
    }
    return previous && contextsEqual(previous, next) ? previous : next
  }

  applyPhysicalState(state: MonitorPhysicalState): MonitorContext | undefined {
    const events = fromPhysicalState(state)
    if (!events.length) return undefined
    let ctx: MonitorContext | undefined
    for (const evt of events) {
      ctx = this.applyEvent(evt, state.port)
    }
    return ctx
  }

  /**
   * Update detection snapshot, emitting PORT_DETECTED/PORT_LOST for tracked
   * ports so logical state can advance to active/connecting instead of staying
   * paused.
   */
  applyDetectionSnapshot(detectedPorts: DetectedPorts | undefined): void {
    const detectedKeys = new Set(
      Object.values(detectedPorts ?? {}).map(({ port }) => createPortKey(port))
    )
    for (const [, context] of this.contexts.entries()) {
      const selected = context.selectedPort
      if (!selected) continue
      const key = createPortKey(selected)
      if (context.logical.kind === 'active' && detectedKeys.has(key)) {
        continue
      }
      if (detectedKeys.has(key)) {
        this.applyEvent({ type: 'PORT_DETECTED', port: selected })
      } else {
        this.applyEvent({ type: 'PORT_LOST', port: selected })
      }
    }
  }

  private emit(payload: { portKey: string; context: MonitorContext }) {
    this.listeners.forEach((listener) => {
      try {
        listener(payload)
      } catch {
        // ignore listener errors to keep tracker robust
      }
    })
  }
}

export function fromPhysicalState(state: MonitorPhysicalState): MonitorEvent[] {
  /** @type {MonitorEvent[]} */
  const events: MonitorEvent[] = []
  switch (state.state) {
    case 'STARTING':
      events.push({ type: 'PORT_SELECTED', port: state.port, detected: true })
      events.push({ type: 'USER_START', port: state.port })
      events.push({
        type: 'OPEN_REQUESTED',
        port: state.port,
        attemptId: state.attemptId,
      })
      events.push({ type: 'PORT_DETECTED', port: state.port })
      break
    case 'STARTED':
      // Seed desired:running and align attempt correlation
      events.push({ type: 'PORT_SELECTED', port: state.port, detected: true })
      events.push({ type: 'USER_START', port: state.port })
      events.push({
        type: 'OPEN_REQUESTED',
        port: state.port,
        attemptId: state.attemptId,
      })
      events.push({ type: 'PORT_DETECTED', port: state.port })
      events.push({
        type: 'OPEN_OK',
        port: state.port,
        attemptId: state.attemptId,
      })
      break
    case 'STOPPED':
      events.push({ type: 'USER_STOP', port: state.port })
      events.push({ type: 'PORT_SELECTED', port: state.port, detected: true })
      events.push({ type: 'PORT_DETECTED', port: state.port })
      events.push({
        type: 'STREAM_CLOSED',
        port: state.port,
        attemptId: state.attemptId,
      })
      break
    case 'FAILED':
      events.push({
        type: 'OPEN_FAIL',
        port: state.port,
        attemptId: state.attemptId,
        error: { kind: 'internal', detail: state.error },
      })
      break
    default:
      break
  }
  return events
}
