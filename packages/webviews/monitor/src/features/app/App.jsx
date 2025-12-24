// @ts-check
import { useCodiconStylesheet, vscode } from '@boardlab/base'
import { useMonitorClientSync } from '@boardlab/monitor-shared/hooks'
import {
  MonitorProvider,
  MonitorSendBar,
} from '@boardlab/monitor-shared/serial-monitor'
import {
  notifyMonitorLineEndingChanged,
  notifyMonitorThemeChanged,
  notifyMonitorToolbarAction,
} from '@boardlab/protocol'
import { useEffect, useRef, useState } from 'react'

import { applyNonce } from '../../utils/csp.js'
import TerminalPanel from '../terminal/TerminalPanel.jsx'
import Shell from './Shell.jsx'

function App() {
  useCodiconStylesheet()

  useEffect(() => {
    if (typeof document === 'undefined') return
    // Inline global styles instead of styled-components
    if (!document.getElementById('app-inline-global')) {
      const style = document.createElement('style')
      applyNonce(style)
      style.id = 'app-inline-global'
      style.textContent = `
        html, body, #root { height: 100%; margin: 0; padding: 0; }
        .xterm { height: 100% !important; width: 100% !important; }
      `
      document.head.appendChild(style)
    }
  }, [])

  const { client } = useMonitorClientSync()
  const terminalPanelRef = useRef(
    /**
     * @type {import('../terminal/TerminalPanel.jsx').TerminalPanelHandle
     *   | null}
     */
    (null)
  )
  const [lineEnding, setLineEnding] = useState(
    /** @type {'none' | 'lf' | 'cr' | 'crlf'} */ ('crlf')
  )

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) return
    messenger.onNotification(notifyMonitorToolbarAction, ({ action }) => {
      const terminal = terminalPanelRef.current
      if (!terminal) return
      try {
        switch (action) {
          case 'copyAll':
            terminal.copyAll?.()
            break
          case 'saveToFile':
            terminal.saveToFile?.()
            break
          case 'clear':
            terminal.clear?.()
            break
          case 'toggleScrollLock':
            terminal.toggleScrollLock?.()
            break
          default:
            break
        }
      } catch (error) {
        console.error('Monitor toolbar action failed', action, error)
      }
    })
  }, [])

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) return
    messenger.onNotification(
      notifyMonitorLineEndingChanged,
      ({ lineEnding: next }) => {
        setLineEnding(next)
      }
    )
  }, [])

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) return
    messenger.onNotification(notifyMonitorThemeChanged, () => {
      try {
        terminalPanelRef.current?.refreshTheme?.()
      } catch (error) {
        console.error('Failed to refresh terminal theme', error)
      }
    })
  }, [])

  return (
    <Shell
      header={null}
      body={
        <MonitorProvider client={client}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              minHeight: 0,
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                flex: 1,
                minHeight: 0,
              }}
            >
              <MonitorSendBar client={client} lineEnding={lineEnding} />
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <TerminalPanel ref={terminalPanelRef} />
              </div>
            </div>
          </div>
        </MonitorProvider>
      }
    />
  )
}

export default App
