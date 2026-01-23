// @ts-check
import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MonitorProvider,
  useMonitorStream,
} from '@boardlab/monitor-shared/serial-monitor'
import serialMonitorReducer from '@boardlab/monitor-shared/serial-monitor/serialMonitorSlice'

const streamMetrics = {
  startCalls: 0,
  stopCalls: 0,
}

vi.mock(
  '@boardlab/monitor-shared/serial-monitor/useSerialMonitorConnection',
  () => {
    return {
      useSerialMonitorConnection: ({ onStart, onStop, onText }) => {
        return {
          play() {
            streamMetrics.startCalls += 1
            onStart?.()
            onText?.('input line 1\n')
            onText?.('line 2\n')
          },
          stop() {
            streamMetrics.stopCalls += 1
            onStop?.()
          },
        }
      },
    }
  }
)

const PORT = { protocol: 'serial', address: '/dev/tty.test' }

function createFakeExtensionClient(
  selection = { port: PORT, baudrate: '9600' }
) {
  const listeners = new Set()
  return {
    onSelectionChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async getMonitorSelection() {
      return selection
    },
    triggerSelection(nextSelection = selection) {
      for (const listener of Array.from(listeners)) {
        listener(nextSelection)
      }
    },
    dispose() {
      listeners.clear()
    },
  }
}

function createStubClient() {
  const noopDisposable = { dispose: () => {} }
  return {
    connect: vi.fn().mockResolvedValue({
      detectedPorts: {},
      monitorSettingsByProtocol: { protocols: {} },
      selectedBaudrates: [],
      physicalStates: [],
      sessionStates: [],
    }),
    detectedPorts: vi.fn().mockResolvedValue({}),
    physicalStates: vi.fn().mockResolvedValue([]),
    sessionStates: vi.fn().mockResolvedValue([]),
    onDidChangeDetectedPorts: () => noopDisposable,
    onDidChangeMonitorSettings: () => noopDisposable,
    onDidChangeBaudrate: () => noopDisposable,
    onDidChangePhysicalState: () => noopDisposable,
    onDidChangeSessionState: () => noopDisposable,
    openMonitor: vi.fn(),
    updateBaudrate: vi.fn().mockResolvedValue(),
    sendMonitorMessage: vi.fn().mockResolvedValue(),
    notifyClientAttached: vi.fn(),
    notifyClientDetached: vi.fn(),
    notifyIntentStart: vi.fn(),
    notifyIntentStop: vi.fn(),
    notifyIntentResume: vi.fn(),
    notifyOpenError: vi.fn(),
  }
}

function OutputCollector() {
  const [text, setText] = useState('')
  useMonitorStream({
    onText(chunk) {
      setText((prev) => prev + chunk)
    },
  })
  return <div data-testid="monitor-output">{text}</div>
}

describe('MonitorProvider integration', () => {
  beforeEach(() => {
    streamMetrics.startCalls = 0
    streamMetrics.stopCalls = 0
  })

  it('prints monitor input after selection', async () => {
    const store = configureStore({
      reducer: {
        serialMonitor: serialMonitorReducer,
      },
    })
    const extensionClient = createFakeExtensionClient()
    const client = createStubClient()

    render(
      <Provider store={store}>
        <MonitorProvider client={client} extensionClient={extensionClient}>
          <OutputCollector />
        </MonitorProvider>
      </Provider>
    )

    await waitFor(() => {
      const output = screen.getByTestId('monitor-output')
      expect(output).toHaveTextContent('input line 1')
      expect(output).toHaveTextContent('line 2')
    })
  })

  it('does not restart when duplicate notifications arrive', async () => {
    const store = configureStore({
      reducer: {
        serialMonitor: serialMonitorReducer,
      },
    })
    const extensionClient = createFakeExtensionClient()
    const client = createStubClient()

    render(
      <Provider store={store}>
        <MonitorProvider client={client} extensionClient={extensionClient}>
          <OutputCollector />
        </MonitorProvider>
      </Provider>
    )

    await waitFor(() => {
      const output = screen.getByTestId('monitor-output')
      expect(output).toHaveTextContent('input line 1')
      expect(output).toHaveTextContent('line 2')
      expect(streamMetrics.startCalls).toBe(1)
    })

    extensionClient.triggerSelection()
    extensionClient.triggerSelection({})

    await waitFor(() => {
      expect(streamMetrics.startCalls).toBe(1)
    })
  })
})
