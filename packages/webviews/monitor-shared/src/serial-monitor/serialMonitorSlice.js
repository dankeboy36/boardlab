// @ts-check

import { createSlice } from '@reduxjs/toolkit'
import { createBoardsList, createPortKey } from 'boards-list'

/**
 * @typedef {Object} LocalSerialMonitorState
 * @property {import('boards-list').PortIdentifier | undefined} selectedPort
 * @property {boolean} autoPlay
 * @property {import('@boardlab/protocol').MonitorPhysicalState[]} physicalStates
 * @property {Record<string, import('@boardlab/protocol').MonitorSessionState>}
 *   sessionStates
 */

/**
 * @typedef {Object} SharedSerialMonitorState
 * @property {string[]} supportedBaudrates
 * @property {import('@boardlab/protocol').MonitorSettingsByProtocol} monitorSettingsByProtocol
 * @property {[port: import('boards-list').PortIdentifier, baudrate: string][]} selectedBaudrates
 * @property {import('boards-list').DetectedPorts} detectedPorts
 * @property {ReadonlyArray<
 *   Omit<
 *     import('boards-list').BoardsListItem,
 *     'defaultAction' | 'otherActions'
 *   >
 * >} boardsListItems
 * @property {ReadonlyArray<import('boards-list').DetectedPort>} boardsListPorts
 */

/** @typedef {LocalSerialMonitorState & SharedSerialMonitorState} SerialMonitorState */

/**
 * @typedef {Object} ConnectAction
 * @property {'CONNECT'} type
 * @property {import('@boardlab/protocol').HostConnectClientResult} payload
 */

/**
 * @typedef {Object} SetSelectedPortAction
 * @property {'SET_SELECTED_PORT'} type
 * @property {import('boards-list').PortIdentifier | undefined} payload
 */

/**
 * @typedef {Object} SetSelectedBaudrateAction
 * @property {'SET_SELECTED_BAUDRATE'} type
 * @property {{ port: import('boards-list').PortIdentifier; baudrate: string }} payload
 */

/**
 * @typedef {Object} MergeSelectedBaudrateAction
 * @property {'MERGE_SELECTED_BAUDRATE'} type
 * @property {{ port: import('boards-list').PortIdentifier; baudrate: string }} payload
 */

/**
 * @typedef {Object} UpdateDetectedPortsAction
 * @property {'UPDATE_DETECTED_PORTS'} type
 * @property {import('boards-list').DetectedPorts} payload
 */

/**
 * @typedef {Object} DisconnectAction
 * @property {'DISCONNECT'} type
 */

/**
/**
 * @typedef {Object} SetPhysicalStatesAction
 * @property {'SET_PHYSICAL_STATES'} type
 * @property {import('@boardlab/protocol').MonitorPhysicalState[]} payload
 */

/**
 * @typedef {Object} UpsertPhysicalStateAction
 * @property {'UPSERT_PHYSICAL_STATE'} type
 * @property {import('@boardlab/protocol').MonitorPhysicalState} payload
 */

/**
 * @typedef {Object} SetSessionStatesAction
 * @property {'SET_SESSION_STATES'} type
 * @property {ReadonlyArray<import('@boardlab/protocol').MonitorSessionState>} payload
 */

/**
 * @typedef {Object} UpsertSessionStateAction
 * @property {'UPSERT_SESSION_STATE'} type
 * @property {import('@boardlab/protocol').MonitorSessionState} payload
 */

/**
 * @typedef {ConnectAction
 *   | SetSelectedPortAction
 *   | SetSelectedBaudrateAction
 *   | MergeSelectedBaudrateAction
 *   | UpdateDetectedPortsAction
 *   | DisconnectAction
 *   | SetPhysicalStatesAction
 *   | UpsertPhysicalStateAction
 *   | SetSessionStatesAction
 *   | UpsertSessionStateAction} SerialMonitorAction
 */

