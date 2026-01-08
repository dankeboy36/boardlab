// @ts-check

import { useCallback, useEffect, useRef, useState } from 'react'

import { notifyError, notifyInfo } from '@boardlab/base'

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
}) {
  const autoplayRef = useRef(options?.autoplay ?? true)
  const disconnectHoldMsRef = useRef(options?.disconnectHoldMs ?? 1500)
  const coldStartMsRef = useRef(options?.coldStartMs ?? 1000)

  // Keep options in sync
  useEffect(() => {
    autoplayRef.current = options?.autoplay ?? true
    disconnectHoldMsRef.current = options?.disconnectHoldMs ?? 1500
    coldStartMsRef.current = options?.coldStartMs ?? 1000
  }, [options?.autoplay, options?.disconnectHoldMs, options?.coldStartMs])

  useEffect(() => {
    autoplayRef.current = autoPlay
    if (!autoPlay) {
      userStoppedRef.current = true
    }
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

  const triggerReconnect = useCallback(() => {
    setForceReconnect((prev) => prev + 1)
  }, [])

  const selectedDetectedRef = useRef(false)
  const hasDetectionSnapshotRef = useRef(false)
  const prevDetectedRef = useRef(false)
  const forcedAbsentRef = useRef(false)

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

    hasDetectionSnapshotRef.current = hasSnapshot
    selectedDetectedRef.current = isDetected
    if (forcedAbsentRef.current && isDetected) {
      forcedAbsentRef.current = false
    }

    if (!selectedPort) {
      prevDetectedRef.current = false
      forcedAbsentRef.current = false
      return
    }

    if (!prevDetectedRef.current && isDetected) {
      prevDetectedRef.current = isDetected
    } else if (prevDetectedRef.current && !isDetected) {
      sawAbsentRef.current = true
      prevDetectedRef.current = isDetected
    } else {
      prevDetectedRef.current = isDetected
    }
  }, [detectedPorts, selectedPort, triggerReconnect])

  // Expose play/stop by mutating refs (consumers can call via returned functions if needed later)
  /** Force immediate reconnect attempt, clearing holds */
  const playNow = () => {
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
    // Abort any in-flight stream before triggering a reconnect so callers
    // don't immediately see an AbortError surfaced from a previous controller.
    if (abortRef.current) {
      try {
        abortRef.current.abort()
      } catch {}
      abortRef.current = undefined
    }
    // Force effect re-evaluation by updating state
    triggerReconnect()
  }

  /** User stop: abort stream and prevent auto-reconnect */
  const stopNow = () => {
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
    // If disabled, abort any current stream and skip
    if (!enabled) {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = undefined
      }
      console.info('[monitor] effect skipped (disabled)')
      return
    }
    if (!client || !selectedPort) {
      console.info('[monitor] effect skipped (missing client or port)', {
        hasClient: !!client,
        selectedPort,
      })
      return
    }

    // Ensure monitor settings for this protocol are resolved first
    const proto = selectedPort.protocol
    const entry = monitorSettingsByProtocol?.protocols?.[proto]
    if (!entry) {
      // Not resolved yet: do not attempt to start
      return
    }
    if (entry.error) {
      // Protocol not supported for monitor
      return
    }
    const hasBaudSetting = Array.isArray(entry.settings)
      ? !!entry.settings.find((s) => s.settingId === 'baudrate')
      : false
    if (hasBaudSetting && !selectedBaudrate) {
      console.info('[monitor] effect waiting for baudrate')
      awaitingBaudRef.current = true
      return
    }
    awaitingBaudRef.current = false

    const hasDetectionSnapshot = hasDetectionSnapshotRef.current
    const selectedDetected = selectedDetectedRef.current
    const detected =
      hasDetectionSnapshot && selectedDetected && !forcedAbsentRef.current
    const shouldStart =
      !userStoppedRef.current &&
      autoplayRef.current &&
      detected &&
      !abortRef.current

    console.info('[monitor] effect evaluate', {
      autoPlay: autoplayRef.current,
      detected,
      hasDetectionSnapshot,
      userStopped: userStoppedRef.current,
      aborting: !!abortRef.current,
      shouldStart,
    })

    // Manage disconnect hold lifecycle
    if (disconnectHoldRef.current) {
      const now = Date.now()
      const elapsed = now - disconnectAtRef.current
      const holdExpired = elapsed >= disconnectHoldMsRef.current
      const reappeared = sawAbsentRef.current && detected
      if (!holdExpired && !reappeared) {
        return
      }
      // Clear hold when conditions satisfied
      disconnectHoldRef.current = false
      sawAbsentRef.current = false
    }

    if (!autoplayRef.current) {
      console.info('[monitor] autoplay disabled; skipping start')
      return
    }

    if (!detected) {
      // Track that we saw the device absent at least once
      sawAbsentRef.current = true
      return
    }

    // Do not start a second stream if one is already active. This is critical
    // during baudrate changes: we rely on RequestUpdateBaudrate to adjust the
    // existing monitor without reconnecting.
    if (abortRef.current) {
      console.info('[monitor] abort controller already set, skipping start')
      return
    }
    // Start a new open sequence
    if (pendingStartRef.current) {
      console.info('[monitor] start pending; skipping duplicate trigger')
      return
    }

    const mySeq = ++seqRef.current
    const controller = new AbortController()
    abortRef.current = controller
    const signal = controller.signal
    pendingStartRef.current = true
    const startToken = ++startTokenRef.current

    // Reset stream flags
    wasStreamingRef.current = false
    openedAtRef.current = Date.now()

    const startStream = async () => {
      console.info('[monitor] opening monitor', {
        seq: mySeq,
        port: selectedPort,
        baudrate: selectedBaudrate,
      })
      let reader
      try {
        reader = await client.openMonitor(
          { port: selectedPort, baudrate: selectedBaudrate },
          { signal }
        )
        if (
          mySeq !== seqRef.current ||
          controller.signal.aborted ||
          abortRef.current !== controller
        ) {
          pendingStartRef.current = false
          return
        }
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
        onStop()
        if (abortRef.current === controller) {
          abortRef.current = undefined
        }
        if (!userStoppedRef.current) {
          const elapsed = Date.now() - openedAtRef.current
          const detectedNow =
            selectedDetectedRef.current && !forcedAbsentRef.current
          if (!wasStreamingRef.current && elapsed < coldStartMsRef.current) {
            disconnectHoldRef.current = false
            sawAbsentRef.current = false
            triggerReconnect()
          } else if (detectedNow) {
            disconnectHoldRef.current = false
            sawAbsentRef.current = false
            triggerReconnect()
          } else {
            disconnectHoldRef.current = true
            disconnectAtRef.current = Date.now()
            notifyInfo('Device disconnected; waiting for reappear')
          }
        }
        pendingStartRef.current = false
      } catch (err) {
        if (mySeq !== seqRef.current) return
        if (
          (err instanceof Error && err?.name === 'AbortError') ||
          controller.signal.aborted
        ) {
          onStop()
          if (abortRef.current === controller) {
            abortRef.current = undefined
          }
          pendingStartRef.current = false
          return
        }
        onStop()
        if (abortRef.current === controller) {
          abortRef.current = undefined
        }
        const message = err instanceof Error ? err?.message : String(err)
        const errorCode = err && typeof err === 'object' ? err.code : undefined
        const errorStatus =
          err && typeof err === 'object' ? err.status : undefined
        if (errorCode === 'port-busy' || errorStatus === 423) {
          notifyError(`${selectedPort.address} port busy`)
          userStoppedRef.current = true
          onBusy()
          pendingStartRef.current = false
          return
        }
        const isMissingDevice =
          errorCode === 'port-not-detected' || errorStatus === 404
        const shouldRefreshDetection =
          errorCode === 'monitor-open-failed' || errorStatus === 502
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
        if (shouldRefreshDetection) {
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
    }
  }, [
    client,
    selectedPort,
    monitorSettingsByProtocol,
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
    const entry = monitorSettingsByProtocol?.protocols?.[selectedPort.protocol]
    if (!entry || entry.error) return
    const hasBaudSetting = Array.isArray(entry.settings)
      ? !!entry.settings.find((s) => s.settingId === 'baudrate')
      : false
    if (hasBaudSetting && !selectedBaudrate) return
    awaitingBaudRef.current = false
    if (!abortRef.current && !userStoppedRef.current && autoplayRef.current) {
      triggerReconnect()
    }
  }, [
    client,
    selectedPort,
    selectedBaudrate,
    monitorSettingsByProtocol,
    triggerReconnect,
  ])

  // Return imperative controls for future UI buttons
  return {
    play: () => playNow(),
    stop: () => stopNow(),
  }
}
