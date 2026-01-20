import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useSerialMonitorConnection } from './useSerialMonitorConnection.js'
import { reduceMonitorContext } from './monitorFsm.js'

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

const neverReader = {
  // Keep stream open so the hook does not attempt reconnection churn during the test
  read: vi.fn().mockImplementation(() => new Promise(() => {})),
}

function createAbortableReader(signal) {
  return {
    read: vi.fn(
      () =>
        new Promise((resolve) => {
          if (!signal || signal.aborted) {
            resolve({ value: undefined, done: true })
            return
          }
          const onAbort = () => {
            signal.removeEventListener('abort', onAbort)
            resolve({ value: undefined, done: true })
          }
          signal.addEventListener('abort', onAbort)
        })
    ),
  }
}

describe('useSerialMonitorConnection', () => {
  it('nudges host from stopped/paused when device is detected, then starts once host runs', async () => {
    const openMonitor = vi.fn().mockResolvedValue(neverReader)
    const client = makeClient({ openMonitorImpl: openMonitor })
    let machine = {
      logical: { kind: 'paused', reason: 'user', port: serialPort },
      desired: 'stopped',
      selectedPort: serialPort,
      selectedDetected: true,
    }
    const dispatchEvent = vi.fn((event) => {
      machine = reduceMonitorContext(machine, event)
    })

    const { rerender } = renderHook(
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
          machine,
          dispatchEvent,
        },
      }
    )

    await waitFor(() => {
      expect(
        dispatchEvent.mock.calls.some(
          ([evt]) => evt?.type === 'USER_START' && evt.port === serialPort
        )
      ).toBe(true)
    })
    expect(openMonitor).toHaveBeenCalledTimes(0)

    machine = {
      ...machine,
      desired: 'running',
      logical: { kind: 'connecting', port: serialPort },
    }
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
      machine,
      dispatchEvent,
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
      machine,
      dispatchEvent,
    })

    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(1)
    })
  })

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

  it('clears stale pending/abort flags when the device reappears', async () => {
    const openMonitor = vi.fn().mockResolvedValue(neverReader)
    const client = makeClient({ openMonitorImpl: openMonitor })
    const debugRefs = { current: undefined }

    const { rerender } = renderHook(
      (props) => useSerialMonitorConnection(props),
      {
        wrapper: ({ children }) => <>{children}</>,
        initialProps: {
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
          debugRefs,
        },
      }
    )

    // Simulate a stuck state: pending start with an aborted controller
    act(() => {
      const { abortRef, pendingStartRef } = debugRefs.current
      abortRef.current = { signal: { aborted: true } }
      pendingStartRef.current = true
    })

    // Device appears -> should clear stale flags and connect
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
      debugRefs,
    })

    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps an existing stream alive across host logical updates', async () => {
    const openMonitor = vi.fn().mockResolvedValue(neverReader)
    const client = makeClient({ openMonitorImpl: openMonitor })
    let machine = {
      logical: { kind: 'connecting', port: serialPort },
      desired: 'running',
      selectedPort: serialPort,
      selectedDetected: true,
    }
    const dispatchEvent = vi.fn((event) => {
      machine = reduceMonitorContext(machine, event)
    })

    const { rerender } = renderHook(
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
          machine,
          dispatchEvent,
        },
      }
    )

    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(1)
    })

    machine = {
      ...machine,
      logical: { kind: 'active', port: serialPort },
      desired: 'running',
    }

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
      machine,
      dispatchEvent,
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(openMonitor).toHaveBeenCalledTimes(1)
  })

  it('lets a fresh editor auto-play after another editor stopped, without restarting the stopper', async () => {
    const openMonitorA = vi.fn().mockResolvedValue(neverReader)
    const openMonitorB = vi.fn().mockResolvedValue(neverReader)
    const clientA = makeClient({ openMonitorImpl: openMonitorA })
    const clientB = makeClient({ openMonitorImpl: openMonitorB })

    let machine = {
      logical: { kind: 'idle', port: serialPort },
      desired: 'stopped',
      selectedPort: serialPort,
      selectedDetected: true,
    }
    const dispatchEvent = vi.fn((event) => {
      machine = reduceMonitorContext(machine, event)
    })

    const { rerender: rerenderA, result: resultA } = renderHook(
      (props) => useSerialMonitorConnection(props),
      {
        wrapper: ({ children }) => <>{children}</>,
        initialProps: {
          client: clientA,
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
          machine,
          dispatchEvent,
        },
      }
    )

    await waitFor(() => {
      expect(
        dispatchEvent.mock.calls.some(
          ([evt]) => evt?.type === 'USER_START' && evt.port === serialPort
        )
      ).toBe(true)
    })
    expect(openMonitorA).toHaveBeenCalledTimes(0)

    machine = {
      ...machine,
      desired: 'running',
      logical: { kind: 'connecting', port: serialPort },
    }
    rerenderA({
      client: clientA,
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
      machine,
      dispatchEvent,
    })

    await waitFor(() => {
      expect(openMonitorA).toHaveBeenCalledTimes(1)
    })

    // User explicitly stops in editor A
    await act(async () => {
      resultA.current.stop()
    })

    // Host reflects paused/user + stopped
    machine = {
      ...machine,
      desired: 'stopped',
      logical: { kind: 'paused', reason: 'user', port: serialPort },
    }
    rerenderA({
      client: clientA,
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
      machine,
      dispatchEvent,
    })

    // Editor B mounts fresh with autoPlay:true
    const { rerender: rerenderB } = renderHook(
      (props) => useSerialMonitorConnection(props),
      {
        wrapper: ({ children }) => <>{children}</>,
        initialProps: {
          client: clientB,
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
          machine,
          dispatchEvent,
        },
      }
    )

    await waitFor(() => {
      expect(
        dispatchEvent.mock.calls.some(
          ([evt]) =>
            evt?.type === 'USER_START' &&
            evt.port === serialPort &&
            machine.desired === 'running'
        )
      ).toBe(true)
    })

    rerenderB({
      client: clientB,
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
      machine: {
        ...machine,
        desired: 'running',
        logical: { kind: 'connecting', port: serialPort },
      },
      dispatchEvent,
    })

    await waitFor(() => {
      expect(openMonitorB).toHaveBeenCalledTimes(1)
    })
    expect(openMonitorA).toHaveBeenCalledTimes(1)
  })

  it('attaches to an active host session without a start token', async () => {
    const openMonitor = vi.fn().mockResolvedValue(neverReader)
    const client = makeClient({ openMonitorImpl: openMonitor })
    const debugRefs = { current: undefined }
    const machine = {
      logical: { kind: 'active', port: serialPort },
      desired: 'running',
      selectedPort: serialPort,
      selectedDetected: true,
    }

    const { rerender } = renderHook(
      (props) => useSerialMonitorConnection(props),
      {
        wrapper: ({ children }) => <>{children}</>,
        initialProps: {
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
          machine,
          debugRefs,
        },
      }
    )

    act(() => {
      const refs = debugRefs.current
      refs.startTokenRef.current = 0
      refs.lastStartedTokenRef.current = 0
      refs.attachedRef.current = false
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
      machine,
      debugRefs,
    })

    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(debugRefs.current.attachedRef.current).toBe(true)
    })
  })

  it('reattaches both editors after a device reconnect while host is active', async () => {
    const openMonitorA = vi.fn().mockResolvedValue(neverReader)
    const openMonitorB = vi.fn().mockResolvedValue(neverReader)
    const clientA = makeClient({ openMonitorImpl: openMonitorA })
    const clientB = makeClient({ openMonitorImpl: openMonitorB })
    const debugRefsA = { current: undefined }
    const debugRefsB = { current: undefined }
    const machine = {
      logical: { kind: 'active', port: serialPort },
      desired: 'running',
      selectedPort: serialPort,
      selectedDetected: true,
    }

    const { rerender: rerenderA } = renderHook(
      (props) => useSerialMonitorConnection(props),
      {
        wrapper: ({ children }) => <>{children}</>,
        initialProps: {
          client: clientA,
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
          machine,
          debugRefs: debugRefsA,
        },
      }
    )

    const { rerender: rerenderB } = renderHook(
      (props) => useSerialMonitorConnection(props),
      {
        wrapper: ({ children }) => <>{children}</>,
        initialProps: {
          client: clientB,
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
          machine,
          debugRefs: debugRefsB,
        },
      }
    )

    act(() => {
      const refsA = debugRefsA.current
      const refsB = debugRefsB.current
      refsA.startTokenRef.current = 0
      refsA.lastStartedTokenRef.current = 0
      refsA.attachedRef.current = false
      refsB.startTokenRef.current = 0
      refsB.lastStartedTokenRef.current = 0
      refsB.attachedRef.current = false
    })

    rerenderA({
      client: clientA,
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
      machine,
      debugRefs: debugRefsA,
    })

    rerenderB({
      client: clientB,
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
      machine,
      debugRefs: debugRefsB,
    })

    await waitFor(() => {
      expect(openMonitorA).toHaveBeenCalledTimes(1)
      expect(openMonitorB).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(debugRefsA.current.attachedRef.current).toBe(true)
      expect(debugRefsB.current.attachedRef.current).toBe(true)
    })
  })

  it('does not auto-restart after stop when the device reappears', async () => {
    const openMonitor = vi.fn((_, { signal }) =>
      Promise.resolve(createAbortableReader(signal))
    )
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

    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(1)
    })

    act(() => {
      result.current.stop()
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

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(openMonitor).toHaveBeenCalledTimes(1)
  })

  it('plays once when autoPlay is disabled without turning autoPlay on', async () => {
    const singleRead = { value: undefined, done: true }
    const openMonitor = vi
      .fn()
      .mockResolvedValue({ read: vi.fn().mockResolvedValue(singleRead) })
    const client = makeClient({ openMonitorImpl: openMonitor })
    const debugRefs = { current: undefined }

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
          options: { autoplay: false },
          enabled: true,
          autoPlay: false,
          selectedBaudrate: '9600',
          debugRefs,
        },
      }
    )

    await act(async () => {
      result.current.play()
    })

    await waitFor(() => {
      expect(openMonitor).toHaveBeenCalledTimes(1)
    })
    expect(debugRefs.current.autoplayRef.current).toBe(false)

    // Device disappears then reappears: should not auto-start again because autoPlay is still false
    rerender({
      client,
      selectedPort: serialPort,
      detectedPorts: {},
      monitorSettingsByProtocol,
      onText: noop,
      onStart: noop,
      onStop: noop,
      onBusy: noop,
      options: { autoplay: false },
      enabled: true,
      autoPlay: false,
      selectedBaudrate: '9600',
      debugRefs,
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
      options: { autoplay: false },
      enabled: true,
      autoPlay: false,
      selectedBaudrate: '9600',
      debugRefs,
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(openMonitor).toHaveBeenCalledTimes(1)
  })
})
