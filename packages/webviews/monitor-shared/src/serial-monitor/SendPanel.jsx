// @ts-check
import { useCallback, useEffect, useRef, useState } from 'react'
import { VscodeIcon } from 'vscode-react-elements-x'

import SendText from './SendText.jsx'

const HISTORY_KEY = 'boardlab.monitor.serialInput.history'
const MAX_HISTORY = 20

/** @typedef {'none' | 'lf' | 'cr' | 'crlf'} LineEnding */

/**
 * Combined send input + EOL select. Emits processed payload on send.
 *
 * @param {{
 *   disabled?: boolean
 *   onSend?: (text: string) => void
 *   lineEnding: LineEnding
 *   placeholder?: string
 * }} props
 */
export default function SendPanel({
  disabled,
  onSend,
  lineEnding,
  placeholder,
}) {
  const [text, setText] = useState('')
  const [history, setHistory] = useState(/** @type {string[]} */ ([]))
  const [historyIndex, setHistoryIndex] = useState(-1)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      if (raw) setHistory(JSON.parse(raw))
    } catch {}
  }, [])

  const saveHistory = useCallback((/** @type {string[]} */ items) => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items))
    } catch {}
  }, [])

  const doSend = useCallback(
    (/** @type {string} */ typed, /** @type {string} */ finalMessage) => {
      const last = history[history.length - 1]
      const nextHistory =
        typed && typed !== last
          ? [...history.slice(-MAX_HISTORY + 1), typed]
          : history
      if (nextHistory !== history) {
        setHistory(nextHistory)
        saveHistory(nextHistory)
      }
      setHistoryIndex(-1)
      onSend?.(finalMessage)
      setText('')
    },
    [onSend, history, saveHistory]
  )

  const submitRef = useRef(/** @type {(() => void) | undefined} */ (undefined))

  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        padding: 4,
        flex: 1,
        minWidth: 0,
      }}
    >
      <SendText
        disabled={!!disabled}
        value={text}
        onChange={setText}
        onSubmit={(prepared) => {
          const suffix =
            lineEnding === 'lf'
              ? '\n'
              : lineEnding === 'cr'
                ? '\r'
                : lineEnding === 'crlf'
                  ? '\r\n'
                  : ''
          doSend(prepared, prepared + suffix)
        }}
        registerSubmitter={(fn) => (submitRef.current = fn)}
        onHistoryPrev={() => {
          if (!history.length) return text
          const nextIndex =
            historyIndex < 0
              ? history.length - 1
              : Math.max(0, historyIndex - 1)
          setHistoryIndex(nextIndex)
          return history[nextIndex] ?? ''
        }}
        onHistoryNext={() => {
          if (!history.length) return text
          const nextIndex =
            historyIndex < 0
              ? -1
              : Math.min(history.length - 1, historyIndex + 1)
          setHistoryIndex(nextIndex)
          return nextIndex === -1 ? '' : (history[nextIndex] ?? '')
        }}
        placeholder={placeholder}
      />
      <VscodeIcon
        name="send"
        title={disabled ? 'Select a port first' : 'Send'}
        actionIcon
        onClick={() => submitRef.current?.()}
        style={{
          opacity: disabled || text.length === 0 ? 0.6 : 1,
          pointerEvents: disabled || text.length === 0 ? 'none' : undefined,
        }}
      />
    </div>
  )
}
