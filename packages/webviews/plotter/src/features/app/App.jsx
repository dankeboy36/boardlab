// @ts-check
import { useEffect, useRef, useState } from 'react'

import { useCodiconStylesheet, vscode } from '@vscode-ardunno/base'
import { usePortinoClientSync } from '@vscode-ardunno/monitor-shared/hooks'
import {
  MonitorProvider,
  MonitorSendBar,
} from '@vscode-ardunno/monitor-shared/serial-monitor'
import {
  notifyPlotterLineEndingChanged,
  notifyPlotterToolbarAction,
} from '@vscode-ardunno/protocol'
import { applyNonce } from '../../utils/csp.js'
import PlotterPanel from '../plotter/PlotterPanel.jsx'
import Shell from './Shell.jsx'

function App() {
  useCodiconStylesheet()

  useEffect(() => {
    if (typeof document === 'undefined') return
    if (!document.getElementById('app-inline-global')) {
      const style = document.createElement('style')
      applyNonce(style)
      style.id = 'app-inline-global'
      style.textContent = `
        html, body, #root { height: 100%; margin: 0; padding: 0; }
      `
      document.head.appendChild(style)
    }
  }, [])

  const { client } = usePortinoClientSync()
  const plotterPanelRef = useRef(
    /**
     * @type {import('../plotter/PlotterPanel.jsx').PlotterPanelHandle
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
    messenger.onNotification(notifyPlotterToolbarAction, ({ action }) => {
      const plotter = plotterPanelRef.current
      if (!plotter) return
      try {
        switch (action) {
          case 'clear':
            plotter.clear?.()
            break
          case 'resetYScale':
            plotter.resetYScale?.()
            break
          default:
            break
        }
      } catch (error) {
        console.error('Plotter toolbar action failed', action, error)
      }
    })
  }, [])

  useEffect(() => {
    const messenger = vscode.messenger
    if (!messenger) return
    messenger.onNotification(
      notifyPlotterLineEndingChanged,
      ({ lineEnding: next }) => {
        setLineEnding(next)
      }
    )
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
            <MonitorSendBar client={client} lineEnding={lineEnding} />
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <PlotterPanel ref={plotterPanelRef} active />
            </div>
          </div>
        </MonitorProvider>
      }
    />
  )
}

export default App
