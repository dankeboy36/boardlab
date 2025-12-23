// @ts-check

import { useEffect } from 'react'
import { useDispatch } from 'react-redux'

import {
  setClientId,
  setConnectionStatus,
  setWsUrl,
} from '../connection/connectionSlice.js'
import { usePortinoClient } from './usePortinoClient.js'

export function usePortinoClientSync() {
  const { client, connectionStatus, wsUrl } = usePortinoClient()
  const dispatch = useDispatch()

  useEffect(() => {
    dispatch(setClientId(client?.id))
    dispatch(setConnectionStatus(connectionStatus))
    dispatch(setWsUrl(wsUrl))
  }, [client, connectionStatus, wsUrl, dispatch])

  return { client, connectionStatus, wsUrl }
}
