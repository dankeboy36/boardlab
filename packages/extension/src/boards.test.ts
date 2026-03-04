import type { BoardListItem } from 'ardunno-cli/api'
import {
  createPortKey,
  type BoardIdentifier,
  type BoardsList,
  type DetectedPorts,
} from 'boards-list'
import { describe, expect, it } from 'vitest'
import * as vscode from 'vscode'

import type { Arduino } from './cli/arduino'

const loadBoardsModule = async () => import('./boards')

function createBoardIdentifier(name: string, fqbn: string): BoardIdentifier {
  return {
    name,
    fqbn,
  }
}

function createBoardListItem(board: BoardIdentifier): BoardListItem {
  return {
    name: board.name,
    fqbn: board.fqbn ?? '',
    isHidden: false,
  } as unknown as BoardListItem
}

function createBoardsList(
  boards: Array<
    BoardIdentifier | { board: BoardIdentifier; portAddress: string }
  >
): BoardsList {
  return {
    boards: boards.map((entry) => {
      if ('board' in entry) {
        return {
          port: {
            protocol: 'serial',
            address: entry.portAddress,
            label: entry.portAddress,
            protocolLabel: 'Serial Port',
          },
          board: entry.board,
        }
      }
      return {
        port: {},
        board: entry,
      }
    }),
    portsGroupedByProtocol() {
      return {}
    },
  } as unknown as BoardsList
}

function labelsOf(items: readonly any[]): string[] {
  return items
    .filter((item) => item && typeof item.label === 'string')
    .map((item) => item.label as string)
}

function findByLabel(items: readonly any[], label: string): any {
  return items.find((item) => item?.label === label)
}

function labelsInRange(
  items: readonly any[],
  fromLabel: string,
  untilLabel?: string
): string[] {
  const labels = labelsOf(items)
  const fromIndex = labels.indexOf(fromLabel)
  if (fromIndex < 0) {
    return []
  }
  const tail = labels.slice(fromIndex + 1)
  if (!untilLabel) {
    return tail
  }
  const untilIndex = tail.indexOf(untilLabel)
  return untilIndex < 0 ? tail : tail.slice(0, untilIndex)
}

class FakeQuickPick {
  items: vscode.QuickPickItem[] = []
  busy = false
  placeholder = ''
  ignoreFocusOut = false
  matchOnDescription = false
  matchOnDetail = false
  value = ''
  readonly onDidChangeSelectionEmitter = new vscode.EventEmitter<
    vscode.QuickPickItem[]
  >()

  readonly onDidChangeValueEmitter = new vscode.EventEmitter<string>()
  readonly onDidHideEmitter = new vscode.EventEmitter<void>()
  readonly onDidTriggerItemButtonEmitter = new vscode.EventEmitter<{
    button: vscode.QuickInputButton
    item: vscode.QuickPickItem
  }>()

  readonly onDidChangeSelection = this.onDidChangeSelectionEmitter.event
  readonly onDidChangeValue = this.onDidChangeValueEmitter.event
  readonly onDidHide = this.onDidHideEmitter.event
  readonly onDidTriggerItemButton = this.onDidTriggerItemButtonEmitter.event

  show(): void {
    // NOOP
  }

  hide(): void {
    this.onDidHideEmitter.fire()
  }

