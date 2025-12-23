// @ts-check
import { useCallback, useEffect, useMemo, useState } from 'react'

import { TerminalSettingsContext } from './TerminalSettingsContext'

/**
 * @typedef {Pick<
 *   import('@xterm/xterm').ITerminalOptions,
 *   'cursorStyle' | 'scrollback'
 * >} TerminalSettings
 */

const LS_KEY = 'portino.terminal.settings'

export function TerminalSettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      /** @type {TerminalSettings} */
      const settings = raw ? JSON.parse(raw) : {}
      return { ...settings }
    } catch {
      return {}
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings))
    } catch {}
  }, [settings])

  const update = useCallback((patch) => {
    setSettings((s) => ({ ...s, ...patch }))
  }, [])

  const value = useMemo(() => ({ settings, update }), [settings, update])
  return (
    <TerminalSettingsContext.Provider value={value}>
      {children}
    </TerminalSettingsContext.Provider>
  )
}
