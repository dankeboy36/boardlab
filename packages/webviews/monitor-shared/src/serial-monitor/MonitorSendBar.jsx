// @ts-check
import { createPortKey } from 'boards-list'
import { useEffect, useState } from 'react'
import { useSelector } from 'react-redux'
import { VscodeIcon } from 'vscode-react-elements-x'

import { vscode } from '@boardlab/base'
import { notifyMonitorToolbarAction } from '@boardlab/protocol'

import MonitorPlayStopButton from './MonitorPlayStopButton.jsx'
import { useMonitorController } from './MonitorProvider.jsx'
import SendPanel from './SendPanel.jsx'
import { selectSerialMonitor } from './serialMonitorSelectors.js'

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
  const { play, stop } = useMonitorController()

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) return
    messenger.onNotification(notifyMonitorToolbarAction, ({ action }) => {
      if (action === 'play') {
        play()
      } else if (action === 'stop') {
        stop()
      }
    })
  }, [play, stop])

  const selectedPort = serialState.selectedPort
  const selectedKey = selectedPort ? createPortKey(selectedPort) : undefined
  const hasDetectionSnapshot =
    Object.keys(serialState.detectedPorts ?? {}).length > 0
  const selectedDetected = selectedKey
    ? Object.values(serialState.detectedPorts).some(
        (p) => createPortKey(p.port) === selectedKey
      )
    : false
  const canControl = Boolean(
    selectedPort &&
      (!hasDetectionSnapshot || selectedDetected || serialState.started)
  )

  const selectedBaudrate = (() => {
    if (!selectedKey) return undefined
    const found = serialState.selectedBaudrates.find(
      ([port]) => createPortKey(port) === selectedKey
    )
    return found?.[1]
  })()

  const [showSuspended, setShowSuspended] = useState(false)
  useEffect(() => {
    if (serialState.status === 'suspended') {
      const handle = setTimeout(() => setShowSuspended(true), 350)
      return () => {
        clearTimeout(handle)
      }
    }
    setShowSuspended(false)
    return undefined
  }, [serialState.status])

  const isSuspended =
    showSuspended &&
    serialState.started &&
    serialState.status === 'suspended' &&
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

  const status = serialState.status
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
    sendDisabled = true
  }

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
          started={serialState.started}
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
