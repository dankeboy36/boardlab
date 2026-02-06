// @ts-check
import { describe, expect, it } from 'vitest'
import { createPortKey } from 'boards-list'

import {
  projectMonitorView,
  selectMonitorView,
} from '@boardlab/monitor-shared/serial-monitor/serialMonitorSelectors'

const PORT = { protocol: 'serial', address: '/dev/tty.usbmock-1' }

function baseState(overrides) {
  return {
    serialMonitor: {
      detectedPorts: {},
      supportedBaudrates: [],
      monitorSettingsByProtocol: { protocols: {} },
      selectedPort: PORT,
      selectedBaudrates: [[PORT, '9600']],
      boardsListItems: [],
      boardsListPorts: [],
      autoPlay: true,
      physicalStates: [],
      sessionStates: {},
      ...overrides,
    },
  }
}

describe('serialMonitorSelectors', () => {
  it('marks status suspended when paused for missing device while running', () => {
    const state = baseState({
      sessionStates: {
        [createPortKey(PORT)]: {
          portKey: createPortKey(PORT),
          port: PORT,
          status: 'paused',
          desired: 'running',
          detected: false,
          clients: [],
          openPending: false,
          closePending: false,
          currentAttemptId: null,
          lastCompletedAttemptId: 1,
          pauseReason: 'resource-missing',
        },
      },
    })
    const view = selectMonitorView(state)
    expect(view.status).toBe('suspended')
    expect(view.started).toBe(true)
  })

  it('marks status suspended when desired running but port is not detected', () => {
    const state = baseState({
      detectedPorts: {},
      sessionStates: {
        [createPortKey(PORT)]: {
          portKey: createPortKey(PORT),
          port: PORT,
          status: 'idle',
          desired: 'running',
          detected: false,
          clients: [],
          openPending: false,
          closePending: false,
          currentAttemptId: null,
          lastCompletedAttemptId: null,
        },
      },
    })
    const view = projectMonitorView(state.serialMonitor)
    expect(view.status).toBe('suspended')
  })
})
