// @ts-check
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { VscodeIcon, VscodeTextfield } from 'vscode-react-elements-x'

import {
  attachXtermTheme,
  DEFAULT_FIND_MATCH_BACKGROUND,
  normalizeAlpha,
} from './terminalTheme.js'

/**
 * Imperative Xterm view. Does not lift lines into React; use ref API to write.
 *
 * @typedef {{
 *   loadAddon: (addon: import('@xterm/xterm').ITerminalAddon) => void
 *   write: (text: string) => void
 *   clear: () => void
 *   getText: () => string
 *   fit: () => void
 *   isAtBottom: () => boolean
 *   scrollToBottom: () => void
 *   pushTransientLock: () => void
 *   popTransientLock: () => void
 *   refreshTheme: () => void
 * }} XtermViewHandle
 *
 *
 * @typedef {{
 *   scrollLock?: boolean
 *   scrollback?: number | undefined
 *   cursorStyle?: 'block' | 'underline' | 'bar' | undefined
 *   fontSize?: number | undefined
 * }} XtermViewProps
 *
 *
 * @typedef {import('react').ForwardRefExoticComponent<
 *   import('react').PropsWithoutRef<XtermViewProps> &
 *     import('react').RefAttributes<XtermViewHandle>
 * >} XtermViewComponent
 */
