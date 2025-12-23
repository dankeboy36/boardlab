// @ts-check
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useSelector } from 'react-redux'

import { useMonitorStream } from '@vscode-ardunno/monitor-shared/serial-monitor'
import { SerializeAddon } from '@xterm/addon-serialize'

import {
  getPersistedState,
  updatePersistentState,
} from '../../state/persistence.js'
import XtermView from './XtermView.jsx'
import { selectTerminalSettings } from './terminalSelectors.js'

const MAX_SERIALIZE_ROWS = 2000
const MAX_PERSISTED_CHARS = 20000

/**
 * @typedef {Object} TerminalPanelProps
 * @property {(locked: boolean) => void} [onScrollLockChange]
 */

/**
 * @typedef {Object} TerminalPanelHandle
 * @property {() => Promise<void>} copyAll
 * @property {() => void} saveToFile
 * @property {() => void} clear
 * @property {() => void} toggleScrollLock
 * @property {() => boolean} isScrollLock
 * @property {() => void} refreshTheme
 */

/**
 * @param {TerminalPanelProps} props
 * @param {import('react').Ref<TerminalPanelHandle>} ref
 */
const TerminalPanel = forwardRef(function TerminalPanel(
  { onScrollLockChange },
  ref
) {
  const settings = useSelector(selectTerminalSettings)
  const persistedTerminal = useRef(() => {
    const state = getPersistedState()
    const terminalState = state?.terminal
    if (terminalState && typeof terminalState === 'object') {
      return {
        text: typeof terminalState.text === 'string' ? terminalState.text : '',
        scrollLock:
          typeof terminalState.scrollLock === 'boolean'
            ? terminalState.scrollLock
            : false,
      }
    }
    return { text: '', scrollLock: false }
  })
  const xtermRef = useRef(
    /** @type {import('./XtermView.jsx').XtermViewHandle | null} */ (null)
  )
  const bufferRef = useRef('')
  // Monotonic session id to invalidate old buffers/writes across restarts
  const sessionRef = useRef(0)
  const bufferSessionRef = useRef(0)
  const settleUntilRef = useRef(0)
  const rafIdRef = useRef(/** @type {number | null} */ (null))
  const flushTidRef = useRef(/** @type {number | null} */ (null))
  const startedRef = useRef(false)
  const [scrollLock, setScrollLock] = useState(
    persistedTerminal.current.scrollLock
  )
  const scrollLockRef = useRef(scrollLock)
  const persistTimerRef = useRef(
    /** @type {ReturnType<typeof setTimeout> | null} */ (null)
  )
  const serializeAddonRef = useRef(
    /** @type {SerializeAddon | undefined} */ (undefined)
  )

  const getTerminalText = useCallback(() => {
    try {
      const base = xtermRef.current?.getText?.() ?? ''
      return bufferRef.current ? `${base}${bufferRef.current}` : base
    } catch {
      return ''
    }
  }, [])

  const collectSnapshot = useCallback(() => {
    try {
      const addon = serializeAddonRef.current
      const rows = Math.min(
        typeof settings.scrollback === 'number' && settings.scrollback > 0
          ? settings.scrollback
          : MAX_SERIALIZE_ROWS,
        MAX_SERIALIZE_ROWS
      )
      const raw = addon
        ? addon.serialize({ scrollback: rows })
        : getTerminalText()
      const pending = bufferRef.current
      const combined = pending ? `${raw}${pending}` : raw
      if (combined.length <= MAX_PERSISTED_CHARS) {
        return combined
      }
      return combined.slice(combined.length - MAX_PERSISTED_CHARS)
    } catch {
      return getTerminalText()
    }
  }, [getTerminalText, settings.scrollback])

  const persistNow = useCallback(() => {
    const snapshot = collectSnapshot()
    updatePersistentState({
      terminal: {
        text: snapshot,
        scrollLock: scrollLockRef.current,
      },
    })
  }, [collectSnapshot])

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current != null) return
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null
      persistNow()
    }, 500)
  }, [persistNow])

  const handleCopyAll = useCallback(async () => {
    const text = getTerminalText()
    try {
      await navigator.clipboard?.writeText(text)
    } catch {}
  }, [getTerminalText])

  const handleSaveToFile = useCallback(() => {
    const text = getTerminalText()
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const a = document.createElement('a')
      a.href = url
      a.download = `serial-log-${ts}.txt`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {}
  }, [getTerminalText])

  const handleClearAll = useCallback(() => {
    xtermRef.current?.clear()
    bufferRef.current = ''
    schedulePersist()
  }, [schedulePersist])

  useMonitorStream({
    onStart: () => {
      try {
        // Cancel any scheduled flush from a previous session
        if (rafIdRef.current != null) {
          cancelAnimationFrame(rafIdRef.current)
          rafIdRef.current = null
        }
        if (flushTidRef.current != null) {
          clearTimeout(flushTidRef.current)
          flushTidRef.current = null
        }
        sessionRef.current += 1
        bufferSessionRef.current = sessionRef.current
        bufferRef.current = ''
        startedRef.current = true
        xtermRef.current?.clear()
        schedulePersist()
      } catch {}
    },
    onStop: () => {
      try {
        bufferRef.current = ''
        bufferSessionRef.current = sessionRef.current
        startedRef.current = false
        schedulePersist()
      } catch {}
    },
    onText: (text) => {
      const chunk = String(text)
      const sid = sessionRef.current
      if (!startedRef.current) {
        // Drop anything arriving before onStart in the new session
        return
      }
      const now =
        typeof performance !== 'undefined' && performance.now
          ? performance.now()
          : Date.now()
      const settling = now < (settleUntilRef.current || 0)

      if (settling) {
        if (bufferSessionRef.current !== sid) {
          bufferSessionRef.current = sid
          bufferRef.current = ''
        }
        bufferRef.current += chunk
        schedulePersist()
        return
      }

      if (bufferRef.current && bufferSessionRef.current === sid) {
        try {
          xtermRef.current?.write(bufferRef.current)
        } catch {}
        bufferRef.current = ''
      } else {
        bufferRef.current = ''
        bufferSessionRef.current = sid
      }
      xtermRef.current?.write(chunk)
      schedulePersist()
    },
  })

  useEffect(() => {
    onScrollLockChange?.(scrollLock)
    scrollLockRef.current = scrollLock
    schedulePersist()
  }, [scrollLock, onScrollLockChange, schedulePersist])

  useEffect(() => {
    // Fit first at current size
    try {
      xtermRef.current?.fit?.()
    } catch {}
    // Start a short settling period to avoid writes during late layout changes
    const now =
      typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now()
    settleUntilRef.current = now + 120
    // rAF fit and flush
    try {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null
        try {
          xtermRef.current?.fit?.()
        } catch {}
        if (
          bufferRef.current &&
          bufferSessionRef.current === sessionRef.current
        ) {
          try {
            xtermRef.current?.write(bufferRef.current)
          } catch {}
          bufferRef.current = ''
        } else {
          bufferRef.current = ''
          bufferSessionRef.current = sessionRef.current
        }
      })
    } catch {}
    // Timed final fit + flush
    flushTidRef.current = setTimeout(() => {
      flushTidRef.current = null
      try {
        xtermRef.current?.fit?.()
      } catch {}
      if (
        bufferRef.current &&
        bufferSessionRef.current === sessionRef.current
      ) {
        try {
          xtermRef.current?.write(bufferRef.current)
        } catch {}
        bufferRef.current = ''
      } else {
        bufferRef.current = ''
        bufferSessionRef.current = sessionRef.current
      }
    }, 140)
    return () => {
      if (flushTidRef.current != null) {
        clearTimeout(flushTidRef.current)
        flushTidRef.current = null
      }
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      copyAll: handleCopyAll,
      saveToFile: handleSaveToFile,
      clear: handleClearAll,
      toggleScrollLock: () => setScrollLock((prev) => !prev),
      isScrollLock: () => scrollLock,
      refreshTheme: () => {
        try {
          xtermRef.current?.refreshTheme?.()
        } catch {}
      },
    }),
    [handleCopyAll, handleSaveToFile, handleClearAll, scrollLock]
  )

  useEffect(() => {
    let disposed = false
    const addon = new SerializeAddon()
    const attach = () => {
      if (disposed) return
      if (!xtermRef.current) {
        requestAnimationFrame(attach)
        return
      }
      try {
        xtermRef.current.loadAddon?.(addon)
        serializeAddonRef.current = addon
      } catch {}
    }
    attach()
    return () => {
      disposed = true
      try {
        addon.dispose?.()
      } catch {}
      serializeAddonRef.current = undefined
    }
  }, [])

  useEffect(() => {
    const initialText = persistedTerminal.current.text
    if (!initialText) return
    let cancelled = false
    const apply = () => {
      if (cancelled) return
      if (!xtermRef.current) {
        requestAnimationFrame(apply)
        return
      }
      try {
        xtermRef.current.clear()
        xtermRef.current.write(initialText)
      } catch {}
      persistedTerminal.current.text = ''
    }
    apply()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return () => {
      if (persistTimerRef.current != null) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      persistNow()
    }
  }, [persistNow])

  return (
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
          flex: 1,
          minHeight: 0,
          margin: 4,
          background:
            'var(--vscode-terminal-background, var(--vscode-editor-background))',
          overflow: 'hidden',
        }}
      >
        <XtermView
          ref={xtermRef}
          scrollLock={scrollLock}
          scrollback={settings.scrollback}
          fontSize={settings.fontSize}
          cursorStyle={settings.cursorStyle}
        />
      </div>
    </div>
  )
})

export default TerminalPanel
