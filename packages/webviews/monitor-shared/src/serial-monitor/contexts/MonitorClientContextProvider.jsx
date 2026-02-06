// @ts-check
import { useEffect, useState } from 'react'
import { HOST_EXTENSION } from 'vscode-messenger-common'

import { vscode } from '@boardlab/base'
import { getMonitorBridgeInfo } from '@boardlab/protocol'

import { MonitorClient } from '../client.js'
import { MonitorClientContext } from './MonitorClientContext.js'

/** Provides MonitorClient context with automatic reconnection. */
export function MonitorClientContextProvider({ children }) {
  const [wsUrl, setWsUrl] = useState(
    /** @type {string | undefined} */ (undefined)
  )
  const [httpBaseUrl, setHttpBaseUrl] = useState(
    /** @type {string | undefined} */ (undefined)
  )

  const [client, setClient] = useState(
    /** @type {MonitorClient | undefined} */ (undefined)
  )
  const [connectionStatus, setConnectionStatus] = useState(
    /** @type {import('./MonitorClientContext.js').MonitorClientContextType['connectionStatus']} */ (
      'disconnected'
    )
  )

  useEffect(() => {
    let disposed = false
    const messenger = vscode.messenger
    if (!messenger) {
      console.error('Monitor client requires VS Code messenger')
      setConnectionStatus('disconnected')
      return undefined
    }

    setConnectionStatus('connecting')
    messenger
      .sendRequest(getMonitorBridgeInfo, HOST_EXTENSION)
      .then((info) => {
        if (disposed) return
        if (!info?.httpBaseUrl) {
          console.error('Monitor bridge info missing httpBaseUrl')
          setConnectionStatus('disconnected')
          return
        }
        setHttpBaseUrl(info.httpBaseUrl)
        setWsUrl(info.wsUrl)
        const monitorClient = new MonitorClient({
          messenger,
          httpBaseUrl: info.httpBaseUrl,
        })
        setClient(monitorClient)
        setConnectionStatus('connected')
      })
      .catch((error) => {
        console.error('Failed to resolve monitor bridge info', error)
        setConnectionStatus('disconnected')
      })

    return () => {
      disposed = true
      setConnectionStatus('disconnecting')
      setClient((previous) => {
        if (previous) {
          Promise.resolve(previous.dispose()).catch((error) => {
            console.error('Failed to dispose monitor client', error)
          })
        }
        return undefined
      })
      setConnectionStatus('disconnected')
    }
  }, [])

  return (
    <MonitorClientContext.Provider
      value={{
        client,
        connectionStatus,
        wsUrl,
        httpBaseUrl,
      }}
    >
      {children}
    </MonitorClientContext.Provider>
  )
}
