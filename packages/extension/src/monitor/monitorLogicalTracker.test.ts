import { createPortKey } from 'boards-list'
import { describe, expect, it } from 'vitest'

import {
  MonitorLogicalTracker,
  initialMonitorContext,
  reduceMonitorContext,
} from './monitorLogicalTracker'

const PORT = { protocol: 'serial', address: '/dev/mock0' }

describe('monitorLogicalTracker', () => {
  it('maps physical state to logical events with attempt correlation', () => {
    const tracker = new MonitorLogicalTracker()
    const changes: number[] = []
    tracker.onDidChange(({ context }) => {
      if (context.currentAttemptId !== null) {
        changes.push(context.currentAttemptId)
      }
      if (context.lastCompletedAttemptId !== null) {
        changes.push(context.lastCompletedAttemptId)
      }
    })

    tracker.applyPhysicalState({
      port: PORT,
      state: 'STARTING',
      attemptId: 1,
    })
    // STARTED should seed USER_START + OPEN_REQUESTED + OPEN_OK
    tracker.applyPhysicalState({
      port: PORT,
      state: 'STARTED',
      attemptId: 1,
    })
    tracker.applyPhysicalState({
      port: PORT,
      state: 'STOPPED',
      attemptId: 1,
    })

    const snapshot = tracker.snapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.context.desired).toBe('running')
    expect(snapshot[0]?.context.logical.kind).toBe('waitingForPort')
    expect(snapshot[0]?.context.lastCompletedAttemptId).toBe(1)
    expect(changes.every((id) => id === 1)).toBe(true)
    expect(changes.length).toBeGreaterThanOrEqual(4)
  })

  it('can start again after stop when detection stays true', () => {
    const tracker = new MonitorLogicalTracker()
    tracker.applyPhysicalState({
      port: PORT,
      state: 'STARTED',
      attemptId: 1,
    })
    tracker.applyPhysicalState({
      port: PORT,
      state: 'STOPPED',
      attemptId: 1,
    })
    tracker.applyDetectionSnapshot({
      [createPortKey(PORT)]: {
        port: {
          ...PORT,
          label: '',
          protocolLabel: '',
          properties: {},
          hardwareId: '',
        },
      },
    })
    tracker.applyEvent({ type: 'USER_START' })
    const ctx = tracker.snapshot()[0]?.context
    expect(ctx?.selectedDetected).toBe(true)
    expect(ctx?.logical.kind).toBe('connecting')
  })

  it('ignores unknown physical states', () => {
    const tracker = new MonitorLogicalTracker()
    const result = tracker.applyPhysicalState({
      port: PORT,
      state: 'CREATED',
    })
    expect(result).toBeUndefined()
    expect(tracker.snapshot()).toHaveLength(0)
  })
})

describe('applyDetectionSnapshot', () => {
  it('updates selectedDetected for tracked ports', () => {
    const tracker = new MonitorLogicalTracker()
    tracker.applyEvent({
      type: 'PORT_SELECTED',
      port: PORT,
      detected: false,
    })
    tracker.applyEvent({ type: 'USER_START' })
    const detectedPort = {
      port: {
        ...PORT,
        label: '',
        protocolLabel: '',
        properties: {},
        hardwareId: '',
      },
    }
    tracker.applyDetectionSnapshot({
      [createPortKey(PORT)]: detectedPort,
    })
    const ctx = tracker.snapshot()[0]?.context
    expect(ctx?.selectedDetected).toBe(true)
    expect(ctx?.logical.kind).toBe('connecting')
  })
})

describe('reduceMonitorContext', () => {
  it('ignores stale OPEN_OK attempts', () => {
    const ctx = reduceMonitorContext(initialMonitorContext(), {
      type: 'OPEN_REQUESTED',
      port: PORT,
      attemptId: 2,
    })
    const stale = reduceMonitorContext(ctx, {
      type: 'OPEN_OK',
      port: PORT,
      attemptId: 1,
    })
    const fresh = reduceMonitorContext(ctx, {
      type: 'OPEN_OK',
      port: PORT,
      attemptId: 2,
    })
    expect(stale.lastCompletedAttemptId).toBeNull()
    expect(fresh.lastCompletedAttemptId).toBe(2)
  })

  it('transitions to error on OPEN_FAIL', () => {
    const ctx = reduceMonitorContext(initialMonitorContext(), {
      type: 'OPEN_REQUESTED',
      port: PORT,
      attemptId: 1,
    })
    const failed = reduceMonitorContext(ctx, {
      type: 'OPEN_FAIL',
      port: PORT,
      attemptId: 1,
      error: { kind: 'internal', detail: 'boom' },
    })
    expect(failed.logical.kind).toBe('error')
    expect(failed.lastError).toEqual({ kind: 'internal', detail: 'boom' })
  })
})

describe('deduplication', () => {
  it('does not emit duplicate contexts for identical events', () => {
    const tracker = new MonitorLogicalTracker()
    const changes: string[] = []
    tracker.onDidChange(({ context }) => {
      changes.push(context.logical.kind)
    })

    tracker.applyEvent({ type: 'PORT_SELECTED', port: PORT, detected: true })
    tracker.applyEvent({ type: 'PORT_SELECTED', port: PORT, detected: true })

    expect(changes).toHaveLength(1)
  })
})