/**
 * @param {SerialMonitorState} state
 * @param {SerialMonitorAction} action
 * @returns {SerialMonitorState}
 */

/** @type {SerialMonitorState} */
const initialState = {
  detectedPorts: {},
  supportedBaudrates: [],
  monitorSettingsByProtocol: { protocols: {} },
  selectedPort: undefined,
  selectedBaudrates: [],
  boardsListItems: [],
  boardsListPorts: [],
  autoPlay: true,
  physicalStates: [],
  sessionStates: {},
}

const serialMonitorSlice = createSlice({
  name: 'serialMonitor',
  initialState,
  reducers: {
    connect(state, action) {
      const {
        detectedPorts,
        monitorSettingsByProtocol,
        selectedBaudrates,
        physicalStates,
      } = action.payload
      state.detectedPorts = detectedPorts
      state.monitorSettingsByProtocol = monitorSettingsByProtocol
      state.selectedBaudrates = selectedBaudrates
      state.physicalStates = Array.isArray(physicalStates) ? physicalStates : []
      state.sessionStates = Array.isArray(action.payload.sessionStates)
        ? Object.fromEntries(
            action.payload.sessionStates.map((entry) => [
              entry.portKey,
              entry,
            ])
          )
        : {}
      // Recompute supported baudrates for the current selection
      state.supportedBaudrates = computeSupportedBaudrates(state)
    },
    setSelectedPort(state, action) {
      const selectedPort = action.payload
      const prevSelectedPort = state.selectedPort
      state.selectedPort = selectedPort

      if (selectedPort) {
        // Drop any previous selection for a different port
        if (prevSelectedPort) {
          state.selectedBaudrates = state.selectedBaudrates.filter(
            ([port]) => createPortKey(port) !== createPortKey(prevSelectedPort)
          )
        }
        // Only set a baudrate if discovered for the protocol
        const discovered = computeProtocolBaudrateOptions(
          state.monitorSettingsByProtocol,
          selectedPort.protocol
        )
        if (discovered?.values?.length) {
          const existing = state.selectedBaudrates.find(
            ([port]) => createPortKey(port) === createPortKey(selectedPort)
          )?.[1]
          const fallback = discovered.default ?? discovered.values[0]
          state.selectedBaudrates = state.selectedBaudrates.filter(
            ([p]) => createPortKey(p) !== createPortKey(selectedPort)
          )
          state.selectedBaudrates.push([selectedPort, existing ?? fallback])
        }
      } else if (prevSelectedPort) {
        state.selectedBaudrates = state.selectedBaudrates.filter(
          ([port]) => createPortKey(port) !== createPortKey(prevSelectedPort)
        )
      }

      // Update supported baudrates view
      state.supportedBaudrates = computeSupportedBaudrates(state)
    },
    setSelectedBaudrate(state, action) {
      const { port, baudrate } = action.payload
      const key = createPortKey(port)
      state.selectedBaudrates = state.selectedBaudrates.filter(
        ([p]) => createPortKey(p) !== key
      )
      state.selectedBaudrates.push([port, baudrate])
    },
    mergeSelectedBaudrate(state, action) {
      const { port, baudrate } = action.payload
      const key = createPortKey(port)
      state.selectedBaudrates = state.selectedBaudrates.filter(
        ([p]) => createPortKey(p) !== key
      )
      state.selectedBaudrates.push([port, baudrate])
    },
    updateDetectedPorts(state, action) {
      // Treat payload as a full snapshot, not a diff — replace instead of merge.
      state.detectedPorts = action.payload

      // Recompute a stable boards list snapshot for UI (pure data: items + ports)
      const list = createBoardsList(state.detectedPorts, {
        selectedPort: state.selectedPort,
        selectedBoard: undefined,
      })

      // Snapshot arrays to avoid exposing methods
      state.boardsListPorts = [...list.ports()]

      // Drop imperative actions; keep only data needed for UI
      state.boardsListItems = list.items.map((item) => {
        const anyItem = /** @type {any} */ (item)
        const rest = { ...anyItem }
        delete rest.defaultAction
        delete rest.otherActions
        return rest
      })
    },
    setMonitorSettingsByProtocol(state, action) {
      state.monitorSettingsByProtocol = action.payload
      // Refresh supported baudrates for current selection
      state.supportedBaudrates = computeSupportedBaudrates(state)
      // If a port is selected but has no discovered baudrate yet, drop its selection to prevent auto-start
      if (state.selectedPort) {
        const discovered = computeProtocolBaudrateOptions(
          state.monitorSettingsByProtocol,
          state.selectedPort.protocol
        )
        const hasOptions = !!discovered?.values?.length
        if (!hasOptions) {
          state.selectedBaudrates = state.selectedBaudrates.filter(
            ([port]) =>
              createPortKey(port) !== createPortKey(state.selectedPort)
          )
        } else {
          // Ensure a baudrate is set for the selected port if missing
          const exists = state.selectedBaudrates.find(
            ([port]) =>
              createPortKey(port) === createPortKey(state.selectedPort)
          )
          if (!exists) {
            state.selectedBaudrates.push([
              state.selectedPort,
              discovered.default ?? discovered.values[0],
            ])
          }
        }
      }
    },
    disconnect() {
      return initialState
    },
    setAutoPlay(state, action) {
      state.autoPlay = !!action.payload
    },
    setPhysicalStates(state, action) {
      state.physicalStates = Array.isArray(action.payload) ? action.payload : []
    },
    upsertPhysicalState(state, action) {
      const incoming = action.payload
      if (!incoming?.port) return
      const key = createPortKey(incoming.port)
      state.physicalStates = [
        ...state.physicalStates.filter(
          (entry) => createPortKey(entry.port) !== key
        ),
        incoming,
      ]
    },
    setSessionStates(state, action) {
      const entries = Array.isArray(action.payload) ? action.payload : []
      state.sessionStates = Object.fromEntries(
        entries.map((entry) => [entry.portKey, entry])
      )
    },
    upsertSessionState(state, action) {
      const incoming = action.payload
      if (!incoming?.portKey) return
      state.sessionStates = {
        ...state.sessionStates,
        [incoming.portKey]: incoming,
      }
    },
  },
})

