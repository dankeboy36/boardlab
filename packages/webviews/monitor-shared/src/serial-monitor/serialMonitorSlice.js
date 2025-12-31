// @ts-check

import { createSlice } from '@reduxjs/toolkit'
import { createBoardsList, createPortKey } from 'boards-list'

/** @typedef {'idle' | 'pending' | 'connected' | 'suspended' | 'error'} MonitorStatus */

/**
 * @typedef {Object} LocalSerialMonitorState
 * @property {import('boards-list').PortIdentifier | undefined} selectedPort
 * @property {boolean} started
 * @property {boolean} autoPlay
 * @property {MonitorStatus} status
 * @property {string} [error]
 * @property {string[]} suspendedPortKeys
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
 * @typedef {Object} StartMonitorAction
 * @property {'START_MONITOR'} type
 */

/**
 * @typedef {Object} StopMonitorAction
 * @property {'STOP_MONITOR'} type
 */

/**
 * @typedef {ConnectAction
 *   | SetSelectedPortAction
 *   | SetSelectedBaudrateAction
 *   | MergeSelectedBaudrateAction
 *   | UpdateDetectedPortsAction
 *   | DisconnectAction
 *   | StartMonitorAction
 *   | StopMonitorAction} SerialMonitorAction
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
  started: false,
  status: 'idle',
  boardsListItems: [],
  boardsListPorts: [],
  suspendedPortKeys: [],
  autoPlay: true,
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
        suspendedPortKeys,
        runningMonitors,
      } = action.payload
      const runningEntries = Array.isArray(runningMonitors)
        ? runningMonitors
        : []
      const runningKeys = new Set(
        runningEntries.map(({ port }) => createPortKey(port))
      )
      state.detectedPorts = detectedPorts
      state.monitorSettingsByProtocol = monitorSettingsByProtocol
      state.selectedBaudrates = selectedBaudrates
      state.started = false
      const filteredSuspended = Array.isArray(suspendedPortKeys)
        ? suspendedPortKeys.filter((key) => runningKeys.has(key))
        : []
      state.suspendedPortKeys = filteredSuspended
      state.status = 'idle'
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

      // Reflect suspension in status for the selected port
      if (state.selectedPort) {
        const selKey = createPortKey(state.selectedPort)
        if (state.suspendedPortKeys.includes(selKey)) {
          state.status = 'suspended'
        } else {
          state.status = state.started ? 'connected' : 'idle'
        }
      } else {
        state.status = 'idle'
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
    startMonitor(state) {
      state.started = true
      state.autoPlay = true
      if (state.selectedPort) {
        const selKey = createPortKey(state.selectedPort)
        state.suspendedPortKeys = state.suspendedPortKeys.filter(
          (key) => key !== selKey
        )
        state.status = state.suspendedPortKeys.includes(selKey)
          ? 'suspended'
          : 'connected'
      } else {
        state.status = 'connected'
      }
    },
    stopMonitor(state) {
      state.started = false
      if (state.selectedPort) {
        const selKey = createPortKey(state.selectedPort)
        state.suspendedPortKeys = state.suspendedPortKeys.filter(
          (key) => key !== selKey
        )
      } else {
        state.suspendedPortKeys = []
      }
      state.status = 'idle'
    },
    setAutoPlay(state, action) {
      state.autoPlay = !!action.payload
    },
    /**
     * @param {SerialMonitorState} state
     * @param {{
     *   payload: import('@boardlab/protocol').DidPauseMonitorNotification
     * }} action
     */
    pauseMonitor(state, action) {
      const evt = action.payload
      const evtKey = createPortKey(evt.port)

      if (!state.started) {
        state.suspendedPortKeys = state.suspendedPortKeys.filter(
          (key) => key !== evtKey
        )
        if (
          state.selectedPort &&
          createPortKey(state.selectedPort) === evtKey
        ) {
          state.status = 'idle'
        }
        return
      }

      if (!state.suspendedPortKeys.includes(evtKey)) {
        state.suspendedPortKeys.push(evtKey)
      }
      if (state.selectedPort) {
        const selKey = createPortKey(state.selectedPort)
        if (selKey === evtKey) {
          state.status = 'suspended'
        }
      }
    },
    /**
     * @param {SerialMonitorState} state
     * @param {{
     *   payload: import('@boardlab/protocol').DidResumeMonitorNotification
     * }} action
     */
    resumeMonitor(state, action) {
      const evt = action.payload

      if (!state.selectedPort) {
        state.status = state.started ? 'connected' : 'idle'
        return
      }

      const pausedKey = createPortKey(evt.didPauseOnPort)

      // Clear suspension for the paused port
      state.suspendedPortKeys = state.suspendedPortKeys.filter(
        (k) => k !== pausedKey
      )
      // If the device reappeared on a new port, ensure that new port is not considered suspended
      const resumedKeyMaybe = evt.didResumeOnPort
        ? createPortKey(evt.didResumeOnPort)
        : null
      if (resumedKeyMaybe) {
        state.suspendedPortKeys = state.suspendedPortKeys.filter(
          (k) => k !== resumedKeyMaybe
        )
      }

      const selectedKey = createPortKey(state.selectedPort)

      // Only react if this resume corresponds to our current selection
      if (pausedKey !== selectedKey) {
        return
      }

      // If upload made the board reappear on a different address, switch selection.
      if (evt.didResumeOnPort) {
        const resumedKey = createPortKey(evt.didResumeOnPort)
        if (resumedKey !== selectedKey) {
          // Preserve previously selected baudrate for the old key
          const prev = state.selectedBaudrates.find(
            ([p]) => createPortKey(p) === selectedKey
          )
          const prevBaud = prev ? prev[1] : undefined

          // Drop old/new mappings
          state.selectedBaudrates = state.selectedBaudrates.filter(([p]) => {
            const k = createPortKey(p)
            return k !== selectedKey && k !== resumedKey
          })

          // Switch the selected port
          state.selectedPort = evt.didResumeOnPort

          // Re-attach saved baudrate (if any) to the new key
          if (prevBaud) {
            state.selectedBaudrates.push([evt.didResumeOnPort, prevBaud])
          }
        }
      }

      // Determine status for the (potentially) new selection
      if (state.selectedPort) {
        const selKeyNow = createPortKey(state.selectedPort)
        state.status = state.suspendedPortKeys.includes(selKeyNow)
          ? 'suspended'
          : state.started
            ? 'connected'
            : 'idle'
      } else {
        state.status = state.started ? 'connected' : 'idle'
      }
      // Refresh supported baudrates for the (potentially) new selection
      state.supportedBaudrates = computeSupportedBaudrates(state)
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
  startMonitor,
  stopMonitor,
  setMonitorSettingsByProtocol,
  pauseMonitor,
  resumeMonitor,
  setAutoPlay,
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

/**
 * @param {import('./serialMonitorSlice').SerialMonitorState} state
 * @param {import('boards-list').PortIdentifier} port
 */
export function isPortSuspended(state, port) {
  const key = createPortKey(port)
  return state.suspendedPortKeys.includes(key)
}
