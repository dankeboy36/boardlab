// @ts-check
import { useContext } from 'react'

import { TerminalSettingsContext } from '../features/terminal/TerminalSettingsContext'

export function useTerminalSettings() {
  return useContext(TerminalSettingsContext)
}
