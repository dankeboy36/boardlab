// @ts-check
import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  VscodeLabel,
  VscodeOption,
  VscodeSingleSelect,
  VscodeTextfield,
} from 'vscode-react-elements-x'

import { selectTerminalSettings } from '../terminal/terminalSelectors.js'
import {
  setCursorStyle,
  setFontSize,
  setScrollback,
} from '../terminal/terminalSettingsSlice.js'

const CURSOR_ITEMS = [
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Underline' },
  { value: 'bar', label: 'Bar' },
]

export default function TerminalSettings() {
  const settings = useSelector(selectTerminalSettings)
  const dispatch = useDispatch()
  const [scrollbackStr, setScrollbackStr] = useState('')
  const [invalidScrollbackError, setInvalidScrollbackError] = useState(
    /** @type {string | undefined} */ (undefined)
  )
  const [fontSizeStr, setFontSizeStr] = useState('')
  const [invalidFontError, setInvalidFontError] = useState(
    /** @type {string | undefined} */ (undefined)
  )

  useEffect(() => {
    setScrollbackStr(
      settings.scrollback != null ? String(settings.scrollback) : ''
    )
    setInvalidScrollbackError(undefined)
  }, [settings.scrollback])

  useEffect(() => {
    setFontSizeStr(settings.fontSize != null ? String(settings.fontSize) : '')
    setInvalidFontError(undefined)
  }, [settings.fontSize])

  const cursorValue = useMemo(
    () => settings.cursorStyle ?? '',
    [settings.cursorStyle]
  )

  const validateScrollback = (text) => {
    if (text.trim() === '') return { ok: true, value: undefined }
    if (!/^\d+$/.test(text)) return { ok: false, error: 'Not a number' }
    const n = Number(text)
    if (!Number.isInteger(n)) {
      return { ok: false, error: 'Not an integer' }
    }
    if (n < 0) {
      return { ok: false, error: 'Negative number' }
    }
    return { ok: true, value: n }
  }

  const validateFontSize = (text) => {
    if (text.trim() === '') return { ok: true, value: undefined }
    if (!/^\d+$/.test(text)) return { ok: false, error: 'Not a number' }
    const n = Number(text)
    if (!Number.isInteger(n)) {
      return { ok: false, error: 'Not an integer' }
    }
    if (n < 0) {
      return { ok: false, error: 'Negative number' }
    }
    if (n > 256) {
      return { ok: false, error: 'Too large' }
    }
    return { ok: true, value: n }
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(140px, 32%) minmax(220px, 1fr) auto',
        columnGap: 12,
        rowGap: 8,
        alignItems: 'center',
      }}
    >
      <VscodeLabel
        htmlFor="scrollback"
        style={{ opacity: 0.9, whiteSpace: 'nowrap' }}
      >
        <span className="normal">Scrollback</span>
      </VscodeLabel>
      <VscodeTextfield
        id="scrollback"
        placeholder="empty = 1000"
        value={scrollbackStr}
        onInput={(e) => {
          const v = /** @type {any} */ (e).target?.value ?? ''
          setScrollbackStr(v)
          const res = validateScrollback(v)
          setInvalidScrollbackError(res.error)
          if (res.ok) dispatch(setScrollback(res.value))
        }}
        invalid={!!invalidScrollbackError}
        style={{
          gridColumn: '2 / span 2',
          width: '100%',
          maxWidth: 420,
          justifySelf: 'end',
          minWidth: 0,
          boxSizing: 'border-box',
        }}
      />

      <VscodeLabel
        htmlFor="font-size"
        style={{ opacity: 0.9, whiteSpace: 'nowrap' }}
      >
        <span className="normal">Font Size</span>
      </VscodeLabel>
      <VscodeTextfield
        id="font-size"
        placeholder="empty = 14"
        value={fontSizeStr}
        onInput={(e) => {
          const v = /** @type {any} */ (e).target?.value ?? ''
          setFontSizeStr(v)
          const res = validateFontSize(v)
          setInvalidFontError(res.error)
          if (res.ok) dispatch(setFontSize(res.value))
        }}
        invalid={!!invalidFontError}
        style={{
          gridColumn: '2 / span 2',
          width: '100%',
          maxWidth: 420,
          justifySelf: 'end',
          minWidth: 0,
          boxSizing: 'border-box',
        }}
      />

      <VscodeLabel
        htmlFor="cursor-style"
        style={{ opacity: 0.9, whiteSpace: 'nowrap' }}
      >
        <span className="normal">Cursor Style</span>
      </VscodeLabel>
      <VscodeSingleSelect
        id="cursor-style"
        value={cursorValue}
        onChange={(e) => {
          const v = /** @type {any} */ (e).target?.value ?? ''
          dispatch(setCursorStyle(v === '' ? undefined : v))
        }}
        style={{
          gridColumn: '2 / span 2',
          width: '100%',
          minWidth: 220,
          maxWidth: 420,
          justifySelf: 'end',
          boxSizing: 'border-box',
        }}
      >
        {CURSOR_ITEMS.map((i) => (
          <VscodeOption key={i.value} value={i.value}>
            {i.label}
          </VscodeOption>
        ))}
      </VscodeSingleSelect>
    </div>
  )
}