  dispose(): void {
    this.onDidChangeSelectionEmitter.dispose()
    this.onDidChangeValueEmitter.dispose()
    this.onDidHideEmitter.dispose()
    this.onDidTriggerItemButtonEmitter.dispose()
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 1_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

describe('toBoardQuickPickItems (history + search interaction)', () => {
  it('shows no entries when no search is active', async () => {
    const { toBoardQuickPickItems } = await loadBoardsModule()

    const items = await toBoardQuickPickItems(
      createBoardsList([]),
      undefined,
      [],
      []
    )

    expect(items).toEqual([])
  })

  it('does not show history boards that are not in search results', async () => {
    const { toBoardQuickPickItems } = await loadBoardsModule()

    const uno = createBoardIdentifier('Arduino Uno', 'arduino:avr:uno')
    const esp = createBoardIdentifier('ESP32 Dev', 'esp32:esp32:dev')

    const boardsList = createBoardsList([])
    const searchResults: BoardListItem[] = [createBoardListItem(esp)]
    const pinned: BoardIdentifier[] = [uno]
    const recent: BoardIdentifier[] = [uno]

    const items = await toBoardQuickPickItems(
      boardsList,
      searchResults.slice(),
      pinned,
      recent
    )

    const labels = labelsOf(items)
    expect(labels).toContain('ESP32 Dev')
    expect(labels).not.toContain('Arduino Uno')
  })

  it('shows a board only once when it is both in history and search results', async () => {
    const { toBoardQuickPickItems } = await loadBoardsModule()

    const uno = createBoardIdentifier('Arduino Uno', 'arduino:avr:uno')

    const boardsList = createBoardsList([])
    const searchResults: BoardListItem[] = [createBoardListItem(uno)]
    const pinned: BoardIdentifier[] = [uno]
    const recent: BoardIdentifier[] = [uno]

    const items = await toBoardQuickPickItems(
      boardsList,
      searchResults.slice(),
      pinned,
      recent
    )

    const labels = labelsOf(items)
    const unoCount = labels.filter((label) => label === 'Arduino Uno').length
    expect(unoCount).toBe(1)
  })

  it('hides attached section when attached boards are filtered out', async () => {
    const { toBoardQuickPickItems } = await loadBoardsModule()

    const uno = createBoardIdentifier('Arduino Uno', 'arduino:avr:uno')
    const boardsList = createBoardsList([uno])

    const items = await toBoardQuickPickItems(boardsList, undefined, [], [], {
      filters: [({ board }) => !!board.fqbn && board.fqbn.includes(':esp32:')],
    })

    const labels = labelsOf(items)
    expect(labels).not.toContain('attached boards')
    expect(items).toEqual([])
  })

  it('shows offline-catalog and add-url actions when a search has no matches', async () => {
    const { toBoardQuickPickItems } = await loadBoardsModule()

    const items = await toBoardQuickPickItems(
      createBoardsList([]),
      [],
      [],
      [],
      {
        searchValue: 'wroom',
        canIncludeOfflineCatalog: true,
        canAddPackageIndexUrlAction: true,
      }
    )

    expect(labelsOf(items)).toEqual([
      'No matching boards for "wroom"',
      'Include offline 3rd-party board catalog',
      'Add 3rd-party package index URL',
    ])
  })

  it('only shows add-url action when offline catalog is already enabled', async () => {
    const { toBoardQuickPickItems } = await loadBoardsModule()

    const items = await toBoardQuickPickItems(
      createBoardsList([]),
      [],
      [],
      [],
      {
        searchValue: 'wroom',
        offlineCatalogEnabled: true,
        canIncludeOfflineCatalog: true,
        canAddPackageIndexUrlAction: true,
      }
    )

    expect(labelsOf(items)).toEqual([
      'No matching boards for "wroom"',
      'Add 3rd-party package index URL',
    ])
  })

  it('shows recent board with port when the board is currently identified', async () => {
    const { toBoardQuickPickItems } = await loadBoardsModule()

    const uno = createBoardIdentifier('Arduino Uno', 'arduino:avr:uno')

    const unresolved = await toBoardQuickPickItems(
      createBoardsList([]),
      undefined,
      [],
      [uno]
    )
    expect(findByLabel(unresolved, 'Arduino Uno')?.description).toBeUndefined()

    const resolved = await toBoardQuickPickItems(
      createBoardsList([{ board: uno, portAddress: '/dev/ttyACM0' }]),
      undefined,
      [],
      [uno]
    )
    expect(findByLabel(resolved, 'Arduino Uno')?.description).toBe(
      'on /dev/ttyACM0'
    )
  })

  it('does not resolve a history board without fqbn', async () => {
    const { toBoardQuickPickItems } = await loadBoardsModule()

    const historyOnlyName = { name: 'Arduino Uno' } as BoardIdentifier
    const attached = createBoardIdentifier('Arduino Uno', 'arduino:avr:uno')

    const items = await toBoardQuickPickItems(
      createBoardsList([{ board: attached, portAddress: '/dev/ttyACM0' }]),
      undefined,
      [],
      [historyOnlyName]
    )
    expect(findByLabel(items, 'Arduino Uno')?.description).toBeUndefined()
  })

  it('limits recent history to 3 items and excludes boards already pinned', async () => {
    const { toBoardQuickPickItems } = await loadBoardsModule()

    const b1 = createBoardIdentifier('B1', 'a:b:1')
    const b2 = createBoardIdentifier('B2', 'a:b:2')
    const b3 = createBoardIdentifier('B3', 'a:b:3')
    const b4 = createBoardIdentifier('B4', 'a:b:4')

    const items = await toBoardQuickPickItems(
      createBoardsList([]),
      undefined,
      [b1],
      [b1, b2, b3, b4]
    )
    const recentLabels = labelsInRange(items, 'recent boards')
    expect(recentLabels).toEqual(['B2', 'B3', 'B4'])
  })
})

describe('getBoardPickerPlaceholder', () => {
  it('indicates when the offline catalog is enabled', async () => {
    const { getBoardPickerPlaceholder } = await loadBoardsModule()

    expect(getBoardPickerPlaceholder(false)).toBe(
      "Filter boards by name or FQBN. For example, 'Arduino UNO' or 'avr:uno'"
    )
    expect(getBoardPickerPlaceholder(true)).toBe(
      "Filter boards by name or FQBN. For example, 'Arduino UNO' or 'avr:uno' (offline 3rd-party catalog enabled)"
    )
  })
})

describe('searchBoardsForPicker', () => {
  it('does not merge offline catalog matches unless explicitly enabled', async () => {
    const { searchBoardsForPicker } = await loadBoardsModule()
    const { normalizeOfflineBoardCatalog } = await import(
      './offlineBoardsCatalog'
    )

    const offlineCatalog = normalizeOfflineBoardCatalog({
      items: [
        {
          normalizedUrl: 'https://vendor.example/package_vendor_index.json',
          validationStatus: 'accepted',
        },
      ],
      catalog: {
        platforms: [
          {
            url: 'https://vendor.example/package_vendor_index.json',
            platformId: 'vendor:esp32',
            name: 'Vendor ESP32 Boards',
            version: '1.0.0',
          },
        ],
        boards: [
          {
            name: 'Wroom DevKit',
            url: 'https://vendor.example/package_vendor_index.json',
            platformId: 'vendor:esp32',
          },
        ],
      },
    })

    const arduino = {
      searchBoard: async () => [
        createBoardListItem(
          createBoardIdentifier('Arduino Uno', 'arduino:avr:uno')
        ),
      ],
    }

    const results = await searchBoardsForPicker(
      arduino as unknown as Arduino,
      'wroom',
      undefined,
      { offlineCatalog }
    )

    expect(results.map((board) => `${board.name}:${board.fqbn}`)).toEqual([
      'Arduino Uno:arduino:avr:uno',
    ])
  })

  it('merges live board search results with offline catalog matches', async () => {
    const { searchBoardsForPicker } = await loadBoardsModule()
    const { normalizeOfflineBoardCatalog } = await import(
      './offlineBoardsCatalog'
    )

    const offlineCatalog = normalizeOfflineBoardCatalog({
      items: [
        {
          normalizedUrl: 'https://vendor.example/package_vendor_index.json',
          validationStatus: 'accepted',
        },
      ],
      catalog: {
        platforms: [
          {
            url: 'https://vendor.example/package_vendor_index.json',
            platformId: 'vendor:esp32',
            name: 'Vendor ESP32 Boards',
            version: '1.0.0',
          },
        ],
        boards: [
          {
            name: 'Wroom DevKit',
            url: 'https://vendor.example/package_vendor_index.json',
            platformId: 'vendor:esp32',
          },
        ],
      },
    })

    const arduino = {
      searchBoard: async () => [
        createBoardListItem(
          createBoardIdentifier('Arduino Uno', 'arduino:avr:uno')
        ),
      ],
    }

    const results = await searchBoardsForPicker(
      arduino as unknown as Arduino,
      'wroom',
      undefined,
      {
        offlineCatalog,
        includeOfflineCatalog: true,
      }
    )

    expect(results.map((board) => `${board.name}:${board.fqbn}`)).toEqual([
      'Arduino Uno:arduino:avr:uno',
      'Wroom DevKit:',
    ])
  })
})

describe('pickBoard (live detected ports refresh)', () => {
  it('enables the offline catalog from the no-match action', async () => {
    const { pickBoard } = await loadBoardsModule()

    const fakeQuickPick = new FakeQuickPick()
    Object.defineProperty(vscode, 'window', {
      configurable: true,
      writable: true,
      value: { createQuickPick: () => fakeQuickPick },
    })
    Object.defineProperty(vscode, 'commands', {
      configurable: true,
      writable: true,
      value: {
        executeCommand: async () => undefined,
      },
    })

    const onDidChangeDetectedPorts = new vscode.EventEmitter<void>()
    const arduino = {
      searchBoard: async () => [],
    }

    try {
      const pickPromise = pickBoard(
        arduino as unknown as Arduino,
        undefined,
        () => ({}),
        onDidChangeDetectedPorts.event,
        undefined,
        undefined,
        {
          offlineCatalog: {
            platforms: new Map(),
            boards: [],
          },
        }
      )

      fakeQuickPick.onDidChangeValueEmitter.fire('zzzzzz-no-match')

      await waitFor(
        () =>
          !!findByLabel(
            fakeQuickPick.items,
            'Include offline 3rd-party board catalog'
          )
      )

      const item = findByLabel(
        fakeQuickPick.items,
        'Include offline 3rd-party board catalog'
      )
      fakeQuickPick.onDidChangeSelectionEmitter.fire([item])

      await waitFor(() =>
        fakeQuickPick.placeholder.includes('offline 3rd-party catalog enabled')
      )
      await waitFor(
        () =>
          !findByLabel(
            fakeQuickPick.items,
            'Include offline 3rd-party board catalog'
          )
      )
      expect(
        findByLabel(fakeQuickPick.items, 'Add 3rd-party package index URL')
      ).toBeTruthy()

      fakeQuickPick.hide()
      await pickPromise
    } finally {
      onDidChangeDetectedPorts.dispose()
      // @ts-ignore
      delete vscode.window
      // @ts-ignore
      delete vscode.commands
    }
  })

  it('runs the add-url command from the no-match action', async () => {
    const { pickBoard } = await loadBoardsModule()

    const fakeQuickPick = new FakeQuickPick()
    const executedCommands: string[] = []
    Object.defineProperty(vscode, 'window', {
      configurable: true,
      writable: true,
      value: { createQuickPick: () => fakeQuickPick },
    })
    Object.defineProperty(vscode, 'commands', {
      configurable: true,
      writable: true,
      value: {
        executeCommand: async (command: string) => {
          executedCommands.push(command)
          return undefined
        },
      },
    })

    const onDidChangeDetectedPorts = new vscode.EventEmitter<void>()
    const arduino = {
      searchBoard: async () => [],
    }

    try {
      const pickPromise = pickBoard(
        arduino as unknown as Arduino,
        undefined,
        () => ({}),
        onDidChangeDetectedPorts.event,
        undefined,
        undefined,
        {
          offlineCatalog: {
            platforms: new Map(),
            boards: [],
          },
        }
      )

      fakeQuickPick.onDidChangeValueEmitter.fire('zzzzzz-no-match')

      await waitFor(
        () =>
          !!findByLabel(fakeQuickPick.items, 'Add 3rd-party package index URL')
      )

      const item = findByLabel(
        fakeQuickPick.items,
        'Add 3rd-party package index URL'
      )
      fakeQuickPick.onDidChangeSelectionEmitter.fire([item])

      await pickPromise

      expect(executedCommands).toContain(
        'boardlab.addAdditionalPackageIndexUrlToArduinoCliConfig'
      )
    } finally {
      onDidChangeDetectedPorts.dispose()
      // @ts-ignore
      delete vscode.window
      // @ts-ignore
      delete vscode.commands
    }
  })

  it('updates recent board item when detected ports change while picker is open', async () => {
    const { InmemoryRecentBoards, pickBoard } = await loadBoardsModule()

    const fakeQuickPick = new FakeQuickPick()
    Object.defineProperty(vscode, 'window', {
      configurable: true,
      writable: true,
      value: { createQuickPick: () => fakeQuickPick },
    })

    const uno = createBoardIdentifier('Arduino Uno', 'arduino:avr:uno')
    const recent = new InmemoryRecentBoards()
    const pinned = new InmemoryRecentBoards()
    await recent.add(uno)

    const onDidChangeDetectedPorts = new vscode.EventEmitter<void>()
    let currentDetectedPorts: DetectedPorts = {}
    const arduino = {
      searchBoard: async () => [],
    }

    try {
      const pickPromise = pickBoard(
        arduino as unknown as Arduino,
        undefined,
        () => currentDetectedPorts,
        onDidChangeDetectedPorts.event,
        recent,
        pinned
      )

      await waitFor(() => !!findByLabel(fakeQuickPick.items, 'Arduino Uno'))
      expect(findByLabel(fakeQuickPick.items, 'Arduino Uno')?.description).toBe(
        undefined
      )

      const detectedPort = {
        protocol: 'serial',
        address: '/dev/ttyACM0',
        label: 'ttyACM0',
        protocolLabel: 'Serial Port',
      }
      currentDetectedPorts = {
        [createPortKey(detectedPort)]: {
          port: detectedPort,
          boards: [uno],
        },
      }
      onDidChangeDetectedPorts.fire()

      await waitFor(
        () =>
          findByLabel(fakeQuickPick.items, 'Arduino Uno')?.description ===
          'on /dev/ttyACM0'
      )

      fakeQuickPick.hide()
      await pickPromise
    } finally {
      recent.dispose()
      pinned.dispose()
      onDidChangeDetectedPorts.dispose()
      // @ts-ignore
      delete vscode.window
    }
  })

  it('updates recent board item back to unresolved when detection disappears', async () => {
    const { InmemoryRecentBoards, pickBoard } = await loadBoardsModule()

    const fakeQuickPick = new FakeQuickPick()
    Object.defineProperty(vscode, 'window', {
      configurable: true,
      writable: true,
      value: { createQuickPick: () => fakeQuickPick },
    })

    const uno = createBoardIdentifier('Arduino Uno', 'arduino:avr:uno')
    const recent = new InmemoryRecentBoards()
    const pinned = new InmemoryRecentBoards()
    await recent.add(uno)

    const onDidChangeDetectedPorts = new vscode.EventEmitter<void>()
    const detectedPort = {
      protocol: 'serial',
      address: '/dev/ttyACM0',
      label: 'ttyACM0',
      protocolLabel: 'Serial Port',
    }
    let currentDetectedPorts: DetectedPorts = {
      [createPortKey(detectedPort)]: {
        port: detectedPort,
        boards: [uno],
      },
    }
    const arduino = {
      searchBoard: async () => [],
    }

    try {
      const pickPromise = pickBoard(
        arduino as unknown as Arduino,
        undefined,
        () => currentDetectedPorts,
        onDidChangeDetectedPorts.event,
        recent,
        pinned
      )

      await waitFor(
        () =>
          findByLabel(fakeQuickPick.items, 'Arduino Uno')?.description ===
          'on /dev/ttyACM0'
      )

      currentDetectedPorts = {}
      onDidChangeDetectedPorts.fire()

      await waitFor(
        () =>
          findByLabel(fakeQuickPick.items, 'Arduino Uno')?.description ===
          undefined
      )

      fakeQuickPick.hide()
      await pickPromise
    } finally {
      recent.dispose()
      pinned.dispose()
      onDidChangeDetectedPorts.dispose()
      // @ts-ignore
      delete vscode.window
    }
  })
})
