// @ts-check

import { useCallback, useEffect, useRef } from 'react'
import { createPortKey } from 'boards-list'

import { emitWebviewTraceEvent } from './trace.js'

const buildPortKey = (
  /**
   * @type {Readonly<
   *       Pick<import('boards-list').PortIdentifier, 'protocol' | 'address'>
   *     >
   *   | undefined}
   */ port
) => (port ? createPortKey(port) : undefined)

/**
 * @typedef {Object} UseSerialMonitorConnection
 * @property {import('./client.js').MonitorClient} client
 * @property {import('boards-list').PortIdentifier | undefined} selectedPort
 * @property {string | undefined} selectedBaudrate
 * @property {boolean} [selectedDetected]
 * @property {import('@boardlab/protocol').MonitorSettingsByProtocol} monitorSettingsByProtocol
 * @property {import('@boardlab/protocol').MonitorSessionState | undefined} session
 * @property {(text: string) => void} onText
 * @property {() => void} onStart
 * @property {() => void} onStop
 * @property {() => void} onBusy
 * @property {boolean} [enabled=true] Default is `true`
 * @returns {{ play: () => void; stop: () => void }}
 */
export function useSerialMonitorConnection({
  client,
  selectedPort,
  selectedBaudrate,
  selectedDetected,
  monitorSettingsByProtocol,
  session,
  onText,
  onStart,
  onStop,
  onBusy,
  enabled = true,
}) {
  const abortRef = useRef(
    /** @type {AbortController | undefined} */ (undefined)
  )
  const openingRef = useRef(false)
  const attachedRef = useRef(false)
  const lastAttemptRef = useRef(/** @type {number | null} */ (null))
  const seqRef = useRef(0)
  const lastPortKeyRef = useRef(buildPortKey(selectedPort))
  const lastIntentKeyRef = useRef('')

  useEffect(() => {
    const portKey = buildPortKey(selectedPort)
    if (portKey === lastPortKeyRef.current) {
      return
    }
    lastPortKeyRef.current = portKey
    lastAttemptRef.current = null
    lastIntentKeyRef.current = ''
    attachedRef.current = false
    openingRef.current = false
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = undefined
    }
  }, [selectedPort])

  useEffect(() => {
    const portKey = buildPortKey(selectedPort)
    if (!enabled || !client || !selectedPort) {
      console.log('[monitor-webview] useSerialMonitorConnection disabled', {
        enabled,
        hasClient: Boolean(client),
        portKey,
      })
      lastIntentKeyRef.current = ''
      return
    }
    const detected = Boolean(selectedDetected)
    if (!detected) {
      console.log('[monitor-webview] useSerialMonitorConnection undetected', {
        portKey,
      })
      lastIntentKeyRef.current = `${portKey ?? ''}|detected:false`
      return
    }
    if (session && session.portKey === portKey) {
      if (
        session.desired !== 'stopped' &&
        session.status !== 'paused' &&
        session.status !== 'error'
      ) {
        console.log(
          '[monitor-webview] useSerialMonitorConnection session running',
          {
            portKey,
            desired: session.desired,
            status: session.status,
          }
        )
        lastIntentKeyRef.current = `${portKey ?? ''}|session`
        return
      }
      const signature = `${portKey ?? ''}|detected:true|session-stopped`
      if (lastIntentKeyRef.current === signature) {
        return
      }
      lastIntentKeyRef.current = signature
      console.log(
        '[monitor-webview] useSerialMonitorConnection notifyIntentStart (session stopped)',
        {
          portKey,
        }
      )
      client.notifyIntentStart(selectedPort)
      return
    }
    const signature = `${portKey ?? ''}|detected:true|missing-session`
    if (lastIntentKeyRef.current === signature) {
      return
    }
    lastIntentKeyRef.current = signature
    console.log(
      '[monitor-webview] useSerialMonitorConnection notifyIntentStart (missing session)',
      {
        portKey,
      }
    )
    client.notifyIntentStart(selectedPort)
  }, [client, enabled, selectedPort, selectedDetected, session])

  const play = useCallback(() => {
    if (!client || !selectedPort) {
      return
    }
    emitWebviewTraceEvent('webviewMonitorPlay', {
      portKey: buildPortKey(selectedPort),
    })
    client.notifyIntentStart(selectedPort)
  }, [client, selectedPort])

  const stop = useCallback(() => {
    if (!client || !selectedPort) {
      return
    }
    emitWebviewTraceEvent('webviewMonitorStop', {
      portKey: buildPortKey(selectedPort),
    })
    client.notifyIntentStop(selectedPort)
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = undefined
    }
    attachedRef.current = false
    openingRef.current = false
  }, [client, selectedPort])

  useEffect(() => {
    const portKey = buildPortKey(selectedPort)
    if (!enabled) {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = undefined
      }
      attachedRef.current = false
      openingRef.current = false
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'disabled',
        portKey,
      })
      console.log('[monitor-webview] effect skip disabled', { portKey })
      return
    }
    if (!client || !selectedPort) {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = undefined
      }
      attachedRef.current = false
      openingRef.current = false
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'missing-client-or-port',
        portKey,
      })
      console.log('[monitor-webview] effect skip missing client/port', {
        portKey,
      })
      return
    }

    const selectedProtocol = selectedPort.protocol
    const protocolEntry = selectedProtocol
      ? monitorSettingsByProtocol?.protocols?.[selectedProtocol]
      : undefined
    const protocolError = protocolEntry?.error
    const hasProtocolSettings = Boolean(protocolEntry)
    const requiresBaudrate = Array.isArray(protocolEntry?.settings)
      ? !!protocolEntry.settings.find((s) => s.settingId === 'baudrate')
      : false

    if (!hasProtocolSettings) {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = undefined
      }
      attachedRef.current = false
      openingRef.current = false
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'missing-protocol-settings',
        portKey,
      })
      console.log('[monitor-webview] effect skip missing protocol settings', {
        portKey,
      })
      return
    }
    if (protocolError) {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = undefined
      }
      attachedRef.current = false
      openingRef.current = false
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'protocol-error',
        portKey,
      })
      console.log('[monitor-webview] effect skip protocol error', {
        portKey,
        protocolError,
      })
      return
    }
    if (requiresBaudrate && !selectedBaudrate) {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = undefined
      }
      attachedRef.current = false
      openingRef.current = false
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'missing-baudrate',
        portKey,
      })
      console.log('[monitor-webview] effect skip missing baudrate', { portKey })
      return
    }

    if (!session || session.portKey !== portKey) {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = undefined
      }
      attachedRef.current = false
      openingRef.current = false
      lastAttemptRef.current = null
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'missing-session',
        portKey,
      })
      console.log('[monitor-webview] effect skip missing session', {
        portKey,
        hasSession: Boolean(session),
      })
      return
    }

    if (session.status === 'paused' || session.status === 'error') {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = undefined
      }
      attachedRef.current = false
      openingRef.current = false
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'host-paused-or-error',
        portKey,
        status: session.status,
      })
      console.log('[monitor-webview] effect skip paused/error', {
        portKey,
        status: session.status,
      })
      return
    }

    const shouldOpenPending =
      (session.openPending || session.status === 'connecting') &&
      session.currentAttemptId !== null
    const shouldAttachActive = session.status === 'active'

    if (openingRef.current || attachedRef.current) {
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'already-attached-or-opening',
        portKey,
      })
      console.log('[monitor-webview] effect skip already attached/opening', {
        portKey,
      })
      return
    }

    if (shouldOpenPending) {
      if (lastAttemptRef.current === session.currentAttemptId) {
        emitWebviewTraceEvent('webviewMonitorEffectSkip', {
          reason: 'attempt-already-opened',
          portKey,
          attemptId: session.currentAttemptId,
        })
        console.log('[monitor-webview] effect skip attempt already opened', {
          portKey,
          attemptId: session.currentAttemptId,
        })
        return
      }
      lastAttemptRef.current = session.currentAttemptId
    } else if (!shouldAttachActive) {
      emitWebviewTraceEvent('webviewMonitorEffectSkip', {
        reason: 'no-open-required',
        portKey,
      })
      console.log('[monitor-webview] effect skip no open required', { portKey })
      return
    }

    const mySeq = ++seqRef.current
    const controller = new AbortController()
    abortRef.current = controller
    openingRef.current = true

    const startStream = async () => {
      emitWebviewTraceEvent('webviewMonitorOpenStart', {
        seq: mySeq,
        portKey,
        baudrate: selectedBaudrate,
      })
      console.log('[monitor-webview] open start', {
        seq: mySeq,
        portKey,
        baudrate: selectedBaudrate,
      })
      let reader
      try {
        reader = await client.openMonitor(
          { port: selectedPort, baudrate: selectedBaudrate },
          { signal: controller.signal }
        )
        if (controller.signal.aborted || abortRef.current !== controller) {
          openingRef.current = false
          return
        }
        emitWebviewTraceEvent('webviewMonitorStreamStarted', {
          seq: mySeq,
          portKey,
        })
        console.log('[monitor-webview] stream started', {
          seq: mySeq,
          portKey,
        })
        attachedRef.current = true
        openingRef.current = false
        onStart()
        const decoder = new TextDecoder()
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (value && value.length) {
            console.log('[monitor-webview] stream chunk', {
              portKey,
              bytes: value.length,
            })
            onText(decoder.decode(value, { stream: true }))
          }
        }
        emitWebviewTraceEvent('webviewMonitorStreamEnded', {
          seq: mySeq,
          portKey,
          reason: 'done',
        })
        console.log('[monitor-webview] stream ended (done)', {
          seq: mySeq,
          portKey,
        })
        attachedRef.current = false
        onStop()
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          emitWebviewTraceEvent('webviewMonitorStreamEnded', {
            seq: mySeq,
            portKey,
            reason: 'aborted',
          })
          console.log('[monitor-webview] stream ended (aborted)', {
            seq: mySeq,
            portKey,
          })
          openingRef.current = false
          attachedRef.current = false
          onStop()
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        const errorCode =
          error instanceof Error && 'code' in error
            ? String(error.code)
            : undefined
        const errorStatus =
          error instanceof Error &&
          'status' in error &&
          typeof error.status === 'number'
            ? error.status
            : undefined
        console.log('[monitor-webview] open error', {
          seq: mySeq,
          portKey,
          message,
          code: errorCode,
          status: errorStatus,
        })
        emitWebviewTraceEvent('webviewMonitorOpenError', {
          seq: mySeq,
          portKey,
          message,
          code: errorCode,
          status: errorStatus,
        })
        if (errorCode === 'already-attached') {
          attachedRef.current = true
          openingRef.current = false
          return
        }
        client.notifyOpenError({
          port: selectedPort,
          status: errorStatus,
          code: errorCode,
          message,
        })
        if (errorCode === 'port-busy' || errorStatus === 423) {
          onBusy()
        }
        attachedRef.current = false
        onStop()
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = undefined
        }
        openingRef.current = false
      }
    }

    startStream()
  }, [
    client,
    selectedPort,
    selectedBaudrate,
    selectedDetected,
    monitorSettingsByProtocol,
    session,
    enabled,
    onStart,
    onStop,
    onText,
    onBusy,
  ])

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = undefined
      }
    }
  }, [])

  return { play, stop }
}
