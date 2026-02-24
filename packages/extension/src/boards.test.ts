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
    expect(labels).toContain('No matching results')
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

describe('pickBoard (live detected ports refresh)', () => {
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
