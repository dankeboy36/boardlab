// @ts-check

import { createSlice } from '@reduxjs/toolkit'

/**
 * @typedef {Omit<
 *   import('../serial-monitor/contexts/MonitorClientContext').MonitorClientContextType,
 *   'client'
 * > & { clientId?: string }} ConnectionState
 */

/** @type {ConnectionState} */
const initialState = {
  clientId: undefined,
  connectionStatus: 'disconnected',
  wsUrl: undefined,
}

const connectionSlice = createSlice({
  name: 'connection',
  initialState,
  reducers: {
    setClientId: (state, action) => {
      state.clientId = action.payload
    },
    setConnectionStatus: (state, action) => {
      state.connectionStatus = action.payload
    },
    setWsUrl: (state, action) => {
      state.wsUrl = action.payload
    },
  },
})

/** @typedef {typeof connectionSlice.actions} ConnectionActions */

/** @type {ConnectionActions} */
const actions = connectionSlice.actions

export const { setClientId, setConnectionStatus, setWsUrl } = actions

export default connectionSlice.reducer
