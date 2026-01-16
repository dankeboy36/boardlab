// @ts-check
import { configureStore } from '@reduxjs/toolkit'

import connectionReducer from '@boardlab/monitor-shared/connection'
import serialMonitorReducer from '@boardlab/monitor-shared/serial-monitor'

import terminalSettingsReducer from '../features/terminal/terminalSettingsSlice.js'
import {
  getPersistedState,
  updatePersistentState,
} from '../state/persistence.js'

const baseConnectionState = connectionReducer(undefined, { type: '@@INIT' })
const baseSerialMonitorState = serialMonitorReducer(undefined, {
  type: '@@INIT',
})
const baseTerminalSettingsState = terminalSettingsReducer(undefined, {
  type: '@@INIT',
})

const persistedState = (() => {
  const state = getPersistedState()
  if (state) {
    return {
      connection: {
        ...baseConnectionState,
        .../** @type {any} */ (state.connection),
      },
      serialMonitor: {
        ...baseSerialMonitorState,
        .../** @type {any} */ (state.serialMonitor),
      },
      terminalSettings: {
        ...baseTerminalSettingsState,
        .../** @type {any} */ (state.terminalSettings),
      },
    }
  }
  return undefined
})()

export const store = configureStore({
  reducer: {
    connection: connectionReducer,
    serialMonitor: serialMonitorReducer,
    terminalSettings: terminalSettingsReducer,
  },
  preloadedState: persistedState,
})

store.subscribe(() => {
  const state = store.getState()
  updatePersistentState({
    connection: {
      clientId: state.connection.clientId,
      connectionStatus: state.connection.connectionStatus,
      wsUrl: state.connection.wsUrl,
    },
    serialMonitor: {
      selectedPort: state.serialMonitor.selectedPort,
      selectedBaudrates: state.serialMonitor.selectedBaudrates,
      autoPlay: state.serialMonitor.autoPlay,
      machine: state.serialMonitor.machine,
    },
    terminalSettings: state.terminalSettings,
  })
})

/**
 * @typedef {ReturnType<typeof store.getState>} RootState
 *
 * @typedef {typeof store.dispatch} AppDispatch
 */