/** @type {XtermViewComponent} */
const XtermView = forwardRef(function XtermView(props, ref) {
  const {
    scrollLock = false,
    scrollback,
    cursorStyle,
    fontSize,
  } = /** @type {XtermViewProps} */ (props)
  /** @type {React.RefObject<HTMLDivElement | null>} */
  const containerRef = useRef(null)
  const termRef = useRef(
    /** @type {import('@xterm/xterm').Terminal | undefined} */ (undefined)
  )
  const fitRef = useRef(
    /** @type {import('@xterm/addon-fit').FitAddon | undefined} */ (undefined)
  )
  const searchRef = useRef(
    /** @type {import('@xterm/addon-search').SearchAddon | undefined} */ (
      undefined
    )
  )
  const themeHandleRef = useRef(
    /** @type {{ refresh?: () => void; dispose?: () => void } | undefined} */ (
      undefined
    )
  )
  const lockRef = useRef(!!scrollLock)
  // Additional transient lock level (used while dropdowns are open)
  const transientLockRef = useRef(0)
  const defaultsRef = useRef(
    /**
     * @type {Partial<
     *   import('./terminalSettingsSlice.js').TerminalSettings
     * >}
     */ ({})
  )
  const lastAppliedRef = useRef(
    /**
     * @type {Partial<
     *   import('./terminalSettingsSlice.js').TerminalSettings
     * >}
     */ ({})
  )

  // --- Simple search UI state -------------------------------------------------
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [matchCount, setMatchCount] = useState(0)
  const [matchIndex, setMatchIndex] = useState(0) // 1-based when available
  const inputRef = useRef(
    /** @type {import('vscode-elements-x').VscodeTextfield | null} */ (null)
  )
  const setInputRef = useCallback((el) => {
    inputRef.current = el ?? null
  }, [])
  const prevQueryRef = useRef('')
  const prevSearchOpenRef = useRef(false)
  const searchOpenRef = useRef(false)

  const focusSearchField = useCallback(() => {
    const host =
      inputRef.current ??
      (typeof document !== 'undefined'
        ? document.querySelector('[data-boardlab-monitor-search-input]')
        : null)
    if (!(host instanceof HTMLElement)) return

    const getInputCandidates = () => [
      /** @type {any} */ (host).wrappedElement,
      host.shadowRoot?.querySelector('input'),
      host.querySelector?.('input'),
    ]

    const collapseSelection = () => {
      for (const candidate of getInputCandidates()) {
        if (candidate instanceof HTMLInputElement) {
          try {
            const pos = candidate.value?.length ?? 0
            candidate.setSelectionRange(pos, pos)
          } catch {}
        }
      }
    }

    const scheduleCollapse = () => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => collapseSelection())
      } else {
        setTimeout(() => collapseSelection(), 0)
      }
    }

    const focusElement = (element) => {
      if (!element || typeof element.focus !== 'function') return false
      try {
        element.focus({ preventScroll: true })
      } catch {
        try {
          element.focus()
        } catch {
          return false
        }
      }
      scheduleCollapse()
      return true
    }

    const attempt = () => {
      if (focusElement(host)) return true
      for (const candidate of getInputCandidates()) {
        if (!(candidate instanceof HTMLElement)) continue
        if (focusElement(candidate)) return true
      }
      return false
    }

    if (attempt()) return
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        attempt()
      })
    } else {
      setTimeout(() => {
        attempt()
      }, 0)
    }
  }, [])

  useEffect(() => {
    lockRef.current = !!scrollLock
  }, [scrollLock])

  // Refit xterm when the container resizes or window size changes
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const fit = () => {
      try {
        fitRef.current?.fit()
      } catch {}
    }
    const ro = new ResizeObserver(() => fit())
    ro.observe(el)
    window.addEventListener('resize', fit)
    const id = requestAnimationFrame(fit)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', fit)
      cancelAnimationFrame(id)
    }
  }, [])

  // Update options when settings change – only set allowed keys, only when changed
  useEffect(() => {
    const t = termRef.current
    if (!t) return
    /** @type {Record<string, any>} */
    const desired = {}
    if (typeof scrollback === 'number') desired.scrollback = scrollback
    else if ('scrollback' in defaultsRef.current) {
      desired.scrollback = defaultsRef.current.scrollback
    }
    if (cursorStyle !== undefined) desired.cursorStyle = cursorStyle
    else if ('cursorStyle' in defaultsRef.current) {
      desired.cursorStyle = defaultsRef.current.cursorStyle
    }
    if (
      typeof fontSize === 'number' &&
      Number.isInteger(fontSize) &&
      fontSize > 0
    ) {
      desired.fontSize = fontSize
    } else if ('fontSize' in defaultsRef.current) {
      desired.fontSize = /** @type {any} */ (defaultsRef.current).fontSize ?? 14
    }

    const applyKey = (key, value) => {
      if (lastAppliedRef.current[key] === value) return
      try {
        /** @type {any} */ t.options[key] = value
      } catch {}
      lastAppliedRef.current[key] = value
    }

    Object.keys(desired).forEach((k) => applyKey(k, desired[k]))
  }, [scrollback, cursorStyle, fontSize])

  useImperativeHandle(
    ref,
    () => ({
      loadAddon(addon) {
        try {
          termRef.current?.loadAddon?.(addon)
        } catch {}
      },
      fit() {
        try {
          fitRef.current?.fit()
        } catch {}
      },
      write(text) {
        const t = termRef.current
        if (!t) return
        try {
          const locked = lockRef.current || transientLockRef.current > 0
          if (locked) {
            const topLine = /** @type {any} */ (t).buffer?.active?.viewportY
            t.write(text, () => {
              try {
                /** @type {any} */ t.scrollToLine?.(topLine)
              } catch {}
            })
          } else {
            t.write(text)
          }
        } catch {}
      },
      clear() {
        const t = termRef.current
        t?.clear()
      },
      /** Temporarily force scroll lock on/off without React state. */
      pushTransientLock() {
        transientLockRef.current += 1
      },
      popTransientLock() {
        if (transientLockRef.current > 0) transientLockRef.current -= 1
      },
      /** Return true if viewport shows the last line(s). */
      isAtBottom() {
        const t = termRef.current
        try {
          const buf = t?.buffer?.active
          const rows = t?.rows ?? 0
          if (!buf || !rows) return true
          const bottomTopIndex = Math.max(0, (buf.length ?? 0) - rows)
          const viewportY = buf.viewportY ?? 0
          return viewportY >= bottomTopIndex
        } catch {
          return true
        }
      },
      /** Programmatically scroll to the last line. */
      scrollToBottom() {
        const t = termRef.current
        try {
          t?.scrollToBottom?.()
        } catch {}
      },
      getText() {
        const t = termRef.current
        if (!t) return ''
        try {
          const buffer = t.buffer?.active ?? t.buffer
          const lines = []
          const length = buffer?.length ?? 0
          for (let i = 0; i < length; i++) {
            const lineObj = buffer.getLine(i)
            if (!lineObj) continue
            const text = lineObj
              .translateToString(true)
              .split('\u0000')
              .join('')
            lines.push(text)
          }
          return lines.join('\n')
        } catch {
          return ''
        }
      },
      refreshTheme() {
        try {
          themeHandleRef.current?.refresh?.()
        } catch {}
      },
    }),
    []
  )

  const getDecorationOptions = () => {
    const css = (name, fb) =>
      (typeof document !== 'undefined'
        ? getComputedStyle(document.documentElement)
            .getPropertyValue(name)
            .trim()
        : '') || fb
    const rawActiveBg = css('--vscode-terminal-findMatchBackground', '')
    const activeBg =
      normalizeAlpha(rawActiveBg) || DEFAULT_FIND_MATCH_BACKGROUND
    const matchBg = css(
      '--vscode-terminal-findMatchHighlightBackground',
      'rgba(234, 92, 0, 0.33)'
    )
    const fg = css('--vscode-terminal-foreground', '#3b3b3b')
    return {
      matchBackground: matchBg,
      matchBorder: 'transparent',
      matchOverviewRuler: fg,
      activeMatchBackground: activeBg,
      activeMatchBorder: 'transparent',
      activeMatchColorOverviewRuler: fg,
    }
  }

  const doFind = useCallback(
    (direction /* 'next' | 'prev' */, noScroll = false) => {
      const addon = searchRef.current
      if (!addon || !query) {
        setMatchCount(0)
        setMatchIndex(0)
        return
      }
      const opts = {
        regex: useRegex,
        caseSensitive,
        wholeWord,
        incremental: true,
        noScroll,
        decorations: getDecorationOptions(),
      }
      try {
        if (direction === 'prev') addon.findPrevious(query, opts)
        else addon.findNext(query, opts)
      } catch {}
    },
    [query, caseSensitive, wholeWord, useRegex]
  )

  const closeSearch = useCallback(() => {
    // Determine if the search textfield currently has focus (host or shadow input)
    let hadSearchFocus = false
    try {
      const host = inputRef.current
      if (host) {
        const ae = host.ownerDocument?.activeElement
        hadSearchFocus = ae === host || !!host.shadowRoot?.activeElement
        // Fallback: :focus match on host if supported
        if (!hadSearchFocus && 'matches' in host) {
          try {
            hadSearchFocus = /** @type {any} */ (host).matches(':focus')
          } catch {}
        }
      }
    } catch {}

    try {
      searchRef.current?.clearDecorations?.()
      termRef.current?.clearSelection?.()
    } catch {}
    setSearchOpen(false)
    setMatchCount(0)
    setMatchIndex(0)
    prevSearchOpenRef.current = false
    searchOpenRef.current = false

    // Return focus to the terminal if the search field had focus
    if (hadSearchFocus) {
      try {
        termRef.current?.focus?.()
      } catch {}
    }
  }, [])

  useEffect(() => {
    searchOpenRef.current = searchOpen
  }, [searchOpen])

  useEffect(() => {
    /** @type {import('@xterm/xterm').ITerminalOptions} */
    const baseOpts = {
      // Needed for search decorations and onDidChangeResults
      allowProposedApi: true,
      fontFamily: 'monospace',
      fontSize:
        typeof fontSize === 'number' &&
        Number.isInteger(fontSize) &&
        fontSize > 0
          ? fontSize
          : 14,
      convertEol: true,
      scrollOnUserInput: false,
    }
    if (typeof scrollback === 'number') baseOpts.scrollback = scrollback
    if (cursorStyle !== undefined) baseOpts.cursorStyle = cursorStyle
    const term = new Terminal(baseOpts)

    // remember defaults so that clearing a setting can revert properly
    try {
      defaultsRef.current = {
        scrollback: /** @type {any} */ (term.options).scrollback,
        cursorStyle: /** @type {any} */ (term.options).cursorStyle,
        fontSize: /** @type {any} */ (term.options).fontSize,
      }
    } catch {}

    const themeHandle = attachXtermTheme(term, { area: 'editor' })
    themeHandleRef.current = themeHandle
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    searchRef.current = searchAddon
    // Subscribe to search results updates
    const resultsDisposable = searchAddon.onDidChangeResults?.(
      ({ resultIndex, resultCount }) => {
        setMatchCount(resultCount || 0)
        if ((resultCount || 0) > 0) {
          setMatchIndex(
            resultIndex !== undefined && resultIndex >= 0 ? resultIndex + 1 : 1
          )
        } else {
          setMatchIndex(0)
        }
      }
    )

    fitRef.current = fitAddon

    const el = containerRef.current
    /** @type {MutationObserver | undefined} */
    let styleObserver
    /** @type {(() => void) | undefined} */
    let restoreCreateElement
    if (el) {
      const nonce =
        typeof window !== 'undefined' &&
        /** @type {any} */ (window).__CSP_NONCE__
          ? /** @type {any} */ (window).__CSP_NONCE__
          : undefined
      const ensureStyleNonce = (node) => {
        if (!nonce) {
          return
        }
        if (node instanceof HTMLStyleElement && !node.nonce) {
          node.nonce = nonce
        }
      }
      if (nonce) {
        const ownerDocument = el.ownerDocument
        if (ownerDocument) {
          const originalCreateElement =
            ownerDocument.createElement.bind(ownerDocument)
          ownerDocument.createElement = (tagName, options) => {
            const element = originalCreateElement(tagName, options)
            if (
              typeof tagName === 'string' &&
              tagName.toLowerCase() === 'style' &&
              !element.nonce
            ) {
              element.nonce = nonce
            }
            return element
          }
          restoreCreateElement = () => {
            ownerDocument.createElement = originalCreateElement
          }
        }
        styleObserver = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            mutation.addedNodes.forEach((node) => {
              ensureStyleNonce(node)
              if (node instanceof Element) {
                node.querySelectorAll('style').forEach(ensureStyleNonce)
              }
            })
          }
        })
        styleObserver.observe(el, {
          childList: true,
          subtree: true,
        })
      }
      term.open(el)
      if (nonce) {
        el.querySelectorAll('style').forEach(ensureStyleNonce)
      }
      requestAnimationFrame(() => {
        try {
          fitAddon.fit()
        } catch {}
      })
    }
    termRef.current = term

    // Ctrl/Cmd+F toggles search, Escape closes when terminal has focus
    const keyHandler = (ev) => {
      try {
        const k = String(ev.key || '').toLowerCase()
        if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && k === 'f') {
          ev.preventDefault()
          setSearchOpen(true)
          requestAnimationFrame(() => focusSearchField())
          return false
        }
        if (searchOpenRef.current && k === 'escape') {
          ev.preventDefault?.()
          closeSearch()
          return false
        }
      } catch {}
      return true
    }
    try {
      /** @type {any} */ term.attachCustomKeyEventHandler?.(keyHandler)
    } catch {}

    return () => {
      try {
        themeHandleRef.current?.dispose?.()
      } catch {}
      themeHandleRef.current = undefined
      term.dispose()
      fitRef.current = undefined
      termRef.current = undefined
      searchRef.current = undefined
      try {
        resultsDisposable?.dispose?.()
      } catch {}
      try {
        styleObserver?.disconnect()
      } catch {}
      try {
        restoreCreateElement?.()
      } catch {}
    }
  }, [fontSize, scrollback, cursorStyle, focusSearchField, closeSearch])

  // When the search bar opens/changes, fire an incremental search to update decorations/results
  useEffect(() => {
    if (searchOpen && !prevSearchOpenRef.current) {
      focusSearchField()
    }
    prevSearchOpenRef.current = searchOpen
    // If the query string itself changed, reset previous decorations
    try {
      if (prevQueryRef.current !== query) {
        searchRef.current?.clearDecorations?.()
        prevQueryRef.current = query
      }
    } catch {}

    if (searchOpen && query) {
      doFind('next', true)
    } else {
      setMatchCount(0)
      setMatchIndex(0)
    }
  }, [
    searchOpen,
    query,
    caseSensitive,
    wholeWord,
    useRegex,
    focusSearchField,
    doFind,
  ])

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', height: '100%', width: '100%' }}
      onKeyDown={(e) => {
        if (!searchOpen) return
        if (e.key === 'Enter') {
          doFind(e.shiftKey ? 'prev' : 'next')
          e.preventDefault()
          e.stopPropagation()
        } else if (e.key === 'Escape') {
          closeSearch()
        }
      }}
    >
      <div
        className={`monitor-terminal-search${searchOpen ? ' is-open' : ''}`}
        aria-hidden={!searchOpen}
      >
        <VscodeTextfield
          ref={setInputRef}
          placeholder="Find (⇅ for history)"
          value={query}
          tabIndex={searchOpen ? 0 : -1}
          data-boardlab-monitor-search-input=""
          onInput={(e) => {
            const v = /** @type {any} */ (e).currentTarget?.value ?? ''
            setQuery(v)
            if (v && searchOpen) doFind('next', true)
          }}
          style={{ minWidth: 320 }}
        >
          <VscodeIcon
            slot="content-after"
            name="case-sensitive"
            title="Match Case"
            actionIcon
            className="monitor-terminal-search__icon"
            data-active={caseSensitive ? 'true' : undefined}
            onClick={() => {
              setCaseSensitive((v) => !v)
              focusSearchField()
              if (searchOpen && query) doFind('next')
            }}
            onMouseDown={(e) => e.preventDefault()}
          />
          <VscodeIcon
            slot="content-after"
            name="whole-word"
            title="Match Whole Word"
            actionIcon
            className="monitor-terminal-search__icon"
            data-active={wholeWord ? 'true' : undefined}
            onClick={() => {
              setWholeWord((v) => !v)
              focusSearchField()
              if (searchOpen && query) doFind('next')
            }}
            onMouseDown={(e) => e.preventDefault()}
          />
          <VscodeIcon
            slot="content-after"
            name="regex"
            title="Use Regular Expression"
            actionIcon
            className="monitor-terminal-search__icon"
            data-active={useRegex ? 'true' : undefined}
            onClick={() => {
              setUseRegex((v) => !v)
              focusSearchField()
              if (searchOpen && query) doFind('next')
            }}
            onMouseDown={(e) => e.preventDefault()}
          />
        </VscodeTextfield>
        <div
          className="match-count"
          aria-hidden={!searchOpen}
          // From workbench.desktop.main.css
          style={{
            width: 73,
            maxWidth: 73,
            minWidth: 73,
            paddingLeft: 5,
          }}
        >
          {matchCount > 0
            ? `${matchIndex || 1} of ${matchCount}`
            : 'No results'}
        </div>
        <VscodeIcon
          name="arrow-up"
          title="Previous"
          actionIcon
          className="monitor-terminal-search__icon"
          data-active={undefined}
          onClick={() => {
            if (!searchOpen) return
            focusSearchField()
            if (query) doFind('prev')
          }}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={searchOpen ? 0 : -1}
          style={{ opacity: query && searchOpen ? 1 : 0.5 }}
        />
        <VscodeIcon
          name="arrow-down"
          title="Next"
          actionIcon
          className="monitor-terminal-search__icon"
          data-active={undefined}
          onClick={() => {
            if (!searchOpen) return
            focusSearchField()
            if (query) doFind('next')
          }}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={searchOpen ? 0 : -1}
          style={{ opacity: query && searchOpen ? 1 : 0.5 }}
        />
        <VscodeIcon
          name="close"
          title="Close"
          actionIcon
          className="monitor-terminal-search__icon"
          data-active={undefined}
          onClick={closeSearch}
          tabIndex={searchOpen ? 0 : -1}
        />
      </div>
    </div>
  )
})

export default XtermView
