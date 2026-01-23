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
 * @typedef {'idle' | 'pending' | 'connected' | 'suspended' | 'error'} MonitorViewStatus
 *
 *
 * @typedef {{
 *   session?: import('@boardlab/protocol').MonitorSessionState
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
  const selectedPort = state.selectedPort
  const detectedPorts = state.detectedPorts ?? {}
  const hasDetectionSnapshot = Object.keys(detectedPorts).length > 0
  const selectedKey = selectedPort ? createPortKey(selectedPort) : undefined
  const selectedDetected = selectedKey
    ? Object.values(detectedPorts).some(
        ({ port }) => createPortKey(port) === selectedKey
      )
    : false
  const session = selectedKey ? state.sessionStates?.[selectedKey] : undefined
  const desired = session?.desired ?? 'stopped'
  const viewDesired = state.autoPlay ? desired : 'stopped'
  const started = viewDesired === 'running' && !!selectedPort

  /** @type {MonitorViewStatus} */
  let status = 'idle'

  if (session) {
    switch (session.status) {
      case 'connecting':
        status = 'pending'
        break
      case 'active':
        status = 'connected'
        break
      case 'paused':
        if (session.pauseReason === 'user') {
          status = started ? 'pending' : 'idle'
        } else {
          status = 'suspended'
        }
        break
      case 'error':
        status = 'error'
        break
      default:
        status = 'idle'
        break
    }
  }

  if (!state.autoPlay) {
    status = 'idle'
  }

  if (selectedPort && hasDetectionSnapshot && !selectedDetected) {
    status = viewDesired === 'running' ? 'suspended' : status
  }

  return {
    session,
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
