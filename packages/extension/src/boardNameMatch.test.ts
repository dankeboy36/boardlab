import type { BoardListItem } from 'ardunno-cli/api'
import { describe, expect, it } from 'vitest'

import {
  findBoardHistoryMatches,
  matchBoardByName,
  normalizeBoardName,
} from './boardNameMatch'

function createBoard(
  name: string,
  fqbn: string,
  platformId = 'arduino:mbed_giga'
): BoardListItem {
  return {
    name,
    fqbn,
    isHidden: false,
    platform: {
      metadata: { id: platformId } as any,
      release: undefined,
    },
  }
}

describe('matchBoardByName', () => {
  it('returns exact match for normalized equality', () => {
    const boards = [createBoard('Arduino Giga', 'arduino:mbed_giga:giga')]

    const match = matchBoardByName('Arduino Giga', boards, {
      platformId: 'arduino:mbed_giga',
    })

    expect(match?.kind).toBe('exact')
    expect(match?.board.fqbn).toBe('arduino:mbed_giga:giga')
  })

  it('returns normalized match when compact names match', () => {
    const boards = [createBoard('Arduino Foo Bar', 'arduino:mbed_giga:foobar')]

    const match = matchBoardByName('Arduino foobar', boards, {
      platformId: 'arduino:mbed_giga',
    })

    expect(match?.kind).toBe('normalized')
    expect(match?.board.name).toBe('Arduino Foo Bar')
  })

  it('returns fuzzy match for partial token overlap', () => {
    const boards = [
      createBoard('Arduino Giga R1 WiFi', 'arduino:mbed_giga:giga_r1'),
      createBoard('Arduino Uno', 'arduino:avr:uno', 'arduino:avr'),
    ]

    const match = matchBoardByName('Arduino Giga', boards, {
      platformId: 'arduino:mbed_giga',
    })

    expect(match?.kind).toBe('fuzzy')
    expect(match?.board.name).toBe('Arduino Giga R1 WiFi')
  })
})

describe('normalizeBoardName', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeBoardName('Arduino   Giga')).toBe('arduino giga')
  })
})

describe('findBoardHistoryMatches', () => {
  it('returns history items with matching names and no fqbn', () => {
    const history = [
      { name: 'Arduino foobar', fqbn: undefined },
      { name: 'Arduino Uno', fqbn: 'arduino:avr:uno' },
    ] as any

    const matches = findBoardHistoryMatches(history, 'Arduino foobar')

    expect(matches).toHaveLength(1)
    expect(matches[0]?.name).toBe('Arduino foobar')
  })
})
