import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SendPanel } from '@boardlab/monitor-shared/serial-monitor'

const HISTORY_KEY = 'boardlab.monitor.serialInput.history'

describe('SendPanel', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('sends the suffix-appended payload but keeps the raw input in history', async () => {
    const onSend = vi.fn()
    const placeholder = 'Type something'

    const { getByPlaceholderText, getByTitle } = render(
      <SendPanel
        disabled={false}
        lineEnding="crlf"
        onSend={onSend}
        placeholder={placeholder}
      />
    )

    const textarea = getByPlaceholderText(placeholder)
    fireEvent.input(textarea, {
      target: { value: 'hello' },
    })
    fireEvent.change(textarea, {
      target: { value: 'hello' },
    })

    fireEvent.click(getByTitle('Send'))

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('hello\r\n')
    })
    expect(localStorage.getItem(HISTORY_KEY)).toBe(JSON.stringify(['hello']))
  })
})
