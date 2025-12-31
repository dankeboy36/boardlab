// @ts-check
import { useCallback, useEffect, useRef, useState } from 'react'
import { HOST_EXTENSION } from 'vscode-messenger-common'
import {
  ConsoleLogger,
  createWebSocketConnection,
  toSocket,
} from 'vscode-ws-jsonrpc'

import { vscode } from '@boardlab/base'
import { getMonitorBridgeInfo } from '@boardlab/protocol'

import { MonitorClient } from '../client.js'
import { MonitorClientContext } from './MonitorClientContext.js'

/** @param {string} url */
function setGlobalHttpBase(url) {
  try {
    /** @type {Record<string, unknown>} */ globalThis.__BOARDLAB_MONITOR_HTTP_BASE__ =
      url
  } catch {}
}

/** Provides MonitorClient context with automatic reconnection. */
export function MonitorClientContextProvider({ children }) {
  const [wsUrl, setWsUrl] = useState(
    /** @type {string | undefined} */ (undefined)
  )
  const [httpBaseUrl, setHttpBaseUrl] = useState(
    /** @type {string | undefined} */ (undefined)
  )
  const [connectionMode, setConnectionMode] = useState(
    /** @type {'pending' | 'messenger' | 'direct'} */ ('pending')
  )
  const httpBaseUrlRef = useRef(/** @type {string | undefined} */ (undefined))

  useEffect(() => {
    let disposed = false
    const messenger = vscode.messenger
    const applyFallback = () => {
      if (disposed) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = window.location.hostname
      const params = new URLSearchParams(window.location.search)
      const bridgePort = params.get('bridgeport') ?? undefined
      if (!bridgePort) return
      const ws = `${protocol}//${host}:${bridgePort}/serial`
      const httpProtocol = protocol === 'wss:' ? 'https:' : 'http:'
      const base = `${httpProtocol}//${host}:${bridgePort}`
      httpBaseUrlRef.current = base
      setHttpBaseUrl(base)
      setGlobalHttpBase(base)
      setWsUrl(ws)
      setConnectionMode('direct')
    }
    if (!messenger) {
      applyFallback()
      return undefined
    }
    messenger
      .sendRequest(getMonitorBridgeInfo, HOST_EXTENSION)
      .then((info) => {
        if (disposed) return
        if (!info?.wsUrl) {
          applyFallback()
          return
        }
        httpBaseUrlRef.current = info.httpBaseUrl
        setHttpBaseUrl(info.httpBaseUrl)
        if (info.httpBaseUrl) {
          setGlobalHttpBase(info.httpBaseUrl)
        }
        setWsUrl(info.wsUrl)
        setConnectionMode('messenger')
      })
      .catch((error) => {
        console.error('Failed to resolve monitor bridge info', error)
        applyFallback()
      })
    return () => {
      disposed = true
    }
  }, [])

  const [client, setClient] = useState(
    /** @type {MonitorClient | undefined} */ (undefined)
  )
  const [connectionStatus, setConnectionStatus] = useState(
    /** @type {import('./MonitorClientContext.js').MonitorClientContextType['connectionStatus']} */ (
      'disconnected'
    )
  )

  const wsRef = useRef(/** @type {WebSocket | undefined} */ (undefined))
  const retryRef = useRef(0)
  const reconnectTimerRef = useRef(/** @type {any} */ (undefined))
  const isConnectingRef = useRef(false)
  const messageConnRef = useRef(
    /** @type {import('vscode-jsonrpc').MessageConnection | undefined} */ (
      undefined
    )
  )
  const onCloseDisposableRef = useRef(
    /** @type {import('vscode-jsonrpc').Disposable | undefined} */ (undefined)
  )
  const onErrorDisposableRef = useRef(
    /** @type {import('vscode-jsonrpc').Disposable | undefined} */ (undefined)
  )
  const didConnectRef = useRef(false)

  useEffect(() => {
    const messenger = vscode.messenger
    if (connectionMode !== 'messenger') {
      return
    }
    if (!messenger || !httpBaseUrl) {
      return
    }

    setConnectionStatus('connecting')
    const monitorClient = new MonitorClient({
      messenger,
      httpBaseUrl,
    })
    setClient(monitorClient)
    setConnectionStatus('connected')

    return () => {
      setConnectionStatus('disconnecting')
      Promise.resolve(monitorClient.dispose()).catch((error) => {
        console.error('Failed to dispose monitor client', error)
      })
      setClient(undefined)
      setConnectionStatus('disconnected')
    }
  }, [httpBaseUrl, connectionMode])

  const dispose = useCallback(() => {
    if (messageConnRef.current) {
      messageConnRef.current.dispose()
      messageConnRef.current = undefined
    }

    onCloseDisposableRef.current?.dispose()
    onCloseDisposableRef.current = undefined

    onErrorDisposableRef.current?.dispose()
    onErrorDisposableRef.current = undefined

    setClient((previous) => {
      if (previous) {
        Promise.resolve(previous.dispose()).catch((error) => {
          console.error('Failed to dispose monitor client', error)
        })
      }
      return undefined
    })

    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = undefined
    }

    setConnectionStatus('disconnected')
    didConnectRef.current = false
  }, [])

  const connect = useCallback(() => {
    if (connectionMode !== 'direct') {
      return
    }
    if (didConnectRef.current || isConnectingRef.current || !wsUrl) return

    const socket = new WebSocket(wsUrl)
    wsRef.current = socket
    setConnectionStatus('connecting')
    isConnectingRef.current = true

    const scheduleReconnect = () => {
      // Already scheduled
      if (reconnectTimerRef.current) return

      retryRef.current += 1
      const backoff = Math.min(1000 * Math.pow(2, retryRef.current), 5000)
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = undefined
        connect()
      }, backoff)
    }

    socket.onerror = (err) => {
      console.error('WebSocket onerror:', err)
      // Treat errors like closes to ensure we keep retrying when server starts later
      isConnectingRef.current = false
      dispose()
      scheduleReconnect()
    }

    socket.onclose = () => {
      isConnectingRef.current = false
      dispose()
      scheduleReconnect()
    }

    socket.onopen = () => {
      retryRef.current = 0
      didConnectRef.current = true
      isConnectingRef.current = false
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = undefined
      }
      setConnectionStatus('connected')

      const socketAdapter = toSocket(socket)
      const connection = createWebSocketConnection(
        socketAdapter,
        new ConsoleLogger()
      )

      const onCloseDisposable = connection.onClose(() => {
        dispose()
        scheduleReconnect()
      })

      const onErrorDisposable = connection.onError((error) => {
        console.error('WebSocket error:', error)
        dispose()
        scheduleReconnect()
      })

      connection.listen()
      messageConnRef.current = connection
      onCloseDisposableRef.current = onCloseDisposable
      onErrorDisposableRef.current = onErrorDisposable

      setClient((previous) => {
        if (previous) {
          Promise.resolve(previous.dispose()).catch((error) => {
            console.error('Failed to dispose monitor client', error)
          })
        }
        return new MonitorClient({
          connection: Object.assign(connection, { url: new URL(socket.url) }),
          httpBaseUrl: httpBaseUrlRef.current,
        })
      })
    }
  }, [wsUrl, dispose, connectionMode])

  useEffect(() => {
    if (connectionMode !== 'direct') {
      return undefined
    }
    connect()
    return () => {
      dispose()
    }
  }, [connect, dispose, connectionMode])

  return (
    <MonitorClientContext.Provider
      value={{
        client,
        connectionStatus,
        wsUrl,
        httpBaseUrl: httpBaseUrl ?? httpBaseUrlRef.current,
      }}
    >
      {children}
    </MonitorClientContext.Provider>
  )
}
