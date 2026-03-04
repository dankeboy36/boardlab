import type { BoardListItem } from 'ardunno-cli/api'
import { describe, expect, it } from 'vitest'

import {
  getOfflinePackageIndexUrl,
  isOfflineBoardListItem,
  mergeBoardSearchResults,
  normalizeOfflineBoardCatalog,
  searchOfflineBoardCatalog,
} from './offlineBoardsCatalog'

function createLiveBoard(
  name: string,
  fqbn: string,
  platformId: string
): BoardListItem {
  return {
    name,
    fqbn,
    isHidden: false,
    platform: {
      metadata: {
        id: platformId,
      } as any,
      release: undefined,
    },
  }
}

describe('normalizeOfflineBoardCatalog', () => {
  it('normalizes boards using canonical platform metadata and skips incomplete entries', () => {
    const catalog = normalizeOfflineBoardCatalog({
      items: [
        {
          normalizedUrl: 'https://vendor.example/package_good_index.json',
          validationStatus: 'accepted',
        },
        {
          normalizedUrl: 'https://vendor.example/package_old_index.json',
          validationStatus: 'accepted',
        },
        {
          normalizedUrl: 'https://vendor.example/package_broken_index.json',
          validationStatus: 'accepted',
        },
      ],
      catalog: {
        platforms: [
          {
            url: 'https://vendor.example/package_old_index.json',
            platformId: 'vendor:arch',
            name: 'Vendor Boards',
            version: '1.0.0',
            maintainer: 'Vendor',
            website: 'https://vendor.example',
            types: ['Contributed'],
          },
          {
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
            name: 'Vendor Boards',
            version: '2.0.0',
            maintainer: 'Vendor',
            website: 'https://vendor.example',
            types: ['Contributed'],
          },
          {
            url: 'https://vendor.example/package_broken_index.json',
            platformId: 'broken:arch',
            name: 'Broken Boards',
            version: '1.0.0',
            deprecated: true,
          },
          {
            url: 'https://vendor.example/package_deprecated_index.json',
            platformId: 'deprecated:arch',
            name: 'Old Boards [Deprecated]',
            version: '9.9.9',
            deprecated: true,
          },
          {
            url: 'https://vendor.example/package_semver_index.json',
            platformId: 'message:arch',
            name: 'Fix in 1.2.3',
            version: '1.0.0',
            deprecated: true,
          },
          {
            url: 'https://vendor.example/package_use_instead_index.json',
            platformId: 'replacement:arch',
            name: 'Use Vendor Boards instead',
            version: '1.0.0',
            deprecated: true,
          },
          {
            url: 'https://vendor.example/package_flagged_index.json',
            platformId: 'flagged:arch',
            name: 'Flagged Boards',
            version: '1.0.0',
            deprecated: true,
          },
          {
            url: 'https://vendor.example/package_incomplete_index.json',
            platformId: 'missing:arch',
            name: '',
            version: '1.0.0',
          },
        ],
        boards: [
          {
            name: 'Vendor Dev Board',
            url: 'https://vendor.example/package_old_index.json',
            platformId: 'vendor:arch',
          },
          {
            name: 'Vendor Dev Board',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
          },
          {
            name: 'Vendor Mini',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
          },
          {
            name: 'Broken Board',
            url: 'https://vendor.example/package_broken_index.json',
            platformId: 'broken:arch',
          },
          {
            name: 'Legacy Board',
            url: 'https://vendor.example/package_deprecated_index.json',
            platformId: 'deprecated:arch',
            deprecated: true,
          },
          {
            name: 'Vendor Mini [Deprecated]',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
            deprecated: true,
          },
          {
            name: 'Read this <br> important',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
            deprecated: true,
          },
          {
            name: 'Avoid this &nbsp; board',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
            deprecated: true,
          },
          {
            name: 'Temporary board 1.2.3',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
            deprecated: true,
          },
          {
            name: 'Use Vendor Mini instead',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
            deprecated: true,
          },
          {
            name: 'Flagged Board',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
            deprecated: true,
          },
          {
            name: 'Incomplete Board',
            url: 'https://vendor.example/package_incomplete_index.json',
            platformId: 'missing:arch',
          },
        ],
      },
    })

    expect(Array.from(catalog.platforms.keys())).toEqual(['vendor:arch'])
    expect(catalog.boards).toHaveLength(2)

    const first = catalog.boards[0]
    expect(first?.name).toBe('Vendor Dev Board')
    expect(first?.platform?.release?.name).toBe('Vendor Boards')
    expect(first?.platform?.release?.version).toBe('2.0.0')
    expect(first?.platform?.metadata?.id).toBe('vendor:arch')
    expect(first?.packageIndexUrl).toBe(
      'https://vendor.example/package_good_index.json'
    )
    expect(first?.packageIndexUrls).toEqual([
      'https://vendor.example/package_good_index.json',
      'https://vendor.example/package_old_index.json',
    ])
  })

  it('excludes official Arduino indexes by default', () => {
    const catalog = normalizeOfflineBoardCatalog({
      items: [
        {
          normalizedUrl:
            'https://downloads.arduino.cc/packages/package_index.json',
          validationStatus: 'accepted',
        },
        {
          normalizedUrl: 'https://vendor.example/package_good_index.json',
          validationStatus: 'accepted',
        },
      ],
      catalog: {
        platforms: [
          {
            url: 'https://downloads.arduino.cc/packages/package_index.json',
            platformId: 'arduino:avr',
            name: 'Arduino AVR Boards',
            version: '1.0.0',
          },
          {
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
            name: 'Vendor Boards',
            version: '1.0.0',
          },
        ],
        boards: [
          {
            name: 'Arduino Uno',
            url: 'https://downloads.arduino.cc/packages/package_index.json',
            platformId: 'arduino:avr',
          },
          {
            name: 'Vendor Dev Board',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
          },
        ],
      },
    })

    expect(Array.from(catalog.platforms.keys())).toEqual(['vendor:arch'])
    expect(catalog.boards.map((board) => board.name)).toEqual([
      'Vendor Dev Board',
    ])
  })
})

