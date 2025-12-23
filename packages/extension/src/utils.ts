import { Status } from 'ardunno-cli/api'
import { ClientError, ServerError } from 'nice-grpc-common'
import * as vscode from 'vscode'

// TODO: move it elsewhere
export function mementoKey(property: string, scope?: string): string {
  return `ardunno.memento.${scope ? `${scope.toString()}.` : ''}${property}`
}

export function deepClone<T extends object>(object: T): T {
  return JSON.parse(JSON.stringify(object))
}

export function disposeAll(...toDispose: vscode.Disposable[]): void {
  let current = toDispose.pop()
  while (current) {
    try {
      current.dispose()
    } catch (err) {
      console.error(err)
    } finally {
      current = toDispose.pop()
    }
  }
}

export function isServiceError(err: unknown): err is ClientError | ServerError {
  return err instanceof ClientError || err instanceof ServerError
}
export function isStatus(err: unknown): err is Status {
  return (
    (<Status>err).code !== undefined &&
    typeof (<Status>err).code === 'number' &&
    (<Status>err).message !== undefined &&
    typeof (<Status>err).message === 'string' &&
    (<Status>err).details !== undefined &&
    Array.isArray((<Status>err).details)
  )
}

export interface RecentItems<T> extends vscode.Disposable {
  readonly items: T[]
  /** `true` if the items were added or moved. Otherwise, `false`. */
  add(item: T): Promise<boolean>
  /** `true` if the item existed among the items before the removal. */
  remove(item: T): Promise<boolean>

  /** Emits an event when the items have been updated. */
  onDidUpdate: vscode.Event<void>
}

export abstract class BaseRecentItems<T> implements RecentItems<T> {
  private readonly onDidUpdateEmitter = new vscode.EventEmitter<void>()
  private readonly toDispose: vscode.Disposable[] = [this.onDidUpdateEmitter]
  protected readonly _items: T[] = []

  constructor(
    private readonly equivalence: (left: T, right: T) => boolean = (
      left,
      right
    ): boolean => left === right,
    private readonly maxHistory = 10,
    ...items: T[]
  ) {
    this._items.push(...items)
  }

  protected abstract save(items: T[]): Promise<void>

  get items(): T[] {
    return this._items.slice()
  }

  async add(item: T): Promise<boolean> {
    const index = this._items.findIndex((candidate) =>
      this.equivalence(candidate, item)
    )
    const exist = index >= 0
    if (exist && index === 0) {
      // NOOP
      return false
    }
    if (!exist) {
      this._items.unshift(item)
      if (this._items.length > this.maxHistory) {
        this._items.slice(0, this.maxHistory)
      }
    } else {
      this._items.splice(index, 1)
      this._items.unshift(item)
    }

    await this.save(this.items)
    this.fireDidUpdate()
    return true
  }

  async remove(item: T): Promise<boolean> {
    const index = this._items.findIndex((candidate) =>
      this.equivalence(candidate, item)
    )
    if (index < 0) {
      return false
    }
    this._items.splice(index, 1)

    await this.save(this.items)
    this.fireDidUpdate()
    return true
  }

  get onDidUpdate(): vscode.Event<void> {
    return this.onDidUpdateEmitter.event
  }

  dispose(): void {
    disposeAll(...this.toDispose)
  }

  private fireDidUpdate(): void {
    this.onDidUpdateEmitter.fire()
  }
}

export class InmemoryRecentItems<T> extends BaseRecentItems<T> {
  protected override async save(): Promise<void> {
    // NOOP
  }
}

const neverEmitter = new vscode.EventEmitter<unknown>()
export function noopRecentItems<T>(): RecentItems<T> {
  return {
    items: [],
    add: (): Promise<boolean> => Promise.resolve(false),
    remove: (): Promise<boolean> => Promise.resolve(false),
    onDidUpdate: never(),
    dispose: (): void => {
      /* NOOP */
    },
  }
}

export function never<T = void>(): vscode.Event<T> {
  return neverEmitter.event as vscode.Event<T>
}

export class QuickInputNoopLabel {
  alwaysShow?: boolean

  constructor(
    public label: string,
    alwaysShow = true
  ) {
    this.alwaysShow = alwaysShow
  }
}

export function inputButton(
  id: string,
  tooltip?: string | undefined
): vscode.QuickInputButton {
  return {
    iconPath: new vscode.ThemeIcon(id),
    tooltip,
  }
}

class BackButtonQuickPickItem implements vscode.QuickPickItem {
  constructor(readonly label = 'Go back ↩') {}
}
export const backButton = new BackButtonQuickPickItem()
