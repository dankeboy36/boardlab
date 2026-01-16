// @ts-check

import { createPortKey } from 'boards-list'

/**
 * @typedef {'no-port-selected'
 *   | 'waiting-for-detection'
 *   | 'port-temporarily-missing'} WaitingReason
 *
 *
 * @typedef {'user' | 'suspend' | 'resource-busy' | 'resource-missing'} PauseReason
 *
 *
 * @typedef {{ kind: 'busy'; detail?: string }
 *   | { kind: 'gone'; detail?: string }
 *   | { kind: 'bridgeDisconnected'; detail?: string }
 *   | { kind: 'internal'; detail?: string }} MonitorError
 *
 *
 * @typedef {import('boards-list').PortIdentifier} PortIdentifier
 *
 * @typedef {{
 *       kind: 'idle'
 *     }
 *   | {
 *       kind: 'waitingForPort'
 *       reason: WaitingReason
 *       port?: PortIdentifier
 *     }
 *   | {
 *       kind: 'connecting'
 *       port: PortIdentifier
 *     }
 *   | {
 *       kind: 'active'
 *       port: PortIdentifier
 *     }
 *   | {
 *       kind: 'paused'
 *       port: PortIdentifier
 *       reason: PauseReason
 *     }
 *   | {
 *       kind: 'error'
 *       port: PortIdentifier | undefined
 *       error: MonitorError
 *       resumable: boolean
 *     }
 *   | {
 *       kind: 'closed'
 *     }} LogicalMonitorState
 *
 *
 * @typedef {'running' | 'stopped'} DesiredState
 *
 * @typedef {{
 *   logical: LogicalMonitorState
 *   desired: DesiredState
 *   currentAttemptId: number | null
 *   lastCompletedAttemptId: number | null
 *   selectedPort?: PortIdentifier
 *   selectedDetected?: boolean
 *   lastError?: MonitorError
 * }} MonitorContext
 *
 *
 * @typedef {{
 *       type: 'RESET'
 *     }
 *   | {
 *       type: 'PORT_SELECTED'
 *       port?: PortIdentifier
 *       detected?: boolean
 *     }
 *   | {
 *       type: 'PORT_DETECTED'
 *       port: PortIdentifier
 *     }
 *   | {
 *       type: 'PORT_LOST'
 *       port: PortIdentifier
 *     }
 *   | {
 *       type: 'USER_START'
 *     }
 *   | {
 *       type: 'USER_STOP'
 *     }
 *   | {
 *       type: 'OPEN_REQUESTED'
 *       port?: PortIdentifier
 *       attemptId?: number
 *     }
 *   | {
 *       type: 'OPEN_OK'
 *       port?: PortIdentifier
 *       attemptId?: number
 *     }
 *   | {
 *       type: 'OPEN_FAIL'
 *       port?: PortIdentifier
 *       attemptId?: number
 *       error: MonitorError
 *     }
 *   | {
 *       type: 'STREAM_CLOSED'
 *       port?: PortIdentifier
 *       attemptId?: number
 *     }
 *   | {
 *       type: 'BRIDGE_DISCONNECTED'
 *     }
 *   | {
 *       type: 'BAUDRATE_CHANGED'
 *       port?: PortIdentifier
 *     }} MonitorEvent
 */

/** @returns {MonitorContext} */
const emptyContext = () => ({
  logical: { kind: 'idle' },
  desired: 'stopped',
  currentAttemptId: null,
  lastCompletedAttemptId: null,
  selectedPort: undefined,
  selectedDetected: false,
  lastError: undefined,
})

/** @returns {MonitorContext} */
export function initialMonitorContext() {
  return emptyContext()
}

/**
 * Reducer for the logical monitor FSM. Events are intentionally high-level
 * (user intent + observed bridge outcomes) so webviews can replay scenarios
 * deterministically in tests.
 *
 * @param {MonitorContext | undefined} state
 * @param {MonitorEvent} event
 * @returns {MonitorContext}
 */
export function reduceMonitorContext(state, event) {
  /** @type {MonitorContext} */
  const ctx = state ?? emptyContext()
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
        desired: /** @type {const} */ ('running'),
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
      const logical =
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
      return {
        ...ctx,
        logical: ctx.selectedPort
          ? { kind: 'paused', port: ctx.selectedPort, reason: 'user' }
          : { kind: 'idle' },
        currentAttemptId: null,
      }
    }
    case 'BRIDGE_DISCONNECTED': {
      const error = { kind: 'bridgeDisconnected' }
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

/** @param {MonitorContext} ctx @param {number | undefined} provided */
function nextAttemptId(ctx, provided) {
  if (typeof provided === 'number' && Number.isFinite(provided)) {
    return provided
  }
  const last = ctx.lastCompletedAttemptId ?? 0
  return last + 1
}

/**
 * @param {MonitorContext} ctx
 * @param {boolean | undefined} [detectedOverride]
 */
function alignWithDesired(ctx, detectedOverride = undefined) {
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
      currentAttemptId: null,
    }
  }

  return {
    ...ctx,
    logical: { kind: 'connecting', port: selectedPort },
  }
}

/** @param {PortIdentifier} a @param {PortIdentifier} b */
function isSamePort(a, b) {
  return createPortKey(a) === createPortKey(b)
}
