// @ts-check
import { describe, expect, it } from 'vitest'

import {
  initialMonitorContext,
  reduceMonitorContext,
} from '@boardlab/monitor-shared/serial-monitor/monitorFsm.js'

const PORT = { protocol: 'serial', address: '/dev/mock0' }

describe('monitorFsm', () => {
  it('keeps paused(user) after a manual stop when the stream closes', () => {
    let ctx = initialMonitorContext()
    ctx = reduceMonitorContext(ctx, {
      type: 'PORT_SELECTED',
      port: PORT,
      detected: true,
    })
    ctx = reduceMonitorContext(ctx, { type: 'USER_START' })
    ctx = reduceMonitorContext(ctx, {
      type: 'OPEN_OK',
      port: PORT,
      attemptId: 1,
    })
    ctx = reduceMonitorContext(ctx, { type: 'USER_STOP' })

    const afterClose = reduceMonitorContext(ctx, {
      type: 'STREAM_CLOSED',
      port: PORT,
      attemptId: 1,
    })

    expect(afterClose.desired).toBe('stopped')
    expect(afterClose.logical.kind).toBe('paused')
    expect(afterClose.logical.reason).toBe('user')
  })
})
