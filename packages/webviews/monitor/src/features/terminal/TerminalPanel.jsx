// @ts-check
import { SerializeAddon } from '@xterm/addon-serialize'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useSelector } from 'react-redux'
import PerfectScrollbar from 'perfect-scrollbar'
import 'perfect-scrollbar/css/perfect-scrollbar.css'

import { useMonitorStream } from '@boardlab/monitor-shared/serial-monitor'
import { vscode } from '@boardlab/base'
import { notifyMonitorThemeChanged } from '@boardlab/protocol'

import {
  getPersistedState,
  updatePersistentState,
} from '../../state/persistence.js'
import XtermView, {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
} from './XtermView.jsx'
import { selectTerminalSettings } from './terminalSelectors.js'

const MAX_SERIALIZE_ROWS = 2000
const MAX_PERSISTED_CHARS = 20000

const parseCssNumber = (/** @type {string | undefined} */ value) => {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return undefined
  const parsed = parseFloat(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

const readCssProperty = (/** @type {string} */ name) => {
  if (typeof document === 'undefined') return undefined
  const root = document.documentElement
  if (!root) return undefined
  return getComputedStyle(root).getPropertyValue(name).trim() || undefined
}

const readEditorFontSize = () => {
  return parseCssNumber(readCssProperty('--vscode-editor-font-size'))
}

const readEditorFontFamily = () => {
  return readCssProperty('--vscode-editor-font-family')
}

/** @typedef {Object} TerminalPanelProps */

/**
 * @typedef {Object} TerminalPanelHandle
 * @property {() => string} getText
 * @property {() => void} clear
 * @property {() => void} refreshTheme
 */

/**
 * @param {TerminalPanelProps} props
 * @param {import('react').Ref<TerminalPanelHandle>} ref
 */
const TerminalPanel = forwardRef(function TerminalPanel(_props, ref) {
  const settings = useSelector(selectTerminalSettings)
  const persistedTerminal = useRef(() => {
    const state = getPersistedState()
    const terminalState = state?.terminal
    if (terminalState && typeof terminalState === 'object') {
      return {
        text: typeof terminalState.text === 'string' ? terminalState.text : '',
      }
    }
    return { text: '' }
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
  const [isHovered, setIsHovered] = useState(false)
  const [terminalAtBottom, setTerminalAtBottom] = useState(true)
  const [cssFontSize, setCssFontSize] = useState(() => readEditorFontSize())
  const [cssFontFamily, setCssFontFamily] = useState(() =>
    readEditorFontFamily()
  )
  const [scrollActive, setScrollActive] = useState(false)
  const scrollableRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const psRef = useRef(/** @type {PerfectScrollbar | null} */ (null))
  const persistTimerRef = useRef(
    /** @type {ReturnType<typeof setTimeout> | null} */ (null)
  )
  const serializeAddonRef = useRef(
    /** @type {SerializeAddon | undefined} */ (undefined)
  )
  const scrollFadeTimerRef = useRef(
    /** @type {ReturnType<typeof setTimeout> | null} */ (null)
  )

  useEffect(() => {
    const refreshFonts = () => {
      setCssFontSize(readEditorFontSize())
      setCssFontFamily(readEditorFontFamily())
    }
    refreshFonts()

    const messenger = vscode.messenger
    const disposables = []

    if (messenger) {
      const disposable = messenger.onNotification(
        notifyMonitorThemeChanged,
        refreshFonts
      )
      if (disposable) {
        disposables.push(disposable)
      }
    }

    if (typeof document !== 'undefined') {
      const root = document.documentElement
      if (root) {
        const observer = new MutationObserver(refreshFonts)
        observer.observe(root, { attributes: true, attributeFilter: ['style'] })
        disposables.push({ dispose: () => observer.disconnect() })
      }
    }

    return () => {
      disposables.forEach((d) => d?.dispose?.())
    }
  }, [])

  const updateTerminalAtBottom = useCallback(() => {
    try {
      const atBottom = xtermRef.current?.isAtBottom?.() ?? true
      setTerminalAtBottom(atBottom)
    } catch {
      setTerminalAtBottom(true)
    }
  }, [])

  const showTemporaryScrollbar = useCallback(() => {
    setScrollActive(true)
    if (scrollFadeTimerRef.current != null) {
      clearTimeout(scrollFadeTimerRef.current)
    }
    scrollFadeTimerRef.current = setTimeout(() => {
      scrollFadeTimerRef.current = null
      setScrollActive(false)
    }, 1100)
  }, [])

  const derivedFontSize =
    settings.fontSize ?? cssFontSize ?? DEFAULT_TERMINAL_FONT_SIZE
  const derivedFontFamily = cssFontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY

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

  const refreshScrollbar = useCallback(() => {
    try {
      psRef.current?.update()
    } catch {}
    updateTerminalAtBottom()
  }, [updateTerminalAtBottom])

  useEffect(() => {
    try {
      xtermRef.current?.fit?.()
    } catch {}
    refreshScrollbar()
  }, [derivedFontSize, derivedFontFamily, refreshScrollbar])

  useEffect(() => {
    let disposed = false
    let rafId = /** @type {number | null} */ (null)
    let psInstance = /** @type {PerfectScrollbar | null} */ (null)
    let viewportElement = /** @type {HTMLElement | null} */ (null)

    const handleViewportScroll = () => {
      updateTerminalAtBottom()
    }

    const attach = () => {
      if (disposed) return
      const container = scrollableRef.current
      const viewport = container?.querySelector('.xterm-viewport')
      if (!(viewport instanceof HTMLElement)) {
        rafId = requestAnimationFrame(attach)
        return
      }
      viewportElement = viewport
      viewport.addEventListener('scroll', handleViewportScroll, {
        passive: true,
      })
      psInstance = new PerfectScrollbar(viewport, {
        wheelPropagation: false,
      })
      psRef.current = psInstance
      refreshScrollbar()
    }

    attach()

    return () => {
      disposed = true
      if (rafId != null) {
        cancelAnimationFrame(rafId)
      }
      viewportElement?.removeEventListener('scroll', handleViewportScroll)
      psInstance?.destroy()
      psRef.current = null
    }
  }, [refreshScrollbar, updateTerminalAtBottom])

  useEffect(() => {
    let disposed = false
    let disposable = null

    const attach = () => {
      if (disposed) return
      const terminal = xtermRef.current
      if (!terminal || typeof terminal.onScroll !== 'function') {
        requestAnimationFrame(attach)
        return
      }
      disposable = terminal.onScroll(() => {
        showTemporaryScrollbar()
        updateTerminalAtBottom()
      })
    }

    attach()

    return () => {
      disposed = true
      disposable?.dispose?.()
    }
  }, [showTemporaryScrollbar, updateTerminalAtBottom])

  useEffect(() => {
    return () => {
      if (scrollFadeTimerRef.current != null) {
        clearTimeout(scrollFadeTimerRef.current)
        scrollFadeTimerRef.current = null
      }
    }
  }, [])

  const handleClearAll = useCallback(() => {
    xtermRef.current?.clear()
    bufferRef.current = ''
    schedulePersist()
    refreshScrollbar()
  }, [refreshScrollbar, schedulePersist])

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
        refreshScrollbar()
      } else {
        bufferRef.current = ''
        bufferSessionRef.current = sid
      }
      xtermRef.current?.write(chunk)
      refreshScrollbar()
      schedulePersist()
    },
  })

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
          refreshScrollbar()
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
        refreshScrollbar()
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
      getText: () => getTerminalText(),
      clear: handleClearAll,
      refreshTheme: () => {
        try {
          xtermRef.current?.refreshTheme?.()
        } catch {}
      },
    }),
    [getTerminalText, handleClearAll]
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
        refreshScrollbar()
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

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true)
  }, [])

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false)
  }, [])

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
        ref={scrollableRef}
        className={`monitor-scrollable${
          isHovered || terminalAtBottom || scrollActive
            ? ' monitor-scrollbar-visible'
            : ''
        }`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          flex: 1,
          minHeight: 0,
          marginLeft: 4,
          background: 'var(--vscode-editor-background)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <XtermView
          ref={xtermRef}
          scrollback={settings.scrollback}
          fontSize={derivedFontSize}
          fontFamily={derivedFontFamily}
          cursorStyle={settings.cursorStyle}
        />
      </div>
    </div>
  )
})

export default TerminalPanel
