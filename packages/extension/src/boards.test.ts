import type { BoardListItem } from 'ardunno-cli/api'
import type { BoardIdentifier, BoardsList } from 'boards-list'
import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => {
  class EventEmitter<T = unknown> {
    private listeners: ((value: T) => void)[] = []
    event = (listener: (value: T) => void) => {
      this.listeners.push(listener)
    }

    fire(value: T): void {
      for (const listener of this.listeners) listener(value)
    }

    dispose(): void {
      this.listeners = []
    }
  }
  return {
    EventEmitter,
    ThemeIcon: class {},
    QuickPickItemKind: { Separator: -1 },
  }
})

const loadBoardsModule = async () => import('./boards')

function createBoardIdentifier(name: string, fqbn: string): BoardIdentifier {
  return {
    name,
    fqbn,
  } as any
}

function createBoardListItem(board: BoardIdentifier): BoardListItem {
  return {
    name: board.name,
    fqbn: board.fqbn ?? '',
    isHidden: false,
  } as any
}

function createBoardsList(boards: BoardIdentifier[]): BoardsList {
  return {
    boards: boards.map((board) => ({
      port: {} as any,
      board,
    })) as any,
    portsGroupedByProtocol() {
      return {}
    },
  } as any
}

function labelsOf(items: readonly any[]): string[] {
  return items
    .filter((item) => item && typeof item.label === 'string')
    .map((item) => item.label as string)
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

    const items = toBoardQuickPickItems(
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

    const items = toBoardQuickPickItems(
      boardsList,
      searchResults.slice(),
      pinned,
      recent
    )

    const labels = labelsOf(items)
    const unoCount = labels.filter((label) => label === 'Arduino Uno').length
    expect(unoCount).toBe(1)
  })
})
