import { act, render, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { notifyError } from '@boardlab/base'
import { useSerialMonitorConnection } from '@boardlab/monitor-shared'

vi.mock('@boardlab/base', () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  vscode: {
    messenger: {
      sendNotification: vi.fn(),
    },
  },
}))

const SERIAL_PORT = {
  protocol: 'serial',
  address: '/dev/mock0',
}

const noop = () => {}

const MONITOR_SETTINGS = {
  protocols: {
    serial: {
      settings: [
        {
          settingId: 'baudrate',
          value: '9600',
          enumValues: ['9600', '115200'],
        },
      ],
    },
  },
}

/** @param {AbortSignal} signal */
function createBlockingReader(signal) {
  let aborted = signal?.aborted ?? false

  const waitForAbort = () =>
    new Promise((resolve) => {
      if (!signal) {
        resolve({ value: undefined, done: true })
        return
      }
      if (aborted) {
        resolve({ value: undefined, done: true })
        return
      }
      const onAbort = () => {
        aborted = true
        signal.removeEventListener('abort', onAbort)
        resolve({ value: undefined, done: true })
      }
      signal.addEventListener('abort', onAbort)
    })

  return {
    read: vi.fn(() => waitForAbort()),
    releaseLock: vi.fn(),
  }
}

function createControlledReader() {
  let resolveRead
  const read = vi.fn(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve
      })
  )
  return {
    reader: {
      read,
      releaseLock: vi.fn(),
    },
    stop: () => resolveRead?.({ value: undefined, done: true }),
  }
}

function TestHarness({ client, detectedPorts, autoPlay }) {
  useSerialMonitorConnection({
    client,
    selectedPort: SERIAL_PORT,
    detectedPorts,
    selectedBaudrate: '9600',
    monitorSettingsByProtocol: MONITOR_SETTINGS,
    onText: noop,
    onStart: noop,
    onStop: noop,
    onBusy: noop,
    options: { coldStartMs: 0, disconnectHoldMs: 0 },
    enabled: true,
    autoPlay,
  })
  return null
}

const StatefulHarness = forwardRef(
  ({ client, initialAutoPlay = true }, ref) => {
    const [detectedPorts, setDetectedPorts] = useState({})
    const [autoPlay, setAutoPlay] = useState(initialAutoPlay)

    const controls = useSerialMonitorConnection({
      client,
      selectedPort: SERIAL_PORT,
      detectedPorts,
      selectedBaudrate: '9600',
      monitorSettingsByProtocol: MONITOR_SETTINGS,
      onText: noop,
      onStart: noop,
      onStop: noop,
      onBusy: noop,
      options: { coldStartMs: 0, disconnectHoldMs: 0 },
      enabled: true,
      autoPlay,
    })

    useImperativeHandle(ref, () => ({
      setDetectedPorts,
      setAutoPlay,
      play: controls.play,
      stop: controls.stop,
    }))

    return (
      <TestHarness
        client={client}
        detectedPorts={detectedPorts}
        autoPlay={autoPlay}
      />
    )
  }
)
StatefulHarness.displayName = 'StatefulHarness'

const SingleHarness = forwardRef(({ client, initialAutoPlay = true }, ref) => {
  const [detectedPorts, setDetectedPorts] = useState({})
  const [autoPlay, setAutoPlay] = useState(initialAutoPlay)
  const [machine, setMachine] = useState()

  const controls = useSerialMonitorConnection({
    client,
    selectedPort: SERIAL_PORT,
    detectedPorts,
    selectedBaudrate: '9600',
    monitorSettingsByProtocol: MONITOR_SETTINGS,
    onText: noop,
    onStart: noop,
    onStop: noop,
    onBusy: noop,
    options: { coldStartMs: 0, disconnectHoldMs: 0 },
    enabled: true,
    autoPlay,
    machine,
  })

  useImperativeHandle(ref, () => ({
    setDetectedPorts,
    setAutoPlay,
    setMachine,
    play: controls.play,
    stop: controls.stop,
  }))

  return null
})
SingleHarness.displayName = 'SingleHarness'

const BaudrateHarness = forwardRef(({ client }, ref) => {
  const [detectedPorts, setDetectedPorts] = useState({})
  const [selectedBaudrate, setSelectedBaudrate] = useState('9600')

  useSerialMonitorConnection({
    client,
    selectedPort: SERIAL_PORT,
    detectedPorts,
    selectedBaudrate,
    monitorSettingsByProtocol: MONITOR_SETTINGS,
    onText: noop,
    onStart: noop,
    onStop: noop,
    onBusy: noop,
    options: { coldStartMs: 0, disconnectHoldMs: 0 },
    enabled: true,
    autoPlay: true,
  })

  useImperativeHandle(ref, () => ({
    setDetectedPorts,
    setSelectedBaudrate,
  }))

  return null
})
BaudrateHarness.displayName = 'BaudrateHarness'

