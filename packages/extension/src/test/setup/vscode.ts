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

class Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}
}

class Range {
  readonly start: Position
  readonly end: Position

  constructor(
    startLine: number | Position,
    startCharacterOrEnd: number | Position,
    endLine?: number,
    endCharacter?: number
  ) {
    if (
      startLine instanceof Position &&
      startCharacterOrEnd instanceof Position
    ) {
      this.start = startLine
      this.end = startCharacterOrEnd
    } else {
      this.start = new Position(
        startLine as number,
        startCharacterOrEnd as number
      )
      this.end = new Position(endLine as number, endCharacter as number)
    }
  }
}

const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
} as const

class Diagnostic {
  code: string | number | { value: string | number; target: any } | undefined
  source: string | undefined

  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: number
  ) {}
}

class WorkspaceEdit {
  readonly entries: Array<{ uri: Uri; range: Range; newText: string }> = []

  replace(uri: Uri, range: Range, newText: string): void {
    this.entries.push({ uri, range, newText })
  }
}

class CodeAction {
  diagnostics: Diagnostic[] | undefined
  edit: WorkspaceEdit | undefined
  command:
    | { command: string; title: string; arguments?: unknown[] | undefined }
    | undefined

  isPreferred: boolean | undefined

  constructor(
    readonly title: string,
    readonly kind: string
  ) {}
}

const CodeActionKind = {
  QuickFix: 'quickfix',
} as const

class Uri {
  constructor(readonly fsPath: string) {}

  static file(fsPath: string): Uri {
    return new Uri(fsPath)
  }

  toString(): string {
    return `file://${this.fsPath}`
  }
}

vi.mock('vscode', () => {
  return {
    CodeAction,
    CodeActionKind,
    Disposable,
    Diagnostic,
    DiagnosticSeverity,
    EventEmitter,
    Position,
    Range,
    WorkspaceEdit,
    ThemeIcon,
    Uri,
    QuickPickItemKind: { Separator: -1 },
  }
})