describe('searchOfflineBoardCatalog', () => {
  it('matches boards by simple token search and keeps CLI ordering', () => {
    const catalog = normalizeOfflineBoardCatalog({
      items: [
        {
          normalizedUrl: 'https://vendor.example/package_good_index.json',
          validationStatus: 'accepted',
        },
      ],
      catalog: {
        platforms: [
          {
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
            name: 'Vendor Boards',
            version: '1.0.0',
          },
        ],
        boards: [
          {
            name: 'Wroom DevKit',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
          },
          {
            name: 'Alpha Wroom Board',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
          },
          {
            name: 'Other Board',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
          },
        ],
      },
    })

    const results = searchOfflineBoardCatalog(catalog, 'wroom')

    expect(results.map((board) => board.name)).toEqual([
      'Alpha Wroom Board',
      'Wroom DevKit',
    ])
    expect(isOfflineBoardListItem(results[0]!)).toBe(true)
    expect(getOfflinePackageIndexUrl(results[0]!)).toBe(
      'https://vendor.example/package_good_index.json'
    )
  })
})

describe('mergeBoardSearchResults', () => {
  it('prefers live boards when a board/platform pair exists in both sources', () => {
    const catalog = normalizeOfflineBoardCatalog({
      items: [
        {
          normalizedUrl: 'https://vendor.example/package_good_index.json',
          validationStatus: 'accepted',
        },
      ],
      catalog: {
        platforms: [
          {
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
            name: 'Vendor Boards',
            version: '1.0.0',
          },
        ],
        boards: [
          {
            name: 'Vendor Dev Board',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
          },
          {
            name: 'Vendor Mini',
            url: 'https://vendor.example/package_good_index.json',
            platformId: 'vendor:arch',
          },
        ],
      },
    })
    const liveBoards = [
      createLiveBoard('Vendor Dev Board', 'vendor:arch:dev', 'vendor:arch'),
      createLiveBoard(
        'Installed Board',
        'vendor:arch:installed',
        'vendor:arch'
      ),
    ]

    const merged = mergeBoardSearchResults(liveBoards, catalog.boards)

    expect(merged.map((board) => `${board.name}:${board.fqbn}`)).toEqual([
      'Installed Board:vendor:arch:installed',
      'Vendor Dev Board:vendor:arch:dev',
      'Vendor Mini:',
    ])
    expect(isOfflineBoardListItem(merged[1]!)).toBe(false)
    expect(isOfflineBoardListItem(merged[2]!)).toBe(true)
  })
})
