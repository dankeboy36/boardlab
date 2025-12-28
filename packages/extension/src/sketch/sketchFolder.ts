import { Mutable, createPortKey } from 'boards-list'
import { ConfigOption, FQBN } from 'fqbn'
import type { DeferredPromise } from 'p-defer'
import defer from 'p-defer'
import vscode from 'vscode'
import {
  BoardDetails,
  BoardIdentifier,
  CompileSummary,
  Port,
  Programmer,
  SketchFolder,
} from 'vscode-arduino-api'

import { isBoardDetails } from '../boards'
import { deepClone, mementoKey } from '../utils'
import {
  stateFromSketchProfile,
  toSketchProfile,
  type SketchProfile,
} from './sketchProfile'

type MutableBoardScopedState = Mutable<
  Partial<Pick<SketchFolder, 'configOptions' | 'selectedProgrammer'>>
>
type MutableSketchScopedState = Mutable<
  Partial<Pick<SketchFolder, 'board' | 'port'>>
>

type MutableSketchFolderState = MutableSketchScopedState &
  MutableBoardScopedState

export type SketchFolderState = MutableSketchFolderState &
  Readonly<Required<Pick<SketchFolder, 'sketchPath'>>>

export interface SketchFolderImplParams {
  readonly state: SketchFolderState
  readonly boardSelectionHistory?: BoardSelectionHistory
  readonly configOptionsHistory?: ConfigOptionsHistory
  readonly loaders?: Array<
    (
      prevState: SketchFolderState,
      sketchFolder: SketchFolderImpl
    ) => Promise<SketchFolderState>
  >
  readonly get: vscode.Memento['get']
  readonly update?: vscode.Memento['update']
}

/**
 * Create a sketch folder model and eagerly initialize it.
 *
 * Persistence strategy:
 *
 * - On save, we persist a minimal SketchProfile per sketch folder into extension
 *   globalState under the `sketchProfile` key.
 * - On restore, we ignore legacy memento shapes and reconstruct the state solely
 *   from this SketchProfile snapshot; CLI enrichment then refines it.
 */
export async function createSketchFolderImpl(
  params: SketchFolderImplParams
): Promise<SketchFolderImpl> {
  const mementoLoader = async (prevState: SketchFolderState) => {
    const { sketchPath } = prevState
    const profile = params.get<SketchProfile>(
      sketchProfileMementoKey(sketchPath)
    )
    if (!profile) {
      return prevState
    }
    return stateFromSketchProfile(sketchPath, profile)
  }
  const loaders = [mementoLoader, ...(params.loaders ?? [])]
  const sketchFolder = new SketchFolderImpl({ ...params, loaders })
  await sketchFolder.init()
  return sketchFolder
}

export class SketchFolderImpl implements vscode.Disposable, SketchFolder {
  private readonly toDispose: vscode.Disposable[]
  private readonly boardSelectionHistory: BoardSelectionHistory
  private readonly configOptionsHistory: ConfigOptionsHistory
  private readonly _onDidRefresh: vscode.EventEmitter<SketchFolderState>

  private _init: DeferredPromise<SketchFolderState> | undefined
  private _state: SketchFolderState

  /** Transient mutable state. It never gets persisted. */
  compileSummary: CompileSummary | undefined

  /**
   * The string representation of the default config option provided by the CLI.
   * This is to be able to reset the config option to the default without
   * fetching the data again from the CLI.
   */
  defaultConfigOptions: string | undefined

  constructor(private readonly params: SketchFolderImplParams) {
    this._state = params.state
    this.boardSelectionHistory = deepClone(params.boardSelectionHistory ?? {})
    this.configOptionsHistory = deepClone(params.configOptionsHistory ?? {})
    this._onDidRefresh = new vscode.EventEmitter()
    this.toDispose = [this._onDidRefresh]
  }

  dispose(): void {
    vscode.Disposable.from(...this.toDispose).dispose()
  }

  get board(): BoardDetails | BoardIdentifier | undefined {
    return this.state.board
  }

  get port():
    | Readonly<Port>
    | Readonly<Pick<Port, 'protocol' | 'address'>>
    | undefined {
    return this.state.port
  }

  get configOptions(): string | undefined {
    return this.state.configOptions
  }

  get selectedProgrammer(): string | Readonly<Programmer> | undefined {
    return this.state.selectedProgrammer
  }

  get sketchPath(): string {
    return this.state.sketchPath
  }

  get state(): SketchFolderState {
    return this._state
  }

  init(): Promise<SketchFolderState> {
    if (!this._init) {
      const deferredInit = defer<SketchFolderState>()
      ;(this.params.loaders ?? [])
        .reduce(async (prev, next) => {
          const prevState = await prev
          return next(prevState, this)
        }, Promise.resolve(this.state))
        .then((state) => {
          this._state = state
          this._onDidRefresh.fire(this.state)
          deferredInit.resolve(this.state)
        }, deferredInit.reject)
        .finally(() => (this._init = undefined))
      this._init = deferredInit
    }
    return this._init!.promise
  }

