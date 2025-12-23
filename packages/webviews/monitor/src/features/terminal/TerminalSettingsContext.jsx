// @ts-check
import { createContext } from 'react'

/**
 * @typedef {Pick<
 *   import('@xterm/xterm').ITerminalOptions,
 *   'cursorStyle' | 'scrollback'
 * >} TerminalSettings
 */

/** @type {TerminalSettings} */
const defaultSettings = {
  cursorStyle: 'block',
  scrollback: 1000,
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
