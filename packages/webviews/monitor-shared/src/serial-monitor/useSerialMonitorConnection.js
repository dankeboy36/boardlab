// @ts-check

import { useCallback, useEffect, useRef, useState } from 'react'

import { notifyError, notifyInfo } from '@boardlab/base'

import { emitWebviewTraceEvent } from './trace.js'

const buildPortKey = (port) =>
  port ? `${port.protocol}:${port.address}` : undefined

/**
 * @typedef {Object} UseSerialMonitorConnectionOptions
 * @property {boolean} [autoplay]
 * @property {number} [disconnectHoldMs]
 * @property {number} [coldStartMs]
 */

/**
 * @typedef {Object} UseSerialMonitorConnectionResult
 * @property {() => void} play
 * @property {() => void} stop
 */

/**
 * @typedef {Object} UseSerialMonitorConnection
 * @property {import('./client.js').MonitorClient} client
 * @property {import('boards-list').PortIdentifier | undefined} selectedPort
 * @property {import('boards-list').DetectedPorts} detectedPorts
 * @property {string | undefined} selectedBaudrate
 * @property {import('@boardlab/protocol').MonitorSettingsByProtocol} monitorSettingsByProtocol
 * @property {(text: string) => void} onText
 * @property {() => void} onStart
 * @property {() => void} onStop
 * @property {() => void} onBusy // called when server indicates HTTP 423
 * @property {boolean} [enabled=true] Default is `true`
 * @property {boolean} [autoPlay=true] Default is `true`
 * @property {import('./monitorFsm.js').MonitorContext} [machine]
 * @property {(event: import('./monitorFsm.js').MonitorEvent) => void} [dispatchEvent]
 * @property {UseSerialMonitorConnectionOptions} [options]
 * @returns {UseSerialMonitorConnectionResult}
 */

/**
 * @param {UseSerialMonitorConnection} params
 * @returns {UseSerialMonitorConnectionResult}
 */