  setBoard(board: SketchFolderState['board']): void {
    this.state.board = board
    const fqbn = this.state.board?.fqbn
    if (isBoardDetails(this.state.board)) {
      const boardDetails = this.state.board
      const defaults = new FQBN(boardDetails.fqbn)
        .withConfigOptions(...boardDetails.configOptions)
        .toString()
      this.defaultConfigOptions = defaults
    } else {
      this.defaultConfigOptions = undefined
    }
    if (fqbn) {
      const sanitized = new FQBN(fqbn).toString(true)
      if (this.state.port) {
        const portKey = createPortKey(this.state.port)
        this.boardSelectionHistory[portKey] = sanitized
      }
      const remembered = this.configOptionsHistory[sanitized]
      if (remembered) {
        this.state.configOptions = remembered
      } else {
        this.state.configOptions = undefined
      }
    } else {
      this.state.configOptions = undefined
    }
    this.state.selectedProgrammer = undefined
    this.saveSketchScopedState()
  }

  setPort(port: SketchFolderState['port']): void {
    this.state.port = port
    this.saveSketchScopedState()
  }

  setConfigOptions(configOptions: SketchFolderState['configOptions']): void {
    if (!isBoardDetails(this.state.board)) {
      return
    }
    const fqbn = new FQBN(this.state.board.fqbn)
    if (
      configOptions &&
      !fqbn.sanitize().equals(new FQBN(configOptions).sanitize())
    ) {
      throw new Error(
        `Expected FQBN from ${new FQBN(this.state.board.fqbn).toString()}, got ${new FQBN(
          configOptions
        ).toString()} instead.`
      )
    }
    this.state.configOptions = configOptions
    if (this.state.configOptions) {
      const sanitized = fqbn.toString(true)
      this.configOptionsHistory[sanitized] = this.state.configOptions
    }
    this.saveBoardScopedState()
  }

  setConfigOption(...configOptions: ConfigOption[]): void {
    if (!isBoardDetails(this.state.board)) {
      return
    }
    for (const configOption of configOptions) {
      if (
        !this.state.board.configOptions.find(
          ({ option }) => option === configOption.option
        )
      ) {
        throw new Error(
          `Unexpected config option: ${JSON.stringify(configOption)}. Allowed: ${JSON.stringify(
            this.state.board.configOptions
          )}`
        )
      }
    }
    const updatedConfigOptions = new FQBN(this.state.board.fqbn)
      .withConfigOptions(...configOptions)
      .toString()
    this.setConfigOptions(updatedConfigOptions)
  }

  setSelectedProgrammer(
    selectedProgrammer: SketchFolderState['selectedProgrammer']
  ): void {
    this.state.selectedProgrammer = selectedProgrammer
    this.saveBoardScopedState()
  }

  private async saveSketchScopedState(): Promise<void> {
    const update = this.params.update
    if (update) {
      const snapshot = this.createSnapshot()
      const { sketchPath, port, board } = snapshot
      await update(sketchScopedMementoKeys(sketchPath), { board, port })
      await update(
        sketchProfileMementoKey(sketchPath),
        toSketchProfile(snapshot)
      )
    }
  }

  private async saveBoardScopedState(): Promise<void> {
    const update = this.params.update
    if (update) {
      const snapshot = this.createSnapshot()
      const { sketchPath } = snapshot
      await update(
        sketchProfileMementoKey(sketchPath),
        toSketchProfile(snapshot)
      )
    }
  }

  private createSnapshot(): SketchFolderState {
    return {
      sketchPath: this.sketchPath,
      board: this.board
        ? { name: this.board.name, fqbn: this.board.fqbn }
        : undefined,
      port: this.port
        ? { protocol: this.port.protocol, address: this.port.address }
        : undefined,
      configOptions: this.configOptions,
      selectedProgrammer: this.selectedProgrammer
        ? typeof this.selectedProgrammer === 'string'
          ? this.selectedProgrammer
          : this.selectedProgrammer.id
        : undefined,
    }
  }
}

function sketchScopedMementoKeys(sketchPath: string): string {
  const scope = vscode.Uri.file(sketchPath).toString()
  return mementoKey('sketchFolder', scope)
}

function sketchProfileMementoKey(sketchPath: string): string {
  const scope = vscode.Uri.file(sketchPath).toString()
  return mementoKey('sketchProfile', scope)
}

export type PortKey = ReturnType<typeof createPortKey>
export type SanitizedFQBN = ReturnType<FQBN['toString']>
export type BoardSelectionHistory = Record<PortKey, SanitizedFQBN>

export type ConfigOptionsHistory = Record<SanitizedFQBN, string>
