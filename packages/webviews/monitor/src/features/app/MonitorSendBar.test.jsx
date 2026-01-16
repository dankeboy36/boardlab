// @ts-check
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { createPortKey } from 'boards-list'
import { describe, expect, it, vi } from 'vitest'

import MonitorSendBar from '@boardlab/monitor-shared/serial-monitor/MonitorSendBar'
import serialMonitorReducer from '@boardlab/monitor-shared/serial-monitor/serialMonitorSlice'

const PORT = {
  protocol: 'serial',
  address: '/dev/tty.usbmock-1',
}

function withSerialMonitorState(stateOverrides = {}) {
  const baseState = serialMonitorReducer(undefined, { type: '@@INIT' })
  const store = configureStore({
    reducer: {
      serialMonitor: serialMonitorReducer,
    },
    preloadedState: {
      serialMonitor: {
        ...baseState,
        ...stateOverrides,
      },
    },
  })

  return render(
    <Provider store={store}>
      <MonitorSendBar lineEnding="lf" />
    </Provider>
  )
}

/** @param {Element} element */
function pointerEventsOf(element) {
  return window.getComputedStyle(element).pointerEvents
}

describe('MonitorSendBar', () => {
  it('disables controls when device is missing', () => {
    withSerialMonitorState({
      selectedPort: PORT,
      selectedBaudrates: [[PORT, '9600']],
      detectedPorts: {},
      started: false,
      status: 'idle',
    })

    const startIcon = screen.getByTitle('Start (open monitor)')
    expect(pointerEventsOf(startIcon)).toBe('none')

    const textarea = screen.getByPlaceholderText(
      `No device detected on ${PORT.address}`
    )
    expect(textarea).toHaveAttribute(
      'placeholder',
      `No device detected on ${PORT.address}`
    )

    const sendIcon = screen.getByTitle(/Select a port first/)
    expect(pointerEventsOf(sendIcon)).toBe('none')
  })

  it('shows detected-but-not-started state', () => {
    const detectedPorts = {
      [createPortKey(PORT)]: { port: PORT },
    }
    withSerialMonitorState({
      selectedPort: PORT,
      selectedBaudrates: [[PORT, '9600']],
      detectedPorts,
      started: false,
      status: 'idle',
    })

    const startIcon = screen.getByTitle('Start (open monitor)')
    expect(pointerEventsOf(startIcon)).not.toBe('none')

    const textarea = screen.getByPlaceholderText(
      `Start the monitor on ${PORT.address} to send messages`
    )
    expect(textarea).toHaveAttribute(
      'placeholder',
      `Start the monitor on ${PORT.address} to send messages`
    )
    expect(pointerEventsOf(screen.getByTitle(/Select a port first/))).toBe(
      'none'
    )
  })

  it('activates the textarea once streaming', () => {
    const detectedPorts = {
      [createPortKey(PORT)]: { port: PORT },
    }
    withSerialMonitorState({
      selectedPort: PORT,
      selectedBaudrates: [[PORT, '9600']],
      detectedPorts,
      machine: {
        logical: { kind: 'active', port: PORT },
        desired: 'running',
        currentAttemptId: null,
        lastCompletedAttemptId: 1,
        selectedPort: PORT,
        selectedDetected: true,
      },
    })

    const textarea = screen.getByPlaceholderText(
      /Message \(Enter to send; append LF/
    )
    expect(textarea).not.toBeDisabled()
    const sendIcon = screen.getByTitle(/Select a port first|Send/)
    expect(pointerEventsOf(sendIcon)).toBe('none')

    Object.defineProperty(textarea, 'value', {
      value: 'hello',
      writable: true,
    })
    fireEvent.input(textarea)
    expect(pointerEventsOf(sendIcon)).not.toBe('none')
  })

  it('shows suspended UI while started and waiting for device', () => {
    vi.useFakeTimers()
    const detectedPorts = {
      [createPortKey(PORT)]: { port: PORT },
    }
    withSerialMonitorState({
      detectedPorts,
      selectedPort: PORT,
      selectedBaudrates: [[PORT, '9600']],
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
      suspendedPortKeys: [createPortKey(PORT)],
    })

    // const textarea = screen.getByPlaceholderText(/waiting for device/)
    const sendIcon = screen.getByTitle(/Select a port first|Send/)
    expect(pointerEventsOf(sendIcon)).toBe('none')

    act(() => {
      vi.advanceTimersByTime(400)
    })
    const spinner = screen.getByTitle('Port suspended')
    expect(spinner).toBeInTheDocument()
  })
})
