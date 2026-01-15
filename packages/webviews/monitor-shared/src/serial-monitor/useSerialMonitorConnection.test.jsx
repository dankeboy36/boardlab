import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useSerialMonitorConnection } from './useSerialMonitorConnection.js'

vi.mock('@boardlab/base', () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  vscode: {
    messenger: {
      sendNotification: vi.fn(),
    },
  },
}))

const noop = () => {}

function makeClient({ openMonitorImpl }) {
  return {
    openMonitor: openMonitorImpl,
    detectedPorts: vi.fn(),
    updateBaudrate: vi.fn(),
    sendMonitorMessage: vi.fn(),
  }
}

const serialPort = {
  protocol: 'serial',
  address: '/dev/cu.usbserial-0001',
}

const detectedPorts = {
  'port+serial:///dev/cu.usbserial-0001': { port: serialPort },
}

const monitorSettingsByProtocol = {
  protocols: {
    serial: { settings: [] },
  },
}

describe('useSerialMonitorConnection', () => {
  it('ignores duplicate attach responses', async () => {
    const openMonitor = vi.fn().mockRejectedValue(
      Object.assign(new Error('already attached'), {
        code: 'already-attached',
      })
    )
    const client = makeClient({ openMonitorImpl: openMonitor })

    const { result } = renderHook(
      (props) => useSerialMonitorConnection(props),
      {
        wrapper: ({ children }) => <>{children}</>,
        initialProps: {
          client,
          selectedPort: serialPort,
          detectedPorts,
          monitorSettingsByProtocol,
          onText: noop,
          onStart: noop,
          onStop: noop,
          onBusy: noop,
          options: { autoplay: true },
          enabled: true,
          autoPlay: true,
          selectedBaudrate: '9600',
        },
      }
    )

    act(() => {
      result.current.play()
    })

    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(1)
    })
  })

  it('retries after a 502 once the device is detected again', async () => {
    const never = new Promise(() => {})
    const openMonitor = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('bad gateway'), { status: 502 })
      )
      .mockResolvedValue({
        read: vi.fn().mockReturnValue(never),
      })

    const client = makeClient({ openMonitorImpl: openMonitor })

    const { rerender, result } = renderHook(
      (props) => useSerialMonitorConnection(props),
      {
        wrapper: ({ children }) => <>{children}</>,
        initialProps: {
          client,
          selectedPort: serialPort,
          detectedPorts,
          monitorSettingsByProtocol,
          onText: noop,
          onStart: noop,
          onStop: noop,
          onBusy: noop,
          options: { autoplay: true },
          enabled: true,
          autoPlay: true,
          selectedBaudrate: '9600',
        },
      }
    )

    act(() => {
      result.current.play()
    })
    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(1)
    })

    rerender({
      client,
      selectedPort: serialPort,
      detectedPorts: {},
      monitorSettingsByProtocol,
      onText: noop,
      onStart: noop,
      onStop: noop,
      onBusy: noop,
      options: { autoplay: true },
      enabled: true,
      autoPlay: true,
      selectedBaudrate: '9600',
    })
    rerender({
      client,
      selectedPort: serialPort,
      detectedPorts,
      monitorSettingsByProtocol,
      onText: noop,
      onStart: noop,
      onStop: noop,
      onBusy: noop,
      options: { autoplay: true },
      enabled: true,
      autoPlay: true,
      selectedBaudrate: '9600',
    })

    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(2)
    })
  })
})
