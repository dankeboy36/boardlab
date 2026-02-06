import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useSerialMonitorConnection } from './useSerialMonitorConnection.js'

vi.mock('@boardlab/base', () => ({
  vscode: { messenger: undefined },
}))

const PORT = { protocol: 'serial', address: '/dev/mock0' }

const MONITOR_SETTINGS = {
  protocols: {
    serial: { settings: [] },
  },
}

const neverReader = {
  read: vi.fn().mockImplementation(() => new Promise(() => {})),
}

function makeClient(openMonitorImpl) {
  return {
    openMonitor: openMonitorImpl,
    notifyIntentStart: vi.fn(),
    notifyIntentStop: vi.fn(),
    notifyOpenError: vi.fn(),
  }
}

function makeSession(overrides = {}) {
  return {
    portKey: `port+serial://${PORT.address}`,
    port: PORT,
    status: 'connecting',
    desired: 'running',
    detected: true,
    clients: [],
    openPending: true,
    closePending: false,
    currentAttemptId: 1,
    lastCompletedAttemptId: null,
    ...overrides,
  }
}

describe('useSerialMonitorConnection', () => {
  it('opens when host marks openPending for a new attempt', async () => {
    const openMonitor = vi.fn().mockResolvedValue(neverReader)
    const client = makeClient(openMonitor)

    renderHook(() =>
      useSerialMonitorConnection({
        client,
        selectedPort: PORT,
        selectedBaudrate: '9600',
        monitorSettingsByProtocol: MONITOR_SETTINGS,
        session: makeSession(),
        onText: vi.fn(),
        onStart: vi.fn(),
        onStop: vi.fn(),
        onBusy: vi.fn(),
      })
    )

    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(1)
    })
  })

  it('attaches when host reports active session without openPending', async () => {
    const openMonitor = vi.fn().mockResolvedValue(neverReader)
    const client = makeClient(openMonitor)

    renderHook(() =>
      useSerialMonitorConnection({
        client,
        selectedPort: PORT,
        selectedBaudrate: '9600',
        monitorSettingsByProtocol: MONITOR_SETTINGS,
        session: makeSession({
          status: 'active',
          openPending: false,
          currentAttemptId: null,
        }),
        onText: vi.fn(),
        onStart: vi.fn(),
        onStop: vi.fn(),
        onBusy: vi.fn(),
      })
    )

    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(1)
    })
  })

  it('notifies host on port-busy errors', async () => {
    const error = Object.assign(new Error('busy'), { status: 423 })
    const openMonitor = vi.fn().mockRejectedValue(error)
    const onBusy = vi.fn()
    const client = makeClient(openMonitor)

    renderHook(() =>
      useSerialMonitorConnection({
        client,
        selectedPort: PORT,
        selectedBaudrate: '9600',
        monitorSettingsByProtocol: MONITOR_SETTINGS,
        session: makeSession(),
        onText: vi.fn(),
        onStart: vi.fn(),
        onStop: vi.fn(),
        onBusy,
      })
    )

    await waitFor(() => {
      expect(client.notifyOpenError).toHaveBeenCalledWith(
        expect.objectContaining({
          port: PORT,
          status: 423,
        })
      )
      expect(onBusy).toHaveBeenCalled()
    })
  })

  it('does not restart an in-flight open when session updates', async () => {
    const openMonitor = vi.fn().mockImplementation(
      () =>
        new Promise(() => {
          // never resolves
        })
    )
    const client = makeClient(openMonitor)
    const baseProps = {
      client,
      selectedPort: PORT,
      selectedBaudrate: '9600',
      monitorSettingsByProtocol: MONITOR_SETTINGS,
      onText: vi.fn(),
      onStart: vi.fn(),
      onStop: vi.fn(),
      onBusy: vi.fn(),
    }

    const { rerender } = renderHook(
      (props) => useSerialMonitorConnection(props),
      {
        initialProps: {
          ...baseProps,
          session: makeSession(),
        },
      }
    )

    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(1)
    })

    rerender({
      ...baseProps,
      session: makeSession({
        status: 'active',
        openPending: false,
        currentAttemptId: null,
      }),
    })

    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(1)
    })
  })

  it('re-issues intent start when detected and session is missing', async () => {
    const openMonitor = vi.fn().mockResolvedValue(neverReader)
    const client = makeClient(openMonitor)

    const { rerender } = renderHook(
      (props) => useSerialMonitorConnection(props),
      {
        initialProps: {
          client,
          selectedPort: PORT,
          selectedBaudrate: '9600',
          selectedDetected: true,
          monitorSettingsByProtocol: MONITOR_SETTINGS,
          session: undefined,
          onText: vi.fn(),
          onStart: vi.fn(),
          onStop: vi.fn(),
          onBusy: vi.fn(),
        },
      }
    )

    await waitFor(() => {
      expect(client.notifyIntentStart).toHaveBeenCalledTimes(1)
    })

    rerender({
      client,
      selectedPort: PORT,
      selectedBaudrate: '9600',
      selectedDetected: true,
      monitorSettingsByProtocol: MONITOR_SETTINGS,
      session: undefined,
      onText: vi.fn(),
      onStart: vi.fn(),
      onStop: vi.fn(),
      onBusy: vi.fn(),
    })

    await waitFor(() => {
      expect(client.notifyIntentStart).toHaveBeenCalledTimes(1)
    })

    rerender({
      client,
      selectedPort: PORT,
      selectedBaudrate: '9600',
      selectedDetected: false,
      monitorSettingsByProtocol: MONITOR_SETTINGS,
      session: undefined,
      onText: vi.fn(),
      onStart: vi.fn(),
      onStop: vi.fn(),
      onBusy: vi.fn(),
    })

    rerender({
      client,
      selectedPort: PORT,
      selectedBaudrate: '9600',
      selectedDetected: true,
      monitorSettingsByProtocol: MONITOR_SETTINGS,
      session: undefined,
      onText: vi.fn(),
      onStart: vi.fn(),
      onStop: vi.fn(),
      onBusy: vi.fn(),
    })

    await waitFor(() => {
      expect(client.notifyIntentStart).toHaveBeenCalledTimes(2)
    })
  })

  it('re-issues intent start when session desired is stopped while auto-play is on', async () => {
    const openMonitor = vi.fn().mockResolvedValue(neverReader)
    const client = makeClient(openMonitor)

    renderHook(() =>
      useSerialMonitorConnection({
        client,
        selectedPort: PORT,
        selectedBaudrate: '9600',
        selectedDetected: true,
        monitorSettingsByProtocol: MONITOR_SETTINGS,
        session: makeSession({
          desired: 'stopped',
          status: 'idle',
          openPending: false,
          currentAttemptId: null,
        }),
        onText: vi.fn(),
        onStart: vi.fn(),
        onStop: vi.fn(),
        onBusy: vi.fn(),
      })
    )

    await waitFor(() => {
      expect(client.notifyIntentStart).toHaveBeenCalledTimes(1)
    })
  })
})
