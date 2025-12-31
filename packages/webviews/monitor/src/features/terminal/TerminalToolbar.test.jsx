// @ts-check
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import TerminalToolbar from './TerminalToolbar.jsx'

describe('TerminalToolbar', () => {
  afterEach(() => cleanup())

  it('wires the toolbar button clicks', () => {
    const onCopy = vi.fn()
    const onSave = vi.fn()
    const onClear = vi.fn()
    const onToggleScrollLock = vi.fn()
    render(
      <TerminalToolbar
        onCopy={onCopy}
        onSave={onSave}
        onClear={onClear}
        scrollLock={false}
        onToggleScrollLock={onToggleScrollLock}
      />
    )
    fireEvent.click(screen.getByTitle('Save to file'))
    fireEvent.click(screen.getByTitle('Copy all'))
    fireEvent.click(screen.getByTitle('Clear terminal'))
    fireEvent.click(screen.getByTitle('Toggle scroll lock'))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onToggleScrollLock).toHaveBeenCalledTimes(1)
  })
})
