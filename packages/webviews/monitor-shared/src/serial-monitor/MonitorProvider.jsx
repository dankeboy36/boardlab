// @ts-check
import { vscode } from '@boardlab/base'
import {
  getMonitorSelection,
  notifyMonitorSelectionChanged,
} from '@boardlab/protocol'
import { createPortKey } from 'boards-list'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { HOST_EXTENSION } from 'vscode-messenger-common'

import { selectSerialMonitor } from './serialMonitorSelectors.js'
import {
  connect as connectAction,
  disconnect,
  mergeSelectedBaudrate,
  pauseMonitor,
  resumeMonitor,
  setAutoPlay,
  setMonitorSettingsByProtocol,
  setSelectedBaudrate,
  setSelectedPort,
  startMonitor,
  stopMonitor,
  updateDetectedPorts,
} from './serialMonitorSlice.js'
import { useSerialMonitorConnection } from './useSerialMonitorConnection.js'

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
 * }} props
 */
export function MonitorProvider({ client, children }) {
  const dispatch = useDispatch()
  const serialState = useSelector(selectSerialMonitor)

  const selectedBaudrate = useMemo(() => {
    const selectedPort = serialState.selectedPort
    if (!selectedPort) return undefined
    const found = serialState.selectedBaudrates.find(
      ([port]) => createPortKey(port) === createPortKey(selectedPort)
    )
    return found?.[1]
  }, [serialState.selectedPort, serialState.selectedBaudrates])

  // Track listeners for stream events; kept outside state to avoid rerenders
  const listenersRef = useRef(new Set())

  const notify = useCallback((type, payload) => {
    for (const listener of listenersRef.current) {
      try {
        if (type === 'start') listener.onStart?.()
        else if (type === 'stop') listener.onStop?.()
        else if (type === 'text') listener.onText?.(payload)
      } catch (err) {
        console.error('Monitor listener error:', err)
      }
    }
  }, [])

  const registerListener = useCallback((listener) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  const onStreamStart = useCallback(() => {
    dispatch(startMonitor())
    notify('start')
  }, [dispatch, notify])

  const onStreamStop = useCallback(() => {
    dispatch(stopMonitor())
    notify('stop')
  }, [dispatch, notify])

  const onStreamText = useCallback(
    (text) => {
      notify('text', text)
    },
    [notify]
  )

  const onStreamBusy = useCallback(() => {
    dispatch(setAutoPlay(false))
    dispatch(stopMonitor())
  }, [dispatch])

  const monitorOptions = useMemo(
    () => ({ disconnectHoldMs: 1500, coldStartMs: 1000 }),
    []
  )

  const selectedPortRef = useRef(serialState.selectedPort)
  useEffect(() => {
    selectedPortRef.current = serialState.selectedPort
  }, [serialState.selectedPort])

  const autoPlayRef = useRef(serialState.autoPlay)
  useEffect(() => {
    autoPlayRef.current = serialState.autoPlay
  }, [serialState.autoPlay])

  const startedRef = useRef(serialState.started)
  useEffect(() => {
    startedRef.current = serialState.started
  }, [serialState.started])

  const { play, stop } = useSerialMonitorConnection({
    client,
    selectedPort: serialState.selectedPort,
    detectedPorts: serialState.detectedPorts,
    selectedBaudrate,
    monitorSettingsByProtocol: serialState.monitorSettingsByProtocol,
    onText: onStreamText,
    onStart: onStreamStart,
    onStop: onStreamStop,
    onBusy: onStreamBusy,
    options: monitorOptions,
    enabled: true,
    autoPlay: serialState.autoPlay,
  })

  const playRef = useRef(play)
  useEffect(() => {
    playRef.current = play
  }, [play])

  const stopRef = useRef(stop)
  useEffect(() => {
    stopRef.current = stop
  }, [stop])

  const readyToControl = Boolean(client)

  const requestedInitialSelectionRef = useRef(false)

  const applySelection = useCallback(
    ({ port, baudrate }) => {
      const current = selectedPortRef.current
      const currentKey = current ? createPortKey(current) : undefined
      const incomingKey = port ? createPortKey(port) : undefined
      const wantsAutoPlay = autoPlayRef.current
      console.debug('[monitor-shared] applySelection', {
        incomingKey,
        currentKey,
        wantsAutoPlay,
        started: startedRef.current,
      })

      if (!port) {
        if (currentKey) {
          dispatch(setSelectedPort(undefined))
        }
        if (startedRef.current && readyToControl) {
          stopRef.current()
        }
        return
      }

      if (incomingKey !== currentKey) {
        dispatch(setSelectedPort(port))
      }

      if (port && baudrate) {
        dispatch(mergeSelectedBaudrate({ port, baudrate }))
      }

      if (readyToControl) {
        if (wantsAutoPlay) {
          playRef.current()
        } else if (startedRef.current) {
          stopRef.current()
        }
      }
    },
    [dispatch, readyToControl]
  )

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) {
      return
    }
    const disposable = messenger.onNotification(
      notifyMonitorSelectionChanged,
      applySelection
    )
    return () => {
      try {
        disposable?.dispose?.()
      } catch (error) {
        console.error('Failed to dispose selection listener', error)
      }
    }
  }, [applySelection])

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) {
      return
    }
    if (!client) {
      requestedInitialSelectionRef.current = false
      return
    }
    if (requestedInitialSelectionRef.current) {
      return
    }
    requestedInitialSelectionRef.current = true
    messenger
      .sendRequest(getMonitorSelection, HOST_EXTENSION)
      .then((selection) => {
        if (selection) {
          applySelection(selection)
        }
      })
      .catch((error) => {
        console.error('Failed to resolve monitor selection', error)
        requestedInitialSelectionRef.current = false
      })
  }, [applySelection, client])

  const previousStatusRef = useRef(serialState.status)
  useEffect(() => {
    const previous = previousStatusRef.current
    previousStatusRef.current = serialState.status
    if (!client) return
    if (!serialState.started) return
    if (serialState.status !== 'connected') return
    if (previous !== 'suspended') return
    if (!readyToControl) return
    playRef.current()
  }, [client, serialState.status, serialState.started, readyToControl])

  // Establish client connection and subscriptions once
  useEffect(() => {
    if (!client) {
      dispatch(disconnect())
      return
    }

    let disposed = false

    async function connectClient() {
      try {
        const result = await client.connect()
        if (!disposed) {
          dispatch(connectAction(result))
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
      client.onDidPauseMonitor((event) => dispatch(pauseMonitor(event))),
      client.onDidResumeMonitor((event) => dispatch(resumeMonitor(event))),
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
      for (const disposable of disposables) {
        try {
          disposable.dispose()
        } catch {}
      }
    }
  }, [client, dispatch])

  // When streaming and baudrate changes, update server-side monitor
  useEffect(() => {
    if (!client) return
    if (!serialState.selectedPort) return
    if (!selectedBaudrate) return
    if (!serialState.started) return
    client.updateBaudrate({
      port: serialState.selectedPort,
      baudrate: selectedBaudrate,
    })
  }, [client, serialState.selectedPort, selectedBaudrate, serialState.started])

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
