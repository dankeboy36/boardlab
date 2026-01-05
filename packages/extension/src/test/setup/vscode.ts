import { EventEmitter } from '@c4312/evt'
import { vi } from 'vitest'

class Disposable {
  constructor(private readonly disposeFn?: () => void) {}

  dispose(): void {
    this.disposeFn?.()
  }

  static from(...disposables: { dispose(): void }[]): Disposable {
    return new Disposable(() => {
      for (const disposable of disposables) {
        try {
          disposable.dispose()
        } catch (err) {
          console.error('error when disposing', err)
        }
      }
    })
  }
}

class ThemeIcon {
  constructor(readonly id: string) {}
}

vi.mock('vscode', () => {
  return {
    Disposable,
    EventEmitter,
    ThemeIcon,
    QuickPickItemKind: { Separator: -1 },
  }
})
