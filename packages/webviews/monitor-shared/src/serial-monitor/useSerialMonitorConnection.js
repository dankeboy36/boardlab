// @ts-check

import { useCallback, useEffect, useRef, useState } from 'react'

import { notifyError, notifyInfo } from '@boardlab/base'

import { emitWebviewTraceEvent } from './trace.js'

const buildPortKey = (
  /**
   * @type {Readonly<Pick<import('ardunno-cli').Port, 'protocol' | 'address'>>
   *   | undefined}
   */ port
) => (port ? `${port.protocol}:${port.address}` : undefined)

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
 * @property {{
 *   current?: {
 *     abortRef: ReturnType<typeof useRef>
 *     pendingStartRef: ReturnType<typeof useRef>
 *     autoplayRef: ReturnType<typeof useRef>
 *     userStoppedRef: ReturnType<typeof useRef>
 *     startTokenRef: ReturnType<typeof useRef>
 *     lastStartedTokenRef: ReturnType<typeof useRef>
 *     attachedRef: ReturnType<typeof useRef>
 *   }
 * }} [debugRefs]
 *   // test-only
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
  debugRefs,
}) {
  const dispatchEventRef = useRef(dispatchEvent)
  useEffect(() => {
    dispatchEventRef.current = dispatchEvent
  }, [dispatchEvent])
  const safeDispatchEvent = useCallback(
    (/** @type {import('./monitorFsm.js').MonitorEvent} */ event) =>
      dispatchEventRef.current?.(event),
    []
  )

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

  const userStoppedRef = useRef(false)
  const disconnectHoldRef = useRef(false)
  const disconnectAtRef = useRef(0)
  const sawAbsentRef = useRef(false)
  const wasStreamingRef = useRef(false)
  const openedAtRef = useRef(0)
  const awaitingBaudRef = useRef(false)
  const pendingStartRef = useRef(false)
  // startTokenRef tracks the latest start request for this editor; lastStartedTokenRef
  // is the last token that actually triggered client.openMonitor().
  const startTokenRef = useRef(0)
  const lastStartedTokenRef = useRef(0)
  const attachedRef = useRef(false)

  const abortRef = useRef(
    /** @type {AbortController | undefined} */ (undefined)
  )
  const seqRef = useRef(0)
  const [forceReconnect, setForceReconnect] = useState(0)

  if (debugRefs) {
    debugRefs.current = {
      abortRef,
      pendingStartRef,
      autoplayRef,
      userStoppedRef,
      startTokenRef,
      lastStartedTokenRef,
      attachedRef,
    }
  }

  const requestStart = useCallback(
    (/** @type {string} */ reason) => {
      if (startTokenRef.current !== lastStartedTokenRef.current) {
        emitWebviewTraceEvent('webviewMonitorStartRequestSkipped', {
          reason,
          portKey: buildPortKey(selectedPort),
          startToken: startTokenRef.current,
        })
        return false
      }
      startTokenRef.current += 1
      emitWebviewTraceEvent('webviewMonitorStartRequested', {
        reason,
        portKey: buildPortKey(selectedPort),
        startToken: startTokenRef.current,
      })
      return true
    },
    [selectedPort]
  )

  const triggerReconnect = useCallback(
    (
      /** @type {string} */ reason,
      opts = /** @type {{ force?: boolean }} */ ({})
    ) => {
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
        queuedReconnectReasonRef.current = reason
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
      queuedReconnectReasonRef.current = null
      setForceReconnect((prev) => prev + 1)
    },
    [selectedPort]
  )

  useEffect(() => {
    autoplayRef.current = autoPlay
    if (autoPlay && !userStoppedRef.current) {
      const didRequest = requestStart('autoplay-enabled')
      if (didRequest) {
        triggerReconnect('autoplay-enabled')
      }
    }
  }, [autoPlay, requestStart, triggerReconnect])

  const selectedDetectedRef = useRef(false)
  const hasDetectionSnapshotRef = useRef(false)
  const prevDetectedRef = useRef(false)
  const forcedAbsentRef = useRef(false)
  const bridgeUnavailableRef = useRef(false)
  const blockedByBridgeRef = useRef(false)
  const queuedReconnectReasonRef = useRef(/** @type {string | null} */ (null))
  const machineRef = useRef(machine)
  const prevLogicalRef = useRef(machine?.logical)
  const prevDesiredRef = useRef(machine?.desired)
  const prevLogicalKindRef = useRef(machine?.logical?.kind)
  const prevLogicalReasonRef = useRef(machine?.logical?.reason)
  const lastPortKeyRef = useRef(buildPortKey(selectedPort))
  const lastClientRef = useRef(client)
  const lastEnabledRef = useRef(enabled)
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
      const hasPendingToken =
        startTokenRef.current !== lastStartedTokenRef.current
      if (!userStoppedRef.current && (autoplayRef.current || hasPendingToken)) {
        if (!hasPendingToken) {
          requestStart('suspend-cleared')
        }
        triggerReconnect('suspend-cleared')
      }
    }
    prevLogicalRef.current = next
  }, [machine, requestStart, triggerReconnect])

  // Re-evaluate the main effect when host intent/logical changes; this keeps
  // auto-play aligned with the extension FSM even if detection/props are stable.
  useEffect(() => {
    const desired = machine?.desired
    const logicalKind = machine?.logical?.kind
    const logicalReason = machine?.logical?.reason
    if (
      desired !== prevDesiredRef.current ||
      logicalKind !== prevLogicalKindRef.current ||
      logicalReason !== prevLogicalReasonRef.current
    ) {
      prevDesiredRef.current = desired
      prevLogicalKindRef.current = logicalKind
      prevLogicalReasonRef.current = logicalReason
      setForceReconnect((prev) => prev + 1)
    }
  }, [machine])

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
    if (portKey !== lastPortKeyRef.current) {
      startTokenRef.current = 0
      lastStartedTokenRef.current = 0
      attachedRef.current = false
    }
    const hasPendingToken =
      startTokenRef.current !== lastStartedTokenRef.current

    hasDetectionSnapshotRef.current = hasSnapshot
    selectedDetectedRef.current = isDetected
    // Clear stale start/abort flags when the device comes back; otherwise reconnects may be skipped.
    if (isDetected) {
      if (abortRef.current?.signal?.aborted) {
        abortRef.current = undefined
      }
      pendingStartRef.current = false
      if (
        queuedReconnectReasonRef.current &&
        !userStoppedRef.current &&
        (autoplayRef.current || hasPendingToken) &&
        !abortRef.current
      ) {
        const queued = queuedReconnectReasonRef.current
        queuedReconnectReasonRef.current = null
        if (!hasPendingToken) {
          requestStart(`queued-${queued}`)
        }
        triggerReconnect(queued, { force: true })
      }
    }
    if (prevSnapshot !== hasSnapshot || prevDetected !== isDetected) {
      emitWebviewTraceEvent('webviewMonitorDetectionState', {
        portKey,
        hasSnapshot,
        detected: isDetected,
        prevDetected,
      })
      if (isDetected) {
        blockedByBridgeRef.current = false
      }
      /** @type {import('./monitorFsm.js').MonitorEvent} */
      if (selectedPort) {
        const evt = isDetected
          ? { type: 'PORT_DETECTED', port: selectedPort }
          : {
              type: 'PORT_LOST',
              port: selectedPort,
            }
        safeDispatchEvent(evt)
      }
    }
    if (bridgeUnavailableRef.current && isDetected) {
      // Bridge previously unavailable; allow retry when the device reappears,
      // but only if the host still wants us running.
      const hostDesired = machineRef.current?.desired ?? 'running'
      if (hostDesired === 'running' && !userStoppedRef.current) {
        bridgeUnavailableRef.current = false
        pendingStartRef.current = false
        if (abortRef.current?.signal?.aborted) {
          abortRef.current = undefined
        }
        emitWebviewTraceEvent('webviewMonitorBridgeReappear', {
          portKey,
        })
        if (autoplayRef.current || hasPendingToken) {
          if (!hasPendingToken) {
            requestStart('bridge-unavailable')
          }
          triggerReconnect('bridge-unavailable')
        }
      } else {
        emitWebviewTraceEvent('webviewMonitorReconnectSkipped', {
          reason: 'bridge-unavailable-host-stopped',
          portKey,
          hostDesired,
        })
      }
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
      if (!userStoppedRef.current && (autoplayRef.current || hasPendingToken)) {
        if (!hasPendingToken) {
          requestStart('device-detected')
        }
        triggerReconnect('device-detected')
      }
    } else if (wasDetected && !isDetected) {
      sawAbsentRef.current = true
      prevDetectedRef.current = isDetected
    } else {
      prevDetectedRef.current = isDetected
    }
  }, [
    detectedPorts,
    selectedPort,
    requestStart,
    triggerReconnect,
    safeDispatchEvent,
  ])

  // Expose play/stop by mutating refs (consumers can call via returned functions if needed later)
  /** Force immediate reconnect attempt, clearing holds */
  const playNow = () => {
    emitWebviewTraceEvent('webviewMonitorPlay', {
      portKey: buildPortKey(selectedPort),
      baudrate: selectedBaudrateRef.current,
      hasClient: !!client,
      userStopped: userStoppedRef.current,
    })
    safeDispatchEvent({ type: 'USER_START' })
    console.info('[monitor] playNow', {
      hasClient: !!client,
      selectedPort,
      autoPlay: autoplayRef.current,
      userStopped: userStoppedRef.current,
      aborting: !!abortRef.current,
    })
    // Reset any stuck start/abort flags so this play request always proceeds.
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = undefined
    }
    pendingStartRef.current = false
    userStoppedRef.current = false
    disconnectHoldRef.current = false
    sawAbsentRef.current = false
    queuedReconnectReasonRef.current = null
    lastStartedTokenRef.current = startTokenRef.current
    bridgeUnavailableRef.current = false
    blockedByBridgeRef.current = false
    // Force effect re-evaluation by updating state
    const didRequest = requestStart('play')
    if (didRequest) {
      triggerReconnect('play', { force: true })
    }
  }

  /** User stop: abort stream and prevent auto-reconnect */
  const stopNow = () => {
    emitWebviewTraceEvent('webviewMonitorStop', {
      portKey: buildPortKey(selectedPort),
      baudrate: selectedBaudrateRef.current,
      hasClient: !!client,
    })
    safeDispatchEvent({ type: 'USER_STOP' })
    console.info('[monitor] stopNow', {
      hasClient: !!client,
      selectedPort,
    })
    queuedReconnectReasonRef.current = null
    userStoppedRef.current = true
    disconnectHoldRef.current = false
    pendingStartRef.current = false
    lastStartedTokenRef.current = startTokenRef.current
    attachedRef.current = false
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = undefined
    }
  }

  // Core effect: manages stream lifecycle and reconnect policy
  useEffect(() => {
    const portKey = buildPortKey(selectedPort)
    const portChanged = lastPortKeyRef.current !== portKey
    const clientChanged = lastClientRef.current !== client
    const becameDisabled = lastEnabledRef.current && !enabled
    const shouldAbortOnCleanup = portChanged || clientChanged || becameDisabled
    let inputsMarked = false
    const markInputs = () => {
      if (inputsMarked) return
      inputsMarked = true
      lastPortKeyRef.current = portKey
      lastClientRef.current = client
      lastEnabledRef.current = enabled
    }

    const currentBaudrate = selectedBaudrateRef.current
    // If disabled, abort any current stream and skip
    if (!enabled) {
      markInputs()
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = undefined
      }
      console.info('[monitor] effect skipped (disabled)')
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'disabled',
        portKey,
      })
      return
    }
    if (!client || !selectedPort) {
      markInputs()
      console.info('[monitor] effect skipped (missing client or port)', {
        hasClient: !!client,
        selectedPort,
      })
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'missing-client-or-port',
        hasClient: !!client,
        portKey,
      })
      return
    }

    // Ensure monitor settings for this protocol are resolved first
    if (!hasProtocolSettings) {
      markInputs()
      // Not resolved yet: do not attempt to start
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'missing-protocol-settings',
        portKey,
      })
      return
    }
    if (protocolError) {
      markInputs()
      // Protocol not supported for monitor
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'protocol-error',
        portKey,
      })
      return
    }
    if (requiresBaudrate && !currentBaudrate) {
      markInputs()
      console.info('[monitor] effect waiting for baudrate')
      awaitingBaudRef.current = true
      emitWebviewTraceEvent('webviewMonitorAwaitBaudrate', {
        portKey,
      })
      return
    }
    awaitingBaudRef.current = false

    const hasDetectionSnapshot = hasDetectionSnapshotRef.current
    const selectedDetected = selectedDetectedRef.current
    const detected =
      hasDetectionSnapshot && selectedDetected && !forcedAbsentRef.current
    const logical = machineRef.current?.logical
    const hostDesired = machineRef.current?.desired ?? 'running'
    const hostLogicalKind = logical?.kind
    const isUserPaused =
      logical && logical.kind === 'paused' && logical.reason === 'user'
    const hostPausedByUser =
      logical?.kind === 'paused' && logical.reason === 'user'
    const isSuspended =
      logical &&
      logical.kind === 'paused' &&
      (logical.reason === 'suspend' ||
        logical.reason === 'resource-busy' ||
        logical.reason === 'resource-missing')
    const hasNewStartToken =
      startTokenRef.current !== lastStartedTokenRef.current
    const shouldStart =
      hasNewStartToken &&
      !userStoppedRef.current &&
      detected &&
      !abortRef.current &&
      !isSuspended &&
      !blockedByBridgeRef.current &&
      hostDesired === 'running' &&
      hostLogicalKind !== 'error'

    console.info('[monitor] effect evaluate', {
      autoPlay: autoplayRef.current,
      detected,
      hasDetectionSnapshot,
      hasStartToken: hasNewStartToken,
      userStopped: userStoppedRef.current,
      aborting: !!abortRef.current,
      suspended: !!isSuspended,
      hostDesired,
      hostLogicalKind,
      shouldStart,
    })
    emitWebviewTraceEvent('webviewMonitorEffectEvaluate', {
      portKey: buildPortKey(selectedPort),
      baudrate: currentBaudrate,
      autoPlay: autoplayRef.current,
      detected,
      hasDetectionSnapshot,
      hasStartToken: hasNewStartToken,
      userStopped: userStoppedRef.current,
      aborting: !!abortRef.current,
      hostDesired,
      hostLogicalKind,
      blockedByBridge: blockedByBridgeRef.current,
      shouldStart,
    })

    if (isSuspended) {
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'suspended',
        portKey,
      })
      markInputs()
      return
    }
    const startIntent = autoplayRef.current || hasNewStartToken
    // If host still reports desired=stopped while we have autoPlay + detection,
    // gently nudge it to running so the FSMs align. Allow nudging even when the
    // logical kind is undefined/connecting/waitingForPort; the intent from the
    // webview is still "start".
    if (
      hostDesired === 'stopped' &&
      (hostLogicalKind === 'idle' || isUserPaused) &&
      startIntent &&
      detected &&
      !userStoppedRef.current &&
      !abortRef.current &&
      !blockedByBridgeRef.current
    ) {
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'host-desired-stopped-nudge',
        portKey,
      })
      if (!hasNewStartToken) {
        requestStart('host-desired-stopped-nudge')
      }
      safeDispatchEvent({ type: 'USER_START', port: selectedPort })
      markInputs()
      return
    }
    if (hostDesired !== 'running') {
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'host-desired-stopped',
        portKey,
      })
      markInputs()
      return
    }

    if (blockedByBridgeRef.current) {
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'blocked-by-bridge',
        portKey,
      })
      markInputs()
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
          portKey,
          elapsedMs: elapsed,
        })
        markInputs()
        return
      }
      // Clear hold when conditions satisfied
      disconnectHoldRef.current = false
      sawAbsentRef.current = false
    }

    if (!detected) {
      // Track that we saw the device absent at least once
      sawAbsentRef.current = true
      emitWebviewTraceEvent('webviewMonitorNotDetected', {
        portKey,
      })
      markInputs()
      return
    }

    const shouldAttach =
      !attachedRef.current &&
      hostDesired === 'running' &&
      hostLogicalKind === 'active' &&
      detected &&
      !userStoppedRef.current &&
      !blockedByBridgeRef.current

    if (!hasNewStartToken && !shouldAttach) {
      console.info('[monitor] no start token; skipping start')
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'no-start-token',
        portKey,
      })
      markInputs()
      return
    }

    // If the device has reappeared after an absence, drop a stale aborted
    // controller so we can actually reconnect.
    if (
      sawAbsentRef.current &&
      detected &&
      abortRef.current &&
      abortRef.current.signal.aborted &&
      !pendingStartRef.current
    ) {
      emitWebviewTraceEvent('webviewMonitorAbortCleared', {
        portKey,
      })
      abortRef.current = undefined
    }

    // Do not start a second stream if one is already active. This is critical
    // during baudrate changes: we rely on RequestUpdateBaudrate to adjust the
    // existing monitor without reconnecting.
    if (abortRef.current && !shouldAttach) {
      console.info('[monitor] abort controller already set, skipping start')
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'abort-controller-set',
        portKey,
      })
      markInputs()
      return
    }
    if (shouldAttach && abortRef.current) {
      abortRef.current.abort()
      abortRef.current = undefined
    }
    // Start a new open sequence
    if (pendingStartRef.current) {
      console.info('[monitor] start pending; skipping duplicate trigger')
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'start-pending',
        portKey,
      })
      markInputs()
      return
    }
    if (shouldAttach) {
      emitWebviewTraceEvent('webviewMonitorAttachRequested', {
        portKey,
        hostLogicalKind,
      })
    }

    const mySeq = ++seqRef.current
    const controller = new AbortController()
    abortRef.current = controller
    const signal = controller.signal
    pendingStartRef.current = true
    const startToken = startTokenRef.current
    lastStartedTokenRef.current = startToken
    const attemptId = startToken > 0 ? startToken : undefined
    safeDispatchEvent({
      type: 'OPEN_REQUESTED',
      port: selectedPort,
      attemptId,
    })

    // Reset stream flags
    wasStreamingRef.current = false
    openedAtRef.current = Date.now()

    const startStream = async () => {
      const startBaudrate = selectedBaudrateRef.current
      emitWebviewTraceEvent('webviewMonitorOpenStart', {
        seq: mySeq,
        startToken,
        portKey,
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
          portKey,
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
          portKey,
        })
        attachedRef.current = true
        safeDispatchEvent({
          type: 'OPEN_OK',
          port: selectedPort,
          attemptId,
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
          portKey,
          reason: 'done',
        })
        attachedRef.current = false
        safeDispatchEvent({
          type: 'STREAM_CLOSED',
          port: selectedPort,
          attemptId,
        })
        onStop()
        if (abortRef.current === controller) {
          abortRef.current = undefined
        }
        pendingStartRef.current = false
        const queuedReason = queuedReconnectReasonRef.current
        queuedReconnectReasonRef.current = null
        if (!userStoppedRef.current) {
          const elapsed = Date.now() - openedAtRef.current
          const detectedNow =
            selectedDetectedRef.current && !forcedAbsentRef.current
          const desired = machineRef.current?.desired ?? 'running'
          const logicalKind = machineRef.current?.logical?.kind
          const hostStillRunning =
            desired === 'running' && logicalKind !== 'paused'
          const canAutoReconnect = autoplayRef.current
          if (
            queuedReason &&
            canAutoReconnect &&
            hostStillRunning &&
            detectedNow &&
            !abortRef.current &&
            !pendingStartRef.current
          ) {
            requestStart(`queued-${queuedReason}`)
            triggerReconnect(queuedReason, { force: true })
            return
          }
          if (
            canAutoReconnect &&
            hostStillRunning &&
            !wasStreamingRef.current &&
            elapsed < coldStartMsRef.current
          ) {
            disconnectHoldRef.current = false
            sawAbsentRef.current = false
            requestStart('cold-start-retry')
            triggerReconnect('cold-start-retry')
          } else if (canAutoReconnect && hostStillRunning && detectedNow) {
            disconnectHoldRef.current = false
            sawAbsentRef.current = false
            requestStart('detected-retry')
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
            portKey,
            reason: 'aborted',
          })
          attachedRef.current = false
          safeDispatchEvent({
            type: 'STREAM_CLOSED',
            port: selectedPort,
            attemptId,
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
          err instanceof Error && 'code' in err ? String(err.code) : undefined
        const errorStatus =
          err instanceof Error &&
          'status' in err &&
          typeof err.status === 'number'
            ? err.status
            : undefined
        emitWebviewTraceEvent('webviewMonitorOpenError', {
          seq: mySeq,
          portKey,
          message,
          code: errorCode,
          status: errorStatus,
        })
        attachedRef.current = false
        safeDispatchEvent({
          type: 'OPEN_FAIL',
          port: selectedPort,
          attemptId,
          error: mapError(errorCode, errorStatus, message),
        })
        onStop()
        if (abortRef.current === controller) {
          abortRef.current = undefined
        }
        if (errorCode === 'already-attached') {
          emitWebviewTraceEvent('webviewMonitorErrorHandled', {
            seq: mySeq,
            portKey,
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
            portKey,
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
            portKey,
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
            portKey,
            resolution: 'bridge-unavailable',
          })
          // Bridge returned 502 (monitor unavailable). Treat as transient and wait for reappear.
          bridgeUnavailableRef.current = true
          blockedByBridgeRef.current = true
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
            portKey,
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
          portKey,
          resolution: 'stopped',
        })
        userStoppedRef.current = true
        onBusy()
        disconnectHoldRef.current = true
        disconnectAtRef.current = Date.now()
        pendingStartRef.current = false
      }
    }

    markInputs()
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
      markInputs()
      emitWebviewTraceEvent('webviewMonitorEffectCleanup', {
        seq: mySeq,
        portKey,
      })
      if (!shouldAbortOnCleanup) {
        return
      }
      clearTimeout(timer)
      attachedRef.current = false
      controller.abort()
      pendingStartRef.current = false
      if (abortRef.current === controller) {
        abortRef.current = undefined
      }
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
    requestStart,
    triggerReconnect,
    safeDispatchEvent,
  ])

  // If baudrate becomes available after being undefined (and required by protocol),
  // trigger a connection attempt without tearing down an existing stream.
  useEffect(() => {
    if (!client || !selectedPort) return
    if (!awaitingBaudRef.current) return
    if (!hasProtocolSettings || protocolError) return
    if (requiresBaudrate && !selectedBaudrate) return
    awaitingBaudRef.current = false
    const hasPendingToken =
      startTokenRef.current !== lastStartedTokenRef.current
    if (
      !abortRef.current &&
      !userStoppedRef.current &&
      (autoplayRef.current || hasPendingToken)
    ) {
      if (!hasPendingToken) {
        requestStart('baudrate-ready')
      }
      triggerReconnect('baudrate-ready')
    }
  }, [
    client,
    selectedPort,
    selectedBaudrate,
    hasProtocolSettings,
    protocolError,
    requiresBaudrate,
    requestStart,
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
