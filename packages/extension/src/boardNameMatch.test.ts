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
  platformId = 'arduino:mbed_giga',
  platform?:
    | string
    | {
        name?: string
        metadataDeprecated?: boolean
        releaseDeprecated?: boolean
      }
): BoardListItem {
  const options =
    typeof platform === 'string' ? { name: platform } : platform || {}

  return {
    name,
    fqbn,
    isHidden: false,
    platform: {
      metadata: {
        id: platformId,
        deprecated: options.metadataDeprecated === true,
      } as any,
      release:
        options.name || options.releaseDeprecated === true
          ? ({
              name: options.name,
              deprecated: options.releaseDeprecated === true,
            } as any)
          : undefined,
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

  it('prefers a non-deprecated exact match over a deprecated one', () => {
    const boards = [
      createBoard('Arduino Giga', 'vendor:arch:deprecated', 'vendor:arch', {
        name: 'Vendor Boards',
        releaseDeprecated: true,
      }),
      createBoard('Arduino Giga', 'arduino:mbed_giga:giga'),
    ]

    const match = matchBoardByName('Arduino Giga', boards)

    expect(match?.kind).toBe('exact')
    expect(match?.score).toBe(1)
    expect(match?.board.fqbn).toBe('arduino:mbed_giga:giga')
  })

  it('returns score 0 for deprecated exact matches', () => {
    const boards = [
      createBoard('Arduino Legacy', 'vendor:arch:legacy', 'vendor:arch', {
        name: 'Vendor Boards',
        releaseDeprecated: true,
      }),
    ]

    const match = matchBoardByName('Arduino Legacy', boards)

    expect(match?.kind).toBe('exact')
    expect(match?.score).toBe(0)
  })

  it('returns score 0 for explicitly deprecated platform metadata', () => {
    const boards = [
      createBoard('Arduino Legacy', 'vendor:arch:legacy', 'vendor:arch', {
        name: 'Vendor Boards',
        metadataDeprecated: true,
      }),
    ]

    const match = matchBoardByName('Arduino Legacy', boards)

    expect(match?.kind).toBe('exact')
    expect(match?.score).toBe(0)
  })

  it('returns score 0 for explicitly deprecated platform releases', () => {
    const match = matchBoardByName('Arduino Legacy', [
      createBoard('Arduino Legacy', 'vendor:arch:legacy', 'vendor:arch', {
        name: 'Vendor Boards',
        releaseDeprecated: true,
      }),
    ])

    expect(match?.score).toBe(0)
  })

  it('does not return deprecated fuzzy matches', () => {
    const boards = [
      createBoard('Arduino Legacy WiFi', 'vendor:arch:legacy', 'vendor:arch', {
        name: 'Vendor Boards',
        releaseDeprecated: true,
      }),
    ]

    const match = matchBoardByName('Arduino Legacy', boards)

    expect(match).toBeUndefined()
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