export function useSerialMonitorConnection({
  client,
  selectedPort,
  detectedPorts,
  selectedBaudrate,
  monitorSettingsByProtocol,
  onText,
  onStart,
  onStop,
  onBusy,
  options,
  enabled = true,
  autoPlay = true,
  machine,
  dispatchEvent = () => {},
}) {
  const selectedProtocol = selectedPort?.protocol
  const protocolEntry = selectedProtocol
    ? monitorSettingsByProtocol?.protocols?.[selectedProtocol]
    : undefined
  const protocolError = protocolEntry?.error
  const hasProtocolSettings = Boolean(protocolEntry)
  const requiresBaudrate = Array.isArray(protocolEntry?.settings)
    ? !!protocolEntry.settings.find((s) => s.settingId === 'baudrate')
    : false

  const autoplayRef = useRef(options?.autoplay ?? true)
  const disconnectHoldMsRef = useRef(options?.disconnectHoldMs ?? 1500)
  const coldStartMsRef = useRef(options?.coldStartMs ?? 1000)
  const selectedBaudrateRef = useRef(selectedBaudrate)

  // Keep options in sync
  useEffect(() => {
    autoplayRef.current = options?.autoplay ?? true
    disconnectHoldMsRef.current = options?.disconnectHoldMs ?? 1500
    coldStartMsRef.current = options?.coldStartMs ?? 1000
  }, [options?.autoplay, options?.disconnectHoldMs, options?.coldStartMs])

  useEffect(() => {
    selectedBaudrateRef.current = selectedBaudrate
  }, [selectedBaudrate])

  useEffect(() => {
    autoplayRef.current = autoPlay
    if (!autoPlay) {
      userStoppedRef.current = true
    }
    dispatchEvent({
      type: autoPlay ? 'USER_START' : 'USER_STOP',
    })
  }, [autoPlay])

  const userStoppedRef = useRef(false)
  const disconnectHoldRef = useRef(false)
  const disconnectAtRef = useRef(0)
  const sawAbsentRef = useRef(false)
  const wasStreamingRef = useRef(false)
  const openedAtRef = useRef(0)
  const awaitingBaudRef = useRef(false)
  const pendingStartRef = useRef(false)
  const startTokenRef = useRef(0)

  const abortRef = useRef(
    /** @type {AbortController | undefined} */ (undefined)
  )
  const seqRef = useRef(0)
  const [forceReconnect, setForceReconnect] = useState(0)

  const triggerReconnect = useCallback(
    (reason) => {
      const portKey = buildPortKey(selectedPort)
      const baudrate = selectedBaudrateRef.current
      if (abortRef.current?.signal?.aborted) {
        abortRef.current = undefined
      }
      if (abortRef.current || pendingStartRef.current) {
        console.info('[monitor] reconnect skipped', {
          reason,
          aborting: !!abortRef.current,
          pending: pendingStartRef.current,
        })
        emitWebviewTraceEvent('webviewMonitorReconnectSkipped', {
          reason,
          portKey,
          baudrate,
          aborting: !!abortRef.current,
          pending: pendingStartRef.current,
        })
        return
      }
      emitWebviewTraceEvent('webviewMonitorReconnect', {
        reason,
        portKey,
        baudrate,
      })
      setForceReconnect((prev) => prev + 1)
    },
    [selectedPort]
  )

  const selectedDetectedRef = useRef(false)
  const hasDetectionSnapshotRef = useRef(false)
  const prevDetectedRef = useRef(false)
  const forcedAbsentRef = useRef(false)
  const bridgeUnavailableRef = useRef(false)
  const machineRef = useRef(machine)
  const prevLogicalRef = useRef(machine?.logical)
  useEffect(() => {
    machineRef.current = machine
  }, [machine])

  useEffect(() => {
    const prev = prevLogicalRef.current
    const next = machine?.logical
    const wasSuspended =
      prev &&
      prev.kind === 'paused' &&
      (prev.reason === 'suspend' ||
        prev.reason === 'resource-busy' ||
        prev.reason === 'resource-missing')
    const nowSuspended =
      next &&
      next.kind === 'paused' &&
      (next.reason === 'suspend' ||
        next.reason === 'resource-busy' ||
        next.reason === 'resource-missing')
    if (wasSuspended && !nowSuspended) {
      triggerReconnect('suspend-cleared')
    }
    prevLogicalRef.current = next
  }, [machine, triggerReconnect])

  useEffect(() => {
    const ports = detectedPorts ?? {}
    const hasSnapshot = Object.keys(ports).length > 0
    const key = selectedPort
      ? `${selectedPort.protocol}:${selectedPort.address}`
      : undefined
    const isDetected = key
      ? Object.values(ports).some(
          ({ port }) => `${port.protocol}:${port.address}` === key
        )
      : false

    const portKey = buildPortKey(selectedPort)
    const prevSnapshot = hasDetectionSnapshotRef.current
    const prevDetected = prevDetectedRef.current

    hasDetectionSnapshotRef.current = hasSnapshot
    selectedDetectedRef.current = isDetected
    if (prevSnapshot !== hasSnapshot || prevDetected !== isDetected) {
      emitWebviewTraceEvent('webviewMonitorDetectionState', {
        portKey,
        hasSnapshot,
        detected: isDetected,
        prevDetected,
      })
      const evt = isDetected
        ? { type: 'PORT_DETECTED', port: selectedPort }
        : {
            type: 'PORT_LOST',
            port: selectedPort,
          }
      dispatchEvent(evt)
    }
    if (bridgeUnavailableRef.current && isDetected) {
      // Bridge previously unavailable; allow retry when the device reappears.
      bridgeUnavailableRef.current = false
      userStoppedRef.current = false
      autoplayRef.current = true
      emitWebviewTraceEvent('webviewMonitorBridgeReappear', {
        portKey,
      })
      triggerReconnect('bridge-unavailable')
      return
    }
    if (forcedAbsentRef.current && isDetected) {
      forcedAbsentRef.current = false
      emitWebviewTraceEvent('webviewMonitorForcedAbsentCleared', {
        portKey,
      })
    }

    if (!selectedPort) {
      prevDetectedRef.current = false
      forcedAbsentRef.current = false
      return
    }

    const wasDetected = prevDetectedRef.current
    if (!wasDetected && isDetected) {
      prevDetectedRef.current = isDetected
      if (!userStoppedRef.current && autoplayRef.current) {
        triggerReconnect('device-detected')
      }
    } else if (wasDetected && !isDetected) {
      sawAbsentRef.current = true
      prevDetectedRef.current = isDetected
    } else {
      prevDetectedRef.current = isDetected
    }
  }, [detectedPorts, selectedPort, triggerReconnect])

  // Expose play/stop by mutating refs (consumers can call via returned functions if needed later)
  /** Force immediate reconnect attempt, clearing holds */
  const playNow = () => {
    emitWebviewTraceEvent('webviewMonitorPlay', {
      portKey: buildPortKey(selectedPort),
      baudrate: selectedBaudrateRef.current,
      hasClient: !!client,
      userStopped: userStoppedRef.current,
    })
    dispatchEvent({ type: 'USER_START' })
    console.info('[monitor] playNow', {
      hasClient: !!client,
      selectedPort,
      autoPlay: autoplayRef.current,
      userStopped: userStoppedRef.current,
      aborting: !!abortRef.current,
    })
    userStoppedRef.current = false
    disconnectHoldRef.current = false
    sawAbsentRef.current = false
    // Temporarily enable autoplay for immediate connection
    autoplayRef.current = true
    bridgeUnavailableRef.current = false
    // Force effect re-evaluation by updating state
    triggerReconnect('play')
  }

  /** User stop: abort stream and prevent auto-reconnect */
  const stopNow = () => {
    emitWebviewTraceEvent('webviewMonitorStop', {
      portKey: buildPortKey(selectedPort),
      baudrate: selectedBaudrateRef.current,
      hasClient: !!client,
    })
    dispatchEvent({ type: 'USER_STOP' })
    console.info('[monitor] stopNow', {
      hasClient: !!client,
      selectedPort,
    })
    userStoppedRef.current = true
    disconnectHoldRef.current = false
    autoplayRef.current = false
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = undefined
    }
  }

  // Core effect: manages stream lifecycle and reconnect policy
  useEffect(() => {
    const currentBaudrate = selectedBaudrateRef.current
    // If disabled, abort any current stream and skip
    if (!enabled) {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = undefined
      }
      console.info('[monitor] effect skipped (disabled)')
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'disabled',
        portKey: buildPortKey(selectedPort),
      })
      return
    }
    if (!client || !selectedPort) {
      console.info('[monitor] effect skipped (missing client or port)', {
        hasClient: !!client,
        selectedPort,
      })
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'missing-client-or-port',
        hasClient: !!client,
        portKey: buildPortKey(selectedPort),
      })
      return
    }

    // Ensure monitor settings for this protocol are resolved first
    if (!hasProtocolSettings) {
      // Not resolved yet: do not attempt to start
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'missing-protocol-settings',
        portKey: buildPortKey(selectedPort),
      })
      return
    }
    if (protocolError) {
      // Protocol not supported for monitor
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'protocol-error',
        portKey: buildPortKey(selectedPort),
      })
      return
    }
    if (requiresBaudrate && !currentBaudrate) {
      console.info('[monitor] effect waiting for baudrate')
      awaitingBaudRef.current = true
      emitWebviewTraceEvent('webviewMonitorAwaitBaudrate', {
        portKey: buildPortKey(selectedPort),
      })
      return
    }
    awaitingBaudRef.current = false

    const hasDetectionSnapshot = hasDetectionSnapshotRef.current
    const selectedDetected = selectedDetectedRef.current
    const detected =
      hasDetectionSnapshot && selectedDetected && !forcedAbsentRef.current
    const logical = machineRef.current?.logical
    const isSuspended =
      logical &&
      logical.kind === 'paused' &&
      (logical.reason === 'suspend' ||
        logical.reason === 'resource-busy' ||
        logical.reason === 'resource-missing')
    const shouldStart =
      !userStoppedRef.current &&
      autoplayRef.current &&
      detected &&
      !abortRef.current &&
      !isSuspended

    console.info('[monitor] effect evaluate', {
      autoPlay: autoplayRef.current,
      detected,
      hasDetectionSnapshot,
      userStopped: userStoppedRef.current,
      aborting: !!abortRef.current,
      suspended: !!isSuspended,
      shouldStart,
    })
    emitWebviewTraceEvent('webviewMonitorEffectEvaluate', {
      portKey: buildPortKey(selectedPort),
      baudrate: currentBaudrate,
      autoPlay: autoplayRef.current,
      detected,
      hasDetectionSnapshot,
      userStopped: userStoppedRef.current,
      aborting: !!abortRef.current,
      shouldStart,
    })

    if (isSuspended) {
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'suspended',
        portKey: buildPortKey(selectedPort),
      })
      return
    }

    // Manage disconnect hold lifecycle
    if (disconnectHoldRef.current) {
      const now = Date.now()
      const elapsed = now - disconnectAtRef.current
      const holdExpired = elapsed >= disconnectHoldMsRef.current
      const reappeared = sawAbsentRef.current && detected
      if (!holdExpired && !reappeared) {
        emitWebviewTraceEvent('webviewMonitorHoldActive', {
          portKey: buildPortKey(selectedPort),
          elapsedMs: elapsed,
        })
        return
      }
      // Clear hold when conditions satisfied
      disconnectHoldRef.current = false
      sawAbsentRef.current = false
    }

    if (!autoplayRef.current) {
      console.info('[monitor] autoplay disabled; skipping start')
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'autoplay-disabled',
        portKey: buildPortKey(selectedPort),
      })
      return
    }

    if (!detected) {
      // Track that we saw the device absent at least once
      sawAbsentRef.current = true
      emitWebviewTraceEvent('webviewMonitorNotDetected', {
        portKey: buildPortKey(selectedPort),
      })
      return
    }

    // Do not start a second stream if one is already active. This is critical
    // during baudrate changes: we rely on RequestUpdateBaudrate to adjust the
    // existing monitor without reconnecting.
    if (abortRef.current) {
      console.info('[monitor] abort controller already set, skipping start')
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'abort-controller-set',
        portKey: buildPortKey(selectedPort),
      })
      return
    }
    // Start a new open sequence
    if (pendingStartRef.current) {
      console.info('[monitor] start pending; skipping duplicate trigger')
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'start-pending',
        portKey: buildPortKey(selectedPort),
      })
      return
    }

    const mySeq = ++seqRef.current
    const controller = new AbortController()
    abortRef.current = controller
    const signal = controller.signal
    pendingStartRef.current = true
    const startToken = ++startTokenRef.current
    dispatchEvent({
      type: 'OPEN_REQUESTED',
      port: selectedPort,
      attemptId: startToken,
    })

    // Reset stream flags
    wasStreamingRef.current = false
    openedAtRef.current = Date.now()

    const startStream = async () => {
      const startBaudrate = selectedBaudrateRef.current
      emitWebviewTraceEvent('webviewMonitorOpenStart', {
        seq: mySeq,
        startToken,
        portKey: buildPortKey(selectedPort),
        baudrate: startBaudrate,
      })
      console.info('[monitor] opening monitor', {
        seq: mySeq,
        port: selectedPort,
        baudrate: startBaudrate,
      })
      let reader
      try {
        reader = await client.openMonitor(
          { port: selectedPort, baudrate: startBaudrate },
          { signal }
        )
        emitWebviewTraceEvent('webviewMonitorOpenReady', {
          seq: mySeq,
          startToken,
          portKey: buildPortKey(selectedPort),
          baudrate: startBaudrate,
        })
        if (
          mySeq !== seqRef.current ||
          controller.signal.aborted ||
          abortRef.current !== controller
        ) {
          pendingStartRef.current = false
          return
        }
        emitWebviewTraceEvent('webviewMonitorStreamStarted', {
          seq: mySeq,
          portKey: buildPortKey(selectedPort),
        })
        dispatchEvent({
          type: 'OPEN_OK',
          port: selectedPort,
          attemptId: startToken,
        })
        onStart()
        const decoder = new TextDecoder()
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (value && value.length) {
            wasStreamingRef.current = true
            onText(decoder.decode(value, { stream: true }))
          }
        }
        if (mySeq !== seqRef.current) return
        emitWebviewTraceEvent('webviewMonitorStreamEnded', {
          seq: mySeq,
          portKey: buildPortKey(selectedPort),
          reason: 'done',
        })
        dispatchEvent({
          type: 'STREAM_CLOSED',
          port: selectedPort,
          attemptId: startToken,
        })
        onStop()
        if (abortRef.current === controller) {
          abortRef.current = undefined
        }
        pendingStartRef.current = false
        if (!userStoppedRef.current) {
          const elapsed = Date.now() - openedAtRef.current
          const detectedNow =
            selectedDetectedRef.current && !forcedAbsentRef.current
          if (!wasStreamingRef.current && elapsed < coldStartMsRef.current) {
            disconnectHoldRef.current = false
            sawAbsentRef.current = false
            triggerReconnect('cold-start-retry')
          } else if (detectedNow) {
            disconnectHoldRef.current = false
            sawAbsentRef.current = false
            triggerReconnect('detected-retry')
          } else {
            disconnectHoldRef.current = true
            disconnectAtRef.current = Date.now()
            notifyInfo('Device disconnected; waiting for reappear')
          }
        }
      } catch (err) {
        if (mySeq !== seqRef.current) return
        if (
          (err instanceof Error && err?.name === 'AbortError') ||
          controller.signal.aborted
        ) {
          emitWebviewTraceEvent('webviewMonitorStreamEnded', {
            seq: mySeq,
            portKey: buildPortKey(selectedPort),
            reason: 'aborted',
          })
          dispatchEvent({
            type: 'STREAM_CLOSED',
            port: selectedPort,
            attemptId: startToken,
          })
          onStop()
          if (abortRef.current === controller) {
            abortRef.current = undefined
          }
          pendingStartRef.current = false
          return
        }
        const message = err instanceof Error ? err?.message : String(err)
        const errorCode =
          err instanceof Error && 'code' in err ? err.code : undefined
        const errorStatus =
          err instanceof Error && 'status' in err ? err.status : undefined
        emitWebviewTraceEvent('webviewMonitorOpenError', {
          seq: mySeq,
          portKey: buildPortKey(selectedPort),
          message,
          code: errorCode,
          status: errorStatus,
        })
        dispatchEvent({
          type: 'OPEN_FAIL',
          port: selectedPort,
          attemptId: startToken,
          error: mapError(errorCode, errorStatus, message),
        })
        onStop()
        if (abortRef.current === controller) {
          abortRef.current = undefined
        }
        if (errorCode === 'already-attached') {
          emitWebviewTraceEvent('webviewMonitorErrorHandled', {
            seq: mySeq,
            portKey: buildPortKey(selectedPort),
            resolution: 'already-attached',
          })
          // Another stream for this client is already active; avoid churn.
          disconnectHoldRef.current = true
          disconnectAtRef.current = Date.now()
          sawAbsentRef.current = false
          if (abortRef.current === controller) {
            abortRef.current = undefined
          }
          pendingStartRef.current = false
          return
        }
        if (errorCode === 'port-busy' || errorStatus === 423) {
          emitWebviewTraceEvent('webviewMonitorErrorHandled', {
            seq: mySeq,
            portKey: buildPortKey(selectedPort),
            resolution: 'port-busy',
          })
          notifyError(`${selectedPort.address} port busy`)
          userStoppedRef.current = true
          onBusy()
          pendingStartRef.current = false
          return
        }
        const isMissingDevice =
          errorCode === 'port-not-detected' || errorStatus === 404
        const shouldRefreshDetection = errorCode === 'monitor-open-failed'
        const resolveDetectedNow = async () => {
          if (!client || !selectedPort || !client.detectedPorts) {
            return selectedDetectedRef.current
          }
          try {
            await new Promise((resolve) => setTimeout(resolve, 200))
            const ports = await client.detectedPorts()
            const key = `${selectedPort.protocol}:${selectedPort.address}`
            return Object.values(ports ?? {}).some(
              ({ port }) => `${port.protocol}:${port.address}` === key
            )
          } catch {
            return selectedDetectedRef.current
          }
        }
        if (isMissingDevice) {
          emitWebviewTraceEvent('webviewMonitorErrorHandled', {
            seq: mySeq,
            portKey: buildPortKey(selectedPort),
            resolution: 'missing-device',
          })
          forcedAbsentRef.current = true
          disconnectHoldRef.current = true
          disconnectAtRef.current = Date.now()
          sawAbsentRef.current = true
          if (!userStoppedRef.current) {
            notifyInfo('Device disconnected; waiting for reappear')
          }
          pendingStartRef.current = false
          return
        }
        if (errorStatus === 502) {
          emitWebviewTraceEvent('webviewMonitorErrorHandled', {
            seq: mySeq,
            portKey: buildPortKey(selectedPort),
            resolution: 'bridge-unavailable',
          })
          // Bridge returned 502 (monitor unavailable). Treat as transient and wait for reappear.
          bridgeUnavailableRef.current = true
          disconnectHoldRef.current = true
          disconnectAtRef.current = Date.now()
          sawAbsentRef.current = true
          if (!userStoppedRef.current) {
            notifyInfo('Device disconnected; waiting for reappear')
          }
          pendingStartRef.current = false
          return
        }
        if (shouldRefreshDetection) {
          emitWebviewTraceEvent('webviewMonitorErrorHandled', {
            seq: mySeq,
            portKey: buildPortKey(selectedPort),
            resolution: 'refresh-detection',
          })
          const detectedNow = await resolveDetectedNow()
          if (!detectedNow) {
            forcedAbsentRef.current = true
            disconnectHoldRef.current = true
            disconnectAtRef.current = Date.now()
            sawAbsentRef.current = true
            if (!userStoppedRef.current) {
              notifyInfo('Device disconnected; waiting for reappear')
            }
            pendingStartRef.current = false
            return
          }
        }
        if (!userStoppedRef.current) {
          notifyError(message)
        }
        emitWebviewTraceEvent('webviewMonitorErrorHandled', {
          seq: mySeq,
          portKey: buildPortKey(selectedPort),
          resolution: 'stopped',
        })
        userStoppedRef.current = true
        onBusy()
        disconnectHoldRef.current = true
        disconnectAtRef.current = Date.now()
        pendingStartRef.current = false
      }
    }

    const timer = setTimeout(() => {
      if (controller.signal.aborted || startTokenRef.current !== startToken) {
        if (abortRef.current === controller) {
          abortRef.current = undefined
        }
        pendingStartRef.current = false
        return
      }
      startStream().finally(() => {
        if (startTokenRef.current === startToken) {
          pendingStartRef.current = false
        }
      })
    }, 0)

    return () => {
      clearTimeout(timer)
      startTokenRef.current += 1
      controller.abort()
      pendingStartRef.current = false
      if (abortRef.current === controller) {
        abortRef.current = undefined
      }
      emitWebviewTraceEvent('webviewMonitorEffectCleanup', {
        seq: mySeq,
        portKey: buildPortKey(selectedPort),
      })
    }
  }, [
    client,
    selectedPort,
    hasProtocolSettings,
    protocolError,
    requiresBaudrate,
    forceReconnect,
    onBusy,
    onStart,
    onStop,
    onText,
    enabled,
    triggerReconnect,
  ])

  // If baudrate becomes available after being undefined (and required by protocol),
  // trigger a connection attempt without tearing down an existing stream.
  useEffect(() => {
    if (!client || !selectedPort) return
    if (!awaitingBaudRef.current) return
    if (!hasProtocolSettings || protocolError) return
    if (requiresBaudrate && !selectedBaudrate) return
    awaitingBaudRef.current = false
    if (!abortRef.current && !userStoppedRef.current && autoplayRef.current) {
      triggerReconnect('baudrate-ready')
    }
  }, [
    client,
    selectedPort,
    selectedBaudrate,
    hasProtocolSettings,
    protocolError,
    requiresBaudrate,
    triggerReconnect,
  ])

  // Return imperative controls for future UI buttons
  return {
    play: () => playNow(),
    stop: () => stopNow(),
  }
}

/**
 * @param {string | undefined} code
 * @param {number | undefined} status
 * @param {string | undefined} message
 * @returns {import('./monitorFsm.js').MonitorError}
 */
function mapError(code, status, message) {
  if (code === 'port-busy' || status === 423) {
    return { kind: 'busy', detail: message }
  }
  if (code === 'port-not-detected' || status === 404) {
    return { kind: 'gone', detail: message }
  }
  if (status === 502) {
    return { kind: 'bridgeDisconnected', detail: message }
  }
  return { kind: 'internal', detail: message }
}
