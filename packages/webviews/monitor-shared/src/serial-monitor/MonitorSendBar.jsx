// @ts-check
import { createPortKey } from 'boards-list'
import { useEffect, useState } from 'react'
import { useSelector } from 'react-redux'
import { VscodeIcon } from 'vscode-react-elements-x'

import MonitorPlayStopButton from './MonitorPlayStopButton.jsx'
import { useMonitorController } from './MonitorProvider.jsx'
import SendPanel from './SendPanel.jsx'
import {
  selectMonitorView,
  selectSerialMonitor,
} from './serialMonitorSelectors.js'
import { emitWebviewTraceEvent } from './trace.js'

/**
 * Combined play/stop and send row with connection summary.
 *
 * @param {{
 *   client?: import('./client.js').MonitorClient
 *   lineEnding: 'none' | 'lf' | 'cr' | 'crlf'
 * }} props
 */
function MonitorSendBar({ client, lineEnding }) {
  const serialState = useSelector(selectSerialMonitor)
  const monitorView = useSelector(selectMonitorView)
  const { play, stop } = useMonitorController()

  const selectedPort = serialState.selectedPort
  const selectedKey = selectedPort ? createPortKey(selectedPort) : undefined
  const hasDetectionSnapshot = monitorView.hasDetectionSnapshot
  const selectedDetected = monitorView.selectedDetected
  // const hasDetection = hasDetectionSnapshot && selectedDetected
  // Allow manual start whenever a port is selected; do not over-block on
  // detection snapshots to keep play enabled after manual stops.
  const canControl = Boolean(selectedPort)

  const selectedBaudrate = (() => {
    if (!selectedKey) return undefined
    const found = serialState.selectedBaudrates.find(
      ([port]) => createPortKey(port) === selectedKey
    )
    return found?.[1]
  })()

  const [showSuspended, setShowSuspended] = useState(false)
  useEffect(() => {
    if (monitorView.status === 'suspended') {
      const handle = setTimeout(() => setShowSuspended(true), 350)
      return () => {
        clearTimeout(handle)
      }
    }
    setShowSuspended(false)
    return undefined
  }, [monitorView.status])

  const isSuspended =
    showSuspended &&
    monitorView.started &&
    monitorView.status === 'suspended' &&
    selectedKey &&
    (serialState.suspendedPortKeys ?? []).some((key) => key === selectedKey)

  const lineEndingDescription = (() => {
    switch (lineEnding) {
      case 'lf':
        return 'LF'
      case 'cr':
        return 'CR'
      case 'crlf':
        return 'CRLF'
      default:
        return 'nothing'
    }
  })()

  let sendPlaceholder = selectedPort
    ? `Message (Enter to send; append ${lineEndingDescription}, ${selectedPort.address}, baudrate: ${selectedBaudrate})`
    : 'Select a port to send'

  let sendDisabled = !selectedPort
  let playDisabled = !canControl

  const status = monitorView.status
  const detected = selectedKey
    ? Object.values(serialState.detectedPorts ?? {}).some(
        (p) => createPortKey(p.port) === selectedKey
      )
    : false

  if (!selectedPort) {
    sendPlaceholder = 'Select a port to send'
    playDisabled = true
    sendDisabled = true
  } else if (status === 'suspended') {
    sendPlaceholder = `${sendPlaceholder} — waiting for device…`
    playDisabled = true
    sendDisabled = true
  } else if (!detected) {
    sendPlaceholder = `No device detected on ${selectedPort.address}`
    playDisabled = true
    sendDisabled = true
  } else if (status !== 'connected') {
    sendPlaceholder = `Start the monitor on ${selectedPort.address} to send messages`
    // Leave play enabled; only block sending until a connection is active.
    sendDisabled = true
  }

  // Emit a lightweight trace when control state changes to help diagnose
  // disabled start/play issues.
  const lastTraceRef = useState(() => ({ current: '' }))[0]
  useEffect(() => {
    const payload = {
      portKey: selectedKey,
      status,
      started: monitorView.started,
      hasDetectionSnapshot,
      selectedDetected,
      canControl,
      playDisabled,
      sendDisabled,
    }
    const signature = JSON.stringify(payload)
    if (signature !== lastTraceRef.current) {
      lastTraceRef.current = signature
      emitWebviewTraceEvent('webviewMonitorControls', payload)
    }
  }, [
    selectedKey,
    status,
    monitorView.started,
    hasDetectionSnapshot,
    selectedDetected,
    canControl,
    playDisabled,
    sendDisabled,
    lastTraceRef,
  ])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: 4,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
        }}
      >
        <MonitorPlayStopButton
          started={monitorView.started}
          canControl={!playDisabled}
          onPlay={() => play()}
          onStop={() => stop()}
        />
        {isSuspended && (
          <VscodeIcon
            name="loading"
            spin
            title="Port suspended"
            style={{ opacity: 0.8 }}
          />
        )}
        <SendPanel
          disabled={sendDisabled}
          lineEnding={lineEnding}
          placeholder={sendPlaceholder}
          onSend={(message) => {
            if (!client || !selectedPort) return
            client.sendMonitorMessage({
              port: selectedPort,
              message,
            })
          }}
        />
      </div>
    </div>
  )
}

export default MonitorSendBar
