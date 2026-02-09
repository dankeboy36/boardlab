// @ts-check
import { createSlice } from '@reduxjs/toolkit'

/**
 * @typedef {Pick<
 *   import('@xterm/xterm').ITerminalOptions,
 *   | 'cursorStyle'
 *   | 'cursorInactiveStyle'
 *   | 'cursorBlink'
 *   | 'scrollback'
 *   | 'fontSize'
 *   | 'fontFamily'
 * >} TerminalSettings
 */

const LS_KEY = 'boardlab.monitor.terminal.settings'

/** @returns {TerminalSettings} */
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    const obj = raw ? JSON.parse(raw) : {}
    return /** @type {TerminalSettings} */ (obj)
  } catch {
    return /** @type {TerminalSettings} */ ({})
  }
}

/** @param {TerminalSettings} s */
function save(s) {
  try {
    const compact =
      /** @type {Record<string, number | string | boolean | undefined>} */ ({})
    if (s.scrollback != null) compact.scrollback = s.scrollback
    if (s.cursorStyle != null) compact.cursorStyle = s.cursorStyle
    if (s.cursorInactiveStyle != null) {
      compact.cursorInactiveStyle = s.cursorInactiveStyle
    }
    if (s.cursorBlink != null) compact.cursorBlink = s.cursorBlink
    if (s.fontSize != null) compact.fontSize = s.fontSize
    if (s.fontFamily != null) compact.fontFamily = s.fontFamily
    localStorage.setItem(LS_KEY, JSON.stringify(compact))
  } catch {}
}

/** @type {TerminalSettings} */
const initialState = load()

const terminalSettingsSlice = createSlice({
  name: 'terminalSettings',
  initialState,
  reducers: {
    setScrollback(state, action) {
      state.scrollback = action.payload
      save(state)
    },
    setCursorStyle(state, action) {
      state.cursorStyle = action.payload
      save(state)
    },
    setFontSize(state, action) {
      state.fontSize = action.payload
      save(state)
    },
    setTerminalSettings(state, action) {
      Object.assign(
        state,
        /** @type {Partial<TerminalSettings>} */ (action.payload)
      )
      save(state)
    },
    resetTerminalSettings() {
      const next = /** @type {TerminalSettings} */ ({})
      save(next)
      return next
    },
  },
})

/** @typedef {typeof terminalSettingsSlice.actions} TerminalSettingsActions */

/** @type {TerminalSettingsActions} */
const actions = terminalSettingsSlice.actions

export const {
  setScrollback,
  setCursorStyle,
  setFontSize,
  setTerminalSettings,
  resetTerminalSettings,
} = actions

export default terminalSettingsSlice.reducer
