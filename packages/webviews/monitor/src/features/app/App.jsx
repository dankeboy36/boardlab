// @ts-check
import { useEffect, useRef, useState } from 'react'

import { useCodiconStylesheet, vscode } from '@boardlab/base'
import { useMonitorClientSync } from '@boardlab/monitor-shared/hooks'
import {
  MonitorProvider,
  MonitorSendBar,
  useMonitorController,
} from '@boardlab/monitor-shared/serial-monitor'
import {
  notifyMonitorLineEndingChanged,
  notifyMonitorThemeChanged,
  notifyMonitorToolbarAction,
  requestMonitorEditorContent,
} from '@boardlab/protocol'

import { applyNonce } from '../../utils/csp.js'
import TerminalPanel from '../terminal/TerminalPanel.jsx'
import Shell from './Shell.jsx'

function MonitorToolbarActionHandler({ terminalRef }) {
  const { play, stop } = useMonitorController()

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) return
    messenger.onNotification(notifyMonitorToolbarAction, ({ action }) => {
      const terminal = terminalRef.current
      if (action === 'play') {
        play()
      } else if (action === 'stop') {
        stop()
      } else if (action === 'clear') {
        terminal?.clear?.()
      }
    })
  }, [play, stop, terminalRef])

  return null
}

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

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) return
    messenger.onRequest(requestMonitorEditorContent, () => ({
      text: terminalPanelRef.current?.getText?.() ?? '',
    }))
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
            <MonitorToolbarActionHandler terminalRef={terminalPanelRef} />
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
