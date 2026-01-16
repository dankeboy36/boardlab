// @ts-check
import { describe, expect, it } from 'vitest'

import reducer, {
  pauseMonitor,
} from '@boardlab/monitor-shared/serial-monitor/serialMonitorSlice'

const PORT = { protocol: 'serial', address: '/dev/mock0' }

describe('serialMonitorSlice suspension', () => {
  it('marks FSM as paused(suspend) while keeping desired running', () => {
    const base = reducer(undefined, { type: '@@INIT' })
    const pre = {
      ...base,
      selectedPort: PORT,
      machine: {
        logical: { kind: 'active', port: PORT },
        desired: 'running',
        currentAttemptId: null,
        lastCompletedAttemptId: 1,
        selectedPort: PORT,
        selectedDetected: true,
      },
    }

    const next = reducer(
      pre,
      pauseMonitor({
        port: PORT,
      })
    )

    expect(next.machine.logical).toEqual({
      kind: 'paused',
      port: PORT,
      reason: 'suspend',
    })
    expect(next.machine.desired).toBe('running')
  })
})
