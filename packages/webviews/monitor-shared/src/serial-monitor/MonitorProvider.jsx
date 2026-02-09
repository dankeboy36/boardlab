// @ts-check
import { createPortKey } from 'boards-list'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { HOST_EXTENSION } from 'vscode-messenger-common'

import { vscode } from '@boardlab/base'
import {
  notifyMonitorEditorStatus,
  notifyPlotterEditorStatus,
} from '@boardlab/protocol'

import { createExtensionClient } from './extensionClient.js'
import {
  selectMonitorView,
  selectSerialMonitor,
} from './serialMonitorSelectors.js'
import {
  connect as connectAction,
  disconnect,
  mergeSelectedBaudrate,
  upsertPhysicalState,
  setAutoPlay,
  setMonitorSettingsByProtocol,
  setSelectedBaudrate,
  setSelectedPort,
  updateDetectedPorts,
  upsertSessionState,
} from './serialMonitorSlice.js'
import { useSerialMonitorConnection } from './useSerialMonitorConnection.js'
import { emitWebviewTraceEvent } from './trace.js'

/** @typedef {import('@boardlab/protocol').ExtensionClient} ExtensionClient */

/**
 * @typedef {{
 *   onStart?: () => void
 *   onStop?: () => void
 *   onText?: (text: string) => void
 * }} MonitorStreamListener
 */

/**
 * @typedef {{
 *   registerListener: (listener: MonitorStreamListener) => () => void
 *   play: () => void
 *   stop: () => void
 * }} MonitorContextValue
 */

const MonitorContext = createContext(
  /** @type {MonitorContextValue} */ ({
    registerListener: () => () => {},
    play: () => {},
    stop: () => {},
  })
)

/**
 * Provides the monitor connection lifecycle and shared stream events.
 *
 * @param {{
 *   client: import('./client.js').MonitorClient
 *   children: import('react').ReactNode
 *   extensionClient?: ExtensionClient
 * }} props
 */
