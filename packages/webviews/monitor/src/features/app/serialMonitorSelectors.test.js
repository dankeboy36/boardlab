// @ts-check
import { describe, expect, it } from 'vitest'

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
      started: false,
      status: 'idle',
      boardsListItems: [],
      boardsListPorts: [],
      suspendedPortKeys: [],
      autoPlay: true,
      machine: {
        logical: { kind: 'idle' },
        desired: 'stopped',
        currentAttemptId: null,
        lastCompletedAttemptId: null,
        selectedPort: PORT,
        selectedDetected: true,
      },
      physicalStates: [],
      ...overrides,
    },
  }
}

describe('serialMonitorSelectors', () => {
  it('marks status suspended when waiting for port while running', () => {
    const state = baseState({
      machine: {
        logical: {
          kind: 'waitingForPort',
          reason: 'port-temporarily-missing',
          port: PORT,
        },
        desired: 'running',
        currentAttemptId: null,
        lastCompletedAttemptId: 1,
        selectedPort: PORT,
        selectedDetected: true,
      },
    })
    const view = selectMonitorView(state)
    expect(view.status).toBe('suspended')
    expect(view.started).toBe(true)
  })

  it('marks status suspended when paused due to suspend reason', () => {
    const state = baseState({
      machine: {
        logical: { kind: 'paused', port: PORT, reason: 'suspend' },
        desired: 'running',
        currentAttemptId: null,
        lastCompletedAttemptId: 1,
        selectedPort: PORT,
        selectedDetected: true,
      },
    })
    const view = projectMonitorView(state.serialMonitor)
    expect(view.status).toBe('suspended')
  })
})
