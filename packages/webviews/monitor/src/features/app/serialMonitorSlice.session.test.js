// @ts-check
import { describe, expect, it } from 'vitest'
import { createPortKey } from 'boards-list'

import reducer, {
  upsertSessionState,
} from '@boardlab/monitor-shared/serial-monitor/serialMonitorSlice'

const PORT = { protocol: 'serial', address: '/dev/mock0' }

describe('serialMonitorSlice session state', () => {
  it('stores session state keyed by portKey', () => {
    const base = reducer(undefined, { type: '@@INIT' })
    const payload = {
      portKey: createPortKey(PORT),
      port: PORT,
      status: 'active',
      desired: 'running',
      detected: true,
      clients: [],
      openPending: false,
      closePending: false,
      currentAttemptId: null,
      lastCompletedAttemptId: 1,
    }
    const next = reducer(base, upsertSessionState(payload))
    expect(next.sessionStates[createPortKey(PORT)]).toEqual(payload)
  })
})