export function MonitorProvider({ client, children, extensionClient }) {
  const dispatch = useDispatch()
  const serialState = useSelector(selectSerialMonitor)
  const monitorView = useSelector(selectMonitorView)
  const [ownedService] = useState(
    () => extensionClient ?? createExtensionClient()
  )
  const service = extensionClient ?? ownedService
  const [isConnected, setIsConnected] = useState(false)
  const renderCounterRef = useRef(0)
  renderCounterRef.current += 1
  console.log('[monitor-webview] render', {
    render: renderCounterRef.current,
    isConnected,
  })

  const selectedBaudrate = useMemo(() => {
    const selectedPort = serialState.selectedPort
    if (!selectedPort) return undefined
    const found = serialState.selectedBaudrates.find(
      ([port]) => createPortKey(port) === createPortKey(selectedPort)
    )
    return found?.[1]
  }, [serialState.selectedPort, serialState.selectedBaudrates])

  // Track listeners for stream events; kept outside state to avoid rerenders
  const listenersRef = useRef(
    /** @type {Set<MonitorStreamListener>} */ (new Set())
  )

  const getSelectedPortKey = useCallback(() => {
    const port = selectedPortRef.current
    return port ? createPortKey(port) : undefined
  }, [])

  const notify = useCallback(
    (/** @type {string} */ type, /** @type {string} */ payload = '') => {
      for (const listener of listenersRef.current) {
        try {
          if (type === 'start') listener.onStart?.()
          else if (type === 'stop') listener.onStop?.()
          else if (type === 'text') listener.onText?.(payload)
        } catch (err) {
          console.error('Monitor listener error:', err)
        }
      }
      const eventMap = {
        start: 'webviewMonitorDidStart',
        stop: 'webviewMonitorDidStop',
      }
      if (type === 'start' || type === 'stop') {
        emitWebviewTraceEvent(eventMap[type], {
          portKey: getSelectedPortKey(),
          autoPlay: autoPlayRef.current,
        })
      }
    },
    [getSelectedPortKey]
  )

  const registerListener = useCallback(
    (/** @type {MonitorStreamListener} */ listener) => {
      listenersRef.current.add(listener)
      return () => {
        listenersRef.current.delete(listener)
      }
    },
    []
  )

  const onStreamStart = useCallback(() => {
    notify('start')
  }, [notify])

  const onStreamStop = useCallback(() => {
    notify('stop')
  }, [notify])

  const onStreamText = useCallback(
    (/** @type {string} */ text) => {
      notify('text', text)
    },
    [notify]
  )

  const playRef = useRef(() => {})
  const stopRef = useRef(() => {})

  const onStreamBusy = useCallback(() => {
    dispatch(setAutoPlay(false))
    stopRef.current()
  }, [dispatch])

  const applyPhysicalState = useCallback(
    (payload) => {
      if (!payload || !payload.port) return
      dispatch(upsertPhysicalState(payload))
    },
    [dispatch]
  )

  useEffect(() => {
    if (extensionClient) {
      return undefined
    }
    return () => {
      try {
        ownedService?.dispose?.()
      } catch (error) {
        console.error('Failed to dispose extension client', error)
      }
    }
  }, [extensionClient, ownedService])

  const selectedPortRef = useRef(serialState.selectedPort)
  useEffect(() => {
    selectedPortRef.current = serialState.selectedPort
  }, [serialState.selectedPort])

  const autoPlayRef = useRef(serialState.autoPlay)
  useEffect(() => {
    autoPlayRef.current = serialState.autoPlay
  }, [serialState.autoPlay])

  const lastEditorStatusRef = useRef('')

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) {
      return
    }
    const webviewType =
      typeof window !== 'undefined'
        ? /** @type {Window & { __BOARDLAB_WEBVIEW_TYPE__?: string }} */ (
            window
          ).__BOARDLAB_WEBVIEW_TYPE__
        : undefined
    const editorStatusNotification =
      webviewType === 'plotter'
        ? notifyPlotterEditorStatus
        : notifyMonitorEditorStatus

    const hasDetectionSnapshot = monitorView.hasDetectionSnapshot
    const selectedPort = monitorView.selectedPort
    const selectedDetected = monitorView.selectedDetected

    let editorStatus = 'idle'
    if (selectedPort && hasDetectionSnapshot && !selectedDetected) {
      editorStatus = 'disconnected'
    } else if (monitorView.started) {
      editorStatus =
        monitorView.status === 'suspended' ? 'suspended' : 'running'
    }

    if (lastEditorStatusRef.current === editorStatus) {
      return
    }
    lastEditorStatusRef.current = editorStatus
    try {
      messenger.sendNotification(editorStatusNotification, HOST_EXTENSION, {
        status: editorStatus,
      })
    } catch (error) {
      console.error('Failed to notify editor status', error)
    }
  }, [
    monitorView.hasDetectionSnapshot,
    monitorView.selectedPort,
    monitorView.selectedDetected,
    monitorView.started,
    monitorView.status,
  ])

  const { play, stop } = useSerialMonitorConnection({
    client,
    selectedPort: serialState.selectedPort,
    selectedBaudrate,
    selectedDetected: monitorView.selectedDetected,
    monitorSettingsByProtocol: serialState.monitorSettingsByProtocol,
    session: monitorView.session,
    onText: onStreamText,
    onStart: onStreamStart,
    onStop: onStreamStop,
    onBusy: onStreamBusy,
    enabled: serialState.autoPlay && isConnected,
  })

  useEffect(() => {
    playRef.current = play
  }, [play])

  useEffect(() => {
    stopRef.current = stop
  }, [stop])

  const readyToControl = Boolean(client && isConnected)

  useEffect(() => {
    if (!client || !isConnected || !serialState.selectedPort) {
      return undefined
    }
    const port = serialState.selectedPort
    console.log('[monitor-webview] notifyClientAttached', port)
    client.notifyClientAttached(port)
    let disposed = false
    client
      .sessionStates()
      .then((sessions) => {
        if (disposed || !Array.isArray(sessions)) return
        console.log('[monitor-webview] sessionStates after attach', sessions)
        sessions.forEach((state) => dispatch(upsertSessionState(state)))
      })
      .catch((error) => {
        console.error('Error fetching session states after attach:', error)
      })
    return () => {
      disposed = true
      console.log('[monitor-webview] notifyClientDetached', port)
      client.notifyClientDetached(port)
    }
  }, [client, dispatch, isConnected, serialState.selectedPort])

  const lastIntentRef = useRef('')
  useEffect(() => {
    if (!client || !isConnected || !serialState.selectedPort) {
      lastIntentRef.current = ''
      return
    }
    if (!monitorView.selectedDetected) {
      lastIntentRef.current = ''
      return
    }
    const portKey = createPortKey(serialState.selectedPort)
    if (serialState.autoPlay) {
      const signature = `${portKey}|start`
      if (lastIntentRef.current === signature) {
        return
      }
      lastIntentRef.current = signature
      console.log(
        '[monitor-webview] notifyIntentStart',
        serialState.selectedPort
      )
      client.notifyIntentStart(serialState.selectedPort)
      return
    }
    const signature = `${portKey}|stop`
    if (lastIntentRef.current === signature) {
      return
    }
    lastIntentRef.current = signature
    console.log('[monitor-webview] notifyIntentStop', serialState.selectedPort)
    client.notifyIntentStop(serialState.selectedPort)
  }, [
    client,
    isConnected,
    serialState.selectedPort,
    serialState.autoPlay,
    monitorView.selectedDetected,
  ])

  const requestedInitialSelectionRef = useRef(false)
  const lastSelectionSignatureRef = useRef('')

  const applySelection = useCallback(
    /**
     * @param {{
     *   port?: import('boards-list').PortIdentifier
     *   baudrate?: string
     * }} params
     */
    ({ port, baudrate }) => {
      const incomingKey = port ? createPortKey(port) : undefined
      const selectionSignature = `${incomingKey ?? ''}|${baudrate ?? ''}`
      if (lastSelectionSignatureRef.current === selectionSignature) {
        return
      }
      lastSelectionSignatureRef.current = selectionSignature

      const current = selectedPortRef.current
      const currentKey = current ? createPortKey(current) : undefined
      const selectionChanged = incomingKey !== currentKey
      const wantsAutoPlay = autoPlayRef.current
      console.debug('[monitor-shared] applySelection', {
        incomingKey,
        currentKey,
        wantsAutoPlay,
      })

      if (!port) {
        if (currentKey) {
          // Avoid dropping the current selection when unrelated events push an empty selection.
          return
        }
        dispatch(setSelectedPort(undefined))
        return
      }

      if (incomingKey !== currentKey) {
        dispatch(setSelectedPort(port))
      }

      if (port && baudrate) {
        dispatch(mergeSelectedBaudrate({ port, baudrate }))
      }

      if (readyToControl && selectionChanged && wantsAutoPlay) {
        console.log('[monitor-webview] applySelection autoplay', {
          portKey: incomingKey,
          baudrate,
        })
        playRef.current()
      }

      emitWebviewTraceEvent('webviewDidUpdateSelection', {
        portKey: incomingKey,
        baudrate,
        selectionChanged,
        autoPlay: wantsAutoPlay,
      })
    },
    [dispatch, readyToControl]
  )

  useEffect(() => {
    if (!service) {
      return undefined
    }
    return service.onSelectionChanged(applySelection)
  }, [applySelection, service])

  useEffect(() => {
    if (!service) {
      return undefined
    }
    if (!client) {
      requestedInitialSelectionRef.current = false
      return undefined
    }
    if (requestedInitialSelectionRef.current) {
      return undefined
    }
    requestedInitialSelectionRef.current = true
    service
      .getMonitorSelection()
      .then((selection) => {
        if (selection) {
          console.log('[monitor-webview] initial selection', selection)
          applySelection(selection)
        }
      })
      .catch((error) => {
        console.error('Failed to resolve monitor selection', error)
        requestedInitialSelectionRef.current = false
      })
  }, [applySelection, client, service])

  // Establish client connection and subscriptions once
  useEffect(() => {
    if (!client) {
      dispatch(disconnect())
      setIsConnected(false)
      console.log('[monitor-webview] no client, disconnect')
      return
    }

    let disposed = false

    async function connectClient() {
      try {
        console.log('[monitor-webview] connect start', { clientId: client.id })
        const result = await client.connect()
        if (!disposed) {
          console.log('[monitor-webview] connect resolved', result)
          dispatch(connectAction(result))
          setIsConnected(true)
          if (Array.isArray(result.physicalStates)) {
            result.physicalStates.forEach((state) => applyPhysicalState(state))
          }
          if (result.selectedPort) {
            dispatch(setSelectedPort(result.selectedPort))
            if (result.selectedBaudrate) {
              dispatch(
                mergeSelectedBaudrate({
                  port: result.selectedPort,
                  baudrate: result.selectedBaudrate,
                })
              )
            }
          }
          if (
            !Array.isArray(result.sessionStates) ||
            !result.sessionStates.length
          ) {
            console.log(
              '[monitor-webview] sessionStates empty, requesting snapshot'
            )
            client
              .sessionStates()
              .then((sessions) => {
                if (disposed || !Array.isArray(sessions)) return
                console.log(
                  '[monitor-webview] sessionStates snapshot',
                  sessions
                )
                sessions.forEach((state) => dispatch(upsertSessionState(state)))
              })
              .catch((error) => {
                console.error('Error fetching session states:', error)
              })
          }
        }
      } catch (error) {
        console.error('Error connecting to client:', error)
      }
    }

    connectClient()

    const disposables = [
      client.onDidChangeDetectedPorts((portsUpdate) =>
        dispatch(updateDetectedPorts(portsUpdate))
      ),
      client.onDidChangeMonitorSettings((payload) =>
        dispatch(setMonitorSettingsByProtocol(payload))
      ),
      client.onDidChangeBaudrate((event) =>
        dispatch(
          setSelectedBaudrate({ port: event.port, baudrate: event.baudrate })
        )
      ),
      client.onDidChangePhysicalState((state) => applyPhysicalState(state)),
      client.onDidChangeSessionState(
        (state) => (
          console.log('[monitor-webview] session state update', state),
          dispatch(upsertSessionState(state))
        )
      ),
    ]

    async function fetchDetectedPorts() {
      try {
        const ports = await client.detectedPorts()
        if (!disposed) {
          dispatch(updateDetectedPorts(ports))
        }
      } catch (error) {
        console.error('Error fetching detected ports:', error)
      }
    }

    fetchDetectedPorts()

    return () => {
      disposed = true
      setIsConnected(false)
      console.log('[monitor-webview] connect cleanup')
      for (const disposable of disposables) {
        try {
          disposable.dispose()
        } catch {}
      }
    }
  }, [applyPhysicalState, client, dispatch])

  // When streaming and baudrate changes, update server-side monitor
  useEffect(() => {
    if (!client) return
    if (!serialState.selectedPort) return
    if (!selectedBaudrate) return
    if (monitorView.status !== 'connected') return
    client.updateBaudrate({
      port: serialState.selectedPort,
      baudrate: selectedBaudrate,
    })
  }, [client, monitorView.status, serialState.selectedPort, selectedBaudrate])

  const contextValue = useMemo(
    () => ({
      registerListener,
      play: () => {
        dispatch(setAutoPlay(true))
        if (readyToControl) {
          playRef.current()
        }
      },
      stop: () => {
        dispatch(setAutoPlay(false))
        if (readyToControl) {
          stopRef.current()
        }
      },
    }),
    [dispatch, registerListener, readyToControl]
  )

  return (
    <MonitorContext.Provider value={contextValue}>
      {children}
    </MonitorContext.Provider>
  )
}

/** @returns {MonitorContextValue} */
export function useMonitorController() {
  return useContext(MonitorContext)
}

/**
 * Subscribe to shared monitor stream events.
 *
 * @param {MonitorStreamListener} listener
 */
export function useMonitorStream(listener) {
  const { registerListener } = useMonitorController()
  const listenerRef = useRef(listener)

  useEffect(() => {
    listenerRef.current = listener
  }, [listener])

  useEffect(() => {
    const unsubscribe = registerListener({
      onStart: () => listenerRef.current.onStart?.(),
      onStop: () => listenerRef.current.onStop?.(),
      onText: (text) => listenerRef.current.onText?.(text),
    })
    return () => unsubscribe()
  }, [registerListener])
}