describe('useSerialMonitorConnection', () => {
  beforeEach(() => {
    notifyError.mockClear()
  })

  it('play() triggers a single start from a stopped state', async () => {
    const openMonitor = vi.fn((_, { signal }) =>
      Promise.resolve(createBlockingReader(signal))
    )
    const client = { openMonitor }

    const detectedPortsWithDevice = {
      '/dev/mock0': { port: { ...SERIAL_PORT } },
    }

    const controls = {
      current: /**
       * @type {null | {
       *   setDetectedPorts: (ports: any) => void
       *   play: () => void
       * }}
       */ (null),
    }

    render(
      <StatefulHarness
        client={client}
        initialAutoPlay={false}
        ref={(value) => {
          controls.current = value
        }}
      />
    )

    act(() => {
      controls.current?.setDetectedPorts(detectedPortsWithDevice)
    })

    expect(openMonitor).not.toHaveBeenCalled()

    act(() => {
      controls.current?.play()
    })

    await waitFor(() => expect(openMonitor).toHaveBeenCalledTimes(1))

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(openMonitor).toHaveBeenCalledTimes(1)
  })

  it('notifies when the monitor fails to open', async () => {
    const openMonitor = vi.fn(() => Promise.reject(new Error('Port busted')))
    const client = { openMonitor }

    const detectedPortsWithDevice = {
      '/dev/mock0': { port: { ...SERIAL_PORT } },
    }

    const controls = {
      current:
        /** @type {null | { setDetectedPorts: (ports: any) => void }} */ (null),
    }

    render(
      <SingleHarness
        client={client}
        ref={(value) => {
          controls.current = value
        }}
      />
    )

    act(() => {
      controls.current?.setDetectedPorts(detectedPortsWithDevice)
    })

    await waitFor(() => expect(openMonitor).toHaveBeenCalled())
    await waitFor(() => expect(notifyError).toHaveBeenCalledWith('Port busted'))
  })

  it('reconnects when the device disappears and reappears', async () => {
    let controller
    const openMonitor = vi.fn(() => {
      controller = createControlledReader()
      return Promise.resolve(controller.reader)
    })
    const client = { openMonitor }

    const detectedPortsWithDevice = {
      '/dev/mock0': { port: { ...SERIAL_PORT } },
    }

    const controls = {
      current:
        /** @type {null | { setDetectedPorts: (ports: any) => void }} */ (null),
    }

    render(
      <StatefulHarness
        client={client}
        ref={(value) => {
          controls.current = value
        }}
      />
    )

    act(() => {
      controls.current?.setDetectedPorts(detectedPortsWithDevice)
    })

    await waitFor(() => expect(openMonitor).toHaveBeenCalled())
    await waitFor(() => expect(controller.reader.read).toHaveBeenCalled())
    const initialCalls = openMonitor.mock.calls.length

    act(() => {
      controls.current?.setDetectedPorts({})
    })
    await act(async () => {})

    act(() => {
      controller.stop()
    })

    act(() => {
      controls.current?.setDetectedPorts(detectedPortsWithDevice)
    })

    await waitFor(() =>
      expect(openMonitor.mock.calls.length).toBeGreaterThan(initialCalls)
    )
  })

  it('keeps the stream alive when baudrate changes while connected', async () => {
    const openMonitor = vi.fn((_, { signal }) =>
      Promise.resolve(createBlockingReader(signal))
    )
    const client = { openMonitor }

    const controls = {
      current: /**
       * @type {null | {
       *   setDetectedPorts: (ports: any) => void
       *   setSelectedBaudrate: (baud: string) => void
       * }}
       */ (null),
    }

    render(
      <BaudrateHarness
        client={client}
        ref={(value) => {
          controls.current = value
        }}
      />
    )

    act(() => {
      controls.current?.setDetectedPorts({
        '/dev/mock0': { port: { ...SERIAL_PORT } },
      })
    })

    await waitFor(() => expect(openMonitor).toHaveBeenCalledTimes(1))
    const initialCalls = openMonitor.mock.calls.length

    act(() => {
      controls.current?.setSelectedBaudrate('115200')
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(openMonitor.mock.calls.length).toBe(initialCalls)
  })

  it('does not start while suspended (paused: suspend)', async () => {
    const openMonitor = vi.fn()
    const client = { openMonitor }
    const detectedPortsWithDevice = {
      '/dev/mock0': { port: { ...SERIAL_PORT } },
    }

    const controls = {
      current: /**
       * @type {null | {
       *   setDetectedPorts: (ports: any) => void
       *   setMachine: (m: any) => void
       * }}
       */ (null),
    }

    render(
      <SingleHarness
        client={client}
        ref={(value) => {
          controls.current = value
        }}
      />
    )

    act(() => {
      controls.current?.setMachine({
        logical: { kind: 'paused', port: SERIAL_PORT, reason: 'suspend' },
        desired: 'running',
        currentAttemptId: null,
        lastCompletedAttemptId: 1,
        selectedPort: SERIAL_PORT,
        selectedDetected: true,
      })
      controls.current?.setDetectedPorts(detectedPortsWithDevice)
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(openMonitor).not.toHaveBeenCalled()

    act(() => {
      controls.current?.setMachine({
        logical: { kind: 'connecting', port: SERIAL_PORT },
        desired: 'running',
        currentAttemptId: null,
        lastCompletedAttemptId: 1,
        selectedPort: SERIAL_PORT,
        selectedDetected: true,
      })
    })

    await waitFor(() => expect(openMonitor).toHaveBeenCalledTimes(1))
  })
})
