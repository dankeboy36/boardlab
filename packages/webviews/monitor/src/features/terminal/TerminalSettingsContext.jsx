// @ts-check
import { createContext } from 'react'

/**
 * @typedef {Pick<
 *   import('@xterm/xterm').ITerminalOptions,
 *   | 'cursorStyle'
 *   | 'cursorInactiveStyle'
 *   | 'cursorBlink'
 *   | 'scrollback'
 *   | 'fontSize'
 * >} TerminalSettings
 */

/** @type {TerminalSettings} */
const defaultSettings = {
  cursorStyle: 'block',
  cursorInactiveStyle: 'outline',
  cursorBlink: false,
  scrollback: 1000,
  fontSize: 12,
}

/**
 * @type {React.Context<{
 *   settings: TerminalSettings
 *   update: (patch: Partial<TerminalSettings>) => void
 * }>}
 */
export const TerminalSettingsContext = createContext({
  settings: defaultSettings,
  update: (patch) => {
    Object.assign(defaultSettings, patch)
  },
})
