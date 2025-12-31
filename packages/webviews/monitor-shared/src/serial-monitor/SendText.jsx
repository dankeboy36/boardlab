// @ts-check
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { VscodeTextarea } from 'vscode-react-elements-x'

/**
 * Multiline send input with history and Enter-to-send handling.
 *
 * @param {{
 *   disabled?: boolean
 *   value: string
 *   onChange: (v: string) => void
 *   onSubmit: (prepared: string) => void
 *   onHistoryPrev?: () => string | undefined // returns new value
 *   onHistoryNext?: () => string | undefined // returns new value
 *   registerSubmitter?: (fn: () => void) => void
 *   placeholder?: string
 * }} props
 */
function SendText({
  disabled,
  value,
  onChange,
  onSubmit,
  onHistoryPrev,
  onHistoryNext,
  registerSubmitter,
  placeholder,
}) {
  const valueRef = useRef(value ?? '')
  useEffect(() => {
    valueRef.current = value ?? ''
  }, [value])

  const submit = useCallback(() => {
    const current = valueRef.current
    if (!current) return
    onSubmit(current)
  }, [onSubmit])

  // Allow parent to trigger submit programmatically
  useEffect(() => {
    if (registerSubmitter) {
      registerSubmitter(submit)
    }
  }, [registerSubmitter, submit])

  const normalizedLines = useMemo(() => {
    const text = value ?? ''
    return text.replace(/\r\n/g, '\n').split('\n')
  }, [value])

  const rows = Math.min(5, Math.max(1, normalizedLines.length))

  const onKeyDown = useCallback(
    (
      /**
       * @type {import('react').KeyboardEvent<
       *   import('vscode-elements-x').VscodeTextarea
       * >}
       */ e
    ) => {
      if (!e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          const v = onHistoryPrev?.()
          if (typeof v === 'string') {
            valueRef.current = v
            onChange(v)
          }
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          const v = onHistoryNext?.()
          if (typeof v === 'string') {
            valueRef.current = v
            onChange(v)
          }
          return
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submit()
      }
    },
    [submit, onChange, onHistoryPrev, onHistoryNext]
  )

  return (
    <VscodeTextarea
      name="serial-input"
      placeholder={placeholder}
      value={value ?? ''}
      rows={rows}
      resize="vertical"
      onInput={(e) => {
        const nextValue = /** @type {any} */ (e).target?.value ?? ''
        valueRef.current = nextValue
        onChange(nextValue)
      }}
      onKeyDown={onKeyDown}
      disabled={!!disabled}
      style={{
        flex: 1,
        minWidth: 0,
        // height: 24, // from VS Code Search input
        // and textarea of vscode-textarea should have align-content: center
      }}
    />
  )
}

export default SendText
