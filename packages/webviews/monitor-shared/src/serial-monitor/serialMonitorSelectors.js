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

/**
 * @type {(state: {
 *   serialMonitor: import('./serialMonitorSlice.js').SerialMonitorState
 * }) => import('./monitorFsm.js').MonitorContext}
 */
export const selectMonitorMachine = (state) => state.serialMonitor.machine

/**
 * @type {(state: {
 *   serialMonitor: import('./serialMonitorSlice.js').SerialMonitorState
 * }) => import('@boardlab/protocol').MonitorPhysicalState[]}
 */
export const selectPhysicalStates = (state) =>
  state.serialMonitor.physicalStates
