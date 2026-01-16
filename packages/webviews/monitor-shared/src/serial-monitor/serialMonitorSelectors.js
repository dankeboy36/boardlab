// @ts-check
import { createSelector } from '@reduxjs/toolkit'
import { createPortKey } from 'boards-list'

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
 * @typedef {'idle' | 'pending' | 'connected' | 'suspended' | 'error'} MonitorViewStatus
 *
 *
 * @typedef {{
 *   machine: import('./monitorFsm.js').MonitorContext
 *   started: boolean
 *   status: MonitorViewStatus
 *   selectedPort?: import('boards-list').PortIdentifier
 *   selectedDetected: boolean
 *   hasDetectionSnapshot: boolean
 * }} MonitorViewState
 */

/**
 * @type {(state: {
 *   serialMonitor: import('./serialMonitorSlice.js').SerialMonitorState
 * }) => MonitorViewState}
 */
export const selectMonitorView = createSelector(selectSerialMonitor, (state) =>
  projectMonitorView(state)
)

/**
 * Compute a UI-friendly projection of the monitor FSM + detection snapshot.
 *
 * @param {import('./serialMonitorSlice.js').SerialMonitorState} state
 * @returns {MonitorViewState}
 */
export function projectMonitorView(state) {
  const machine = state.machine
  const logical = machine?.logical ?? { kind: 'idle' }
  const desired = machine?.desired ?? 'stopped'
  const selectedPort = machine?.selectedPort ?? state.selectedPort
  const detectedPorts = state.detectedPorts ?? {}
  const hasDetectionSnapshot = Object.keys(detectedPorts).length > 0
  const selectedKey = selectedPort ? createPortKey(selectedPort) : undefined
  const selectedDetected = selectedKey
    ? Object.values(detectedPorts).some(
        ({ port }) => createPortKey(port) === selectedKey
      )
    : false

  const started = desired === 'running' && !!selectedPort

  /** @type {MonitorViewStatus} */
  let status = 'idle'
  switch (logical.kind) {
    case 'waitingForPort':
      status =
        logical.reason === 'port-temporarily-missing' ? 'suspended' : 'pending'
      break
    case 'connecting':
      status = 'pending'
      break
    case 'active':
      status = 'connected'
      break
    case 'paused':
      if (logical.reason === 'suspend') {
        status = 'suspended'
      } else if (logical.reason === 'resource-missing') {
        status = 'suspended'
      } else if (logical.reason === 'resource-busy') {
        status = started ? 'pending' : 'idle'
      } else {
        status = started ? 'pending' : 'idle'
      }
      break
    case 'error':
      status = 'error'
      break
    case 'closed':
      status = 'idle'
      break
    default:
      status = 'idle'
      break
  }

  return {
    machine,
    started,
    status,
    selectedPort,
    selectedDetected,
    hasDetectionSnapshot,
  }
}

/**
 * @type {(state: {
 *   serialMonitor: import('./serialMonitorSlice.js').SerialMonitorState
 * }) => import('@boardlab/protocol').MonitorPhysicalState[]}
 */
export const selectPhysicalStates = (state) =>
  state.serialMonitor.physicalStates
