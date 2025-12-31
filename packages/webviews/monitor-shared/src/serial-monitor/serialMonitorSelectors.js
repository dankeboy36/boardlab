// @ts-check
import { createSelector } from '@reduxjs/toolkit'

/**
 * @type {(state: {
 *   serialMonitor: import('./serialMonitorSlice.js').SerialMonitorState
 * }) => import('./serialMonitorSlice.js').SerialMonitorState}
 */
export const selectSerialMonitor = (state) => state.serialMonitor

// Memoized view of boards list snapshot to avoid returning new object instances
export const selectBoardsList = createSelector(
  (state) => state.serialMonitor.boardsListItems,
  (state) => state.serialMonitor.boardsListPorts,
  (boardsListItems, ports) => ({ boardsListItems, ports })
)

/**
 * @type {(state: {
 *   serialMonitor: import('./serialMonitorSlice.js').SerialMonitorState
 * }) => string[]}
 */
export const selectSuspendedPortKeys = (state) =>
  state.serialMonitor.suspendedPortKeys