/** @typedef {typeof serialMonitorSlice.actions} SerialMonitorActions */

/** @type {SerialMonitorActions} */
const actions = serialMonitorSlice.actions

export const {
  connect,
  setSelectedPort,
  setSelectedBaudrate,
  mergeSelectedBaudrate,
  updateDetectedPorts,
  disconnect,
  setMonitorSettingsByProtocol,
  setAutoPlay,
  setPhysicalStates,
  upsertPhysicalState,
  setSessionStates,
  upsertSessionState,
} = actions

export default serialMonitorSlice.reducer

/** @param {import('./serialMonitorSlice').SerialMonitorState} state */
function computeSupportedBaudrates(state) {
  const selectedPort = state.selectedPort
  if (!selectedPort) return []
  const info = computeProtocolBaudrateOptions(
    state.monitorSettingsByProtocol,
    selectedPort.protocol
  )
  return info?.values ?? []
}

/**
 * @param {import('@boardlab/protocol').MonitorSettingsByProtocol} monitorSettingsByProtocol
 * @param {string} protocol
 * @returns {{ values: string[]; default?: string } | undefined}
 */
function computeProtocolBaudrateOptions(monitorSettingsByProtocol, protocol) {
  const entry = monitorSettingsByProtocol?.protocols?.[protocol]
  if (!entry || entry.error) return undefined
  const settings = entry.settings || []
  const baud = settings.find((s) => s.settingId === 'baudrate')
  if (!baud) return undefined
  const values = Array.isArray(baud.enumValues)
    ? baud.enumValues.map(String)
    : []
  const def = typeof baud.value === 'string' ? baud.value : undefined
  return { values, default: def }
}

// Monitor view derives status from host session state.
