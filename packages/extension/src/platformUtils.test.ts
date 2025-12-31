import { describe, expect, it } from 'vitest'

import {
  collectHistoryUpdates,
  extractPlatformIdFromError,
  matchesPlatformId,
  platformIdFromFqbn,
  toUnresolvedBoard,
} from './platformUtils'

describe('platformIdFromFqbn', () => {
  it('extracts vendor and arch', () => {
    expect(platformIdFromFqbn('arduino:mbed_giga:giga')).toBe(
      'arduino:mbed_giga'
    )
  })

  it('handles fqbn options', () => {
    expect(platformIdFromFqbn('arduino:mbed_giga:giga:foo=bar')).toBe(
      'arduino:mbed_giga'
    )
  })
})

describe('matchesPlatformId', () => {
  it('matches fqbn to platform id', () => {
    expect(matchesPlatformId('arduino:avr:uno', 'arduino:avr')).toBe(true)
  })

  it('returns false when platform id differs', () => {
    expect(matchesPlatformId('arduino:avr:uno', 'arduino:samd')).toBe(false)
  })
})

describe('extractPlatformIdFromError', () => {
  it('parses platform id from message', () => {
    const error = new Error(
      "Platform 'arduino:mbed_giga' not found: platform not installed"
    )
    expect(extractPlatformIdFromError(error)).toBe('arduino:mbed_giga')
  })

  it('returns undefined when missing', () => {
    expect(extractPlatformIdFromError('no platform here')).toBeUndefined()
  })
})

describe('collectHistoryUpdates', () => {
  it('collects removals and replacements for matching platform', () => {
    const updates = collectHistoryUpdates(
      [
        { name: 'Arduino Giga', fqbn: 'arduino:mbed_giga:giga' },
        { name: 'Arduino Uno', fqbn: 'arduino:avr:uno' },
      ],
      'arduino:mbed_giga'
    )

    expect(updates.remove).toHaveLength(1)
    expect(updates.remove[0]?.name).toBe('Arduino Giga')
    expect(updates.add).toHaveLength(1)
    expect(updates.add[0]?.fqbn).toBeUndefined()
  })
})

describe('toUnresolvedBoard', () => {
  it('returns an unresolved board with platform info', () => {
    const unresolved = toUnresolvedBoard(
      { name: 'Arduino Giga', fqbn: 'arduino:mbed_giga:giga' },
      { id: 'arduino:mbed_giga', name: 'Arduino Mbed OS Giga Boards' }
    )

    expect(unresolved.fqbn).toBeUndefined()
    expect((unresolved as any).platform.metadata.id).toBe('arduino:mbed_giga')
  })
})
