import { describe, expect, it } from 'vitest'

import {
  buildStatusText,
  truncateVisibleAdvanced,
  visibleLength,
} from './statusText'

const stripIcons = (s: string) => s.replace(/\$\([^)]+\)/g, '')

describe('visibleLength', () => {
  it('ignores codicons', () => {
    expect(visibleLength('$(check) Hello')).toBe(6)
  })
  it('counts unicode code points', () => {
    expect(visibleLength('A😀B')).toBe(3)
  })
})

describe('truncateVisibleAdvanced', () => {
  it('end truncates visible part only', () => {
    const s = '$(plug) Connected to a very long device name'
    const out = truncateVisibleAdvanced(s, 20, { position: 'end' })
    expect(out.startsWith('$(plug)')).toBe(true)
    expect(visibleLength(out)).toBeLessThanOrEqual(20)
    expect(stripIcons(out).endsWith('…')).toBe(true)
  })

  it('start trunc keeps tail', () => {
    const s = 'abcdefghijk'
    const out = truncateVisibleAdvanced(s, 5, { position: 'start' })
    expect(visibleLength(out)).toBeLessThanOrEqual(5)
    expect(out.startsWith('…')).toBe(true)
    expect(out.length).toBeGreaterThan(0)
  })

  it('middle trunc keeps both ends', () => {
    const s = 'ESP32-S3-WROOM-1-N8R8'
    const out = truncateVisibleAdvanced(s, 12, { position: 'middle' })
    expect(out.startsWith('ESP32')).toBe(true)
    expect(out.endsWith('N8R8')).toBe(true)
    expect(visibleLength(out)).toBeLessThanOrEqual(12)
  })

  it('prefers breaking on spaces when available', () => {
    const s = 'Arduino Mega 2560 Rev3 Board'
    const out = truncateVisibleAdvanced(s, 14, {
      position: 'middle',
      preferSpace: true,
    })
    expect(out.includes(' … ')).toBe(true)
  })
})

describe('buildStatusText', () => {
  it('binds sketch with profile and progress inside parentheses', () => {
    const out = buildStatusText({
      icon: '$(dashboard)',
      board: 'ESP32-S3-WROOM-1-N8R8',
      port: 'serial:///dev/tty.usbserial-1410@921600',
      sketch: 'blink.ino',
      profile: 'dev',
      progress: { spinning: true, message: 'Compiling' },
      maxVisible: 120,
    })
    expect(out).toContain('$(dashboard)')
    expect(out).toMatch(
      /\(blink\.ino • \$\(account\) dev .*?\$\(sync~spin\) Compiling\)/
    )
  })

  it('respects global maxVisible', () => {
    const out = buildStatusText({
      icon: '$(dashboard)',
      board: 'VeryVeryLongBoardName 123-ABC',
      port: 'serial:///dev/tty.usbserial-1410@921600',
      sketch: 'my-super-long-sketch-name.ino',
      profile: 'dev',
      maxVisible: 40,
    })
    expect(
      visibleLength(out.replace(/^\$\([^)]+\)\s*/, ''))
    ).toBeLessThanOrEqual(40)
  })

  it('uses middle truncation for board and end for others', () => {
    const out = buildStatusText({
      icon: '$(dashboard)',
      board: 'ESP32-S3-WROOM-1-N8R8',
      port: 'serial:///dev/tty.usbserial-1410@921600',
      sketch: 'really-really-long-sketch-name.ino',
      maxVisible: 30,
    })
    const parts = out.split(' ')
    const boardPart =
      parts.find((p) => p.includes('ESP32') || p.includes('WROOM')) || ''
    expect(boardPart.includes('…')).toBe(true)
  })

  it('shows percent progress when provided', () => {
    const out = buildStatusText({
      icon: '$(dashboard)',
      sketch: 'blink.ino',
      progress: { percent: 42, message: 'Compiling' },
      maxVisible: 80,
    })
    expect(out).toContain('42%')
  })
})
