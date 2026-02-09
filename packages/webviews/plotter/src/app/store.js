// @ts-check
import { configureStore } from '@reduxjs/toolkit'

import connectionReducer from '@boardlab/monitor-shared/connection'
import { serialMonitorReducer } from '@boardlab/monitor-shared/serial-monitor'

import plotterReducer from '../features/plotter/plotterSlice.js'
import {
  getPersistedState,
  updatePersistentState,
} from '../state/persistence.js'

const baseConnectionState = connectionReducer(undefined, { type: '@@INIT' })
const baseSerialMonitorState = serialMonitorReducer(undefined, {
  type: '@@INIT',
})
const basePlotterState = plotterReducer(undefined, { type: '@@INIT' })

const persistedState = (() => {
  const state = getPersistedState()
  if (state) {
    const persistedSerial = /** @type {any} */ (state.serialMonitor) ?? {}
    return {
      connection: {
        ...baseConnectionState,
        .../** @type {any} */ (state.connection),
      },
      serialMonitor: {
        ...baseSerialMonitorState,
        selectedPort: persistedSerial.selectedPort,
        selectedBaudrates:
          persistedSerial.selectedBaudrates ??
          baseSerialMonitorState.selectedBaudrates,
        autoPlay:
          typeof persistedSerial.autoPlay === 'boolean'
            ? persistedSerial.autoPlay
            : baseSerialMonitorState.autoPlay,
      },
      plotter: {
        ...basePlotterState,
        .../** @type {any} */ (state.plotter),
      },
    }
  }
  return undefined
})()

export const store = configureStore({
  reducer: {
    connection: connectionReducer,
    serialMonitor: serialMonitorReducer,
    plotter: plotterReducer,
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
    },
    plotter: {
      maxPoints: state.plotter.maxPoints,
    },
  })
})

/**
 * @typedef {ReturnType<typeof store.getState>} RootState
 *
 * @typedef {typeof store.dispatch} AppDispatch
 */
