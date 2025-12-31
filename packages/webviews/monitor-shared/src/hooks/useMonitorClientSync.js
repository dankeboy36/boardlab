// @ts-check

import { useEffect } from 'react'
import { useDispatch } from 'react-redux'

import {
  setClientId,
  setConnectionStatus,
  setWsUrl,
} from '../connection/connectionSlice.js'
import { useMonitorClient } from './useMonitorClient.js'

export function useMonitorClientSync() {
  const { client, connectionStatus, wsUrl } = useMonitorClient()
  const dispatch = useDispatch()

  useEffect(() => {
    dispatch(setClientId(client?.id))
    dispatch(setConnectionStatus(connectionStatus))
    dispatch(setWsUrl(wsUrl))
  }, [client, connectionStatus, wsUrl, dispatch])

  return { client, connectionStatus, wsUrl }
}
