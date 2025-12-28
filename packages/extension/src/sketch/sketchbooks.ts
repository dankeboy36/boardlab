import { Dirent, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  SketchbookTree,
  Folder as TreeFolder,
  Sketch as TreeSketch,
  isMainSketchFile,
  sketchbookTree,
} from 'ardunno-sketch'
import { createPortKey } from 'boards-list'
import { FQBN } from 'fqbn'
import debounce from 'lodash.debounce'
import * as vscode from 'vscode'
import { SketchFolder, SketchFoldersChangeEvent } from 'vscode-arduino-api'

import { BoardLabContextImpl } from '../boardlabContext'
import { getBoardDetails } from '../boards'
import { Arduino } from '../cli/arduino'
import { resolvePort } from '../ports'
import {
  SketchFolderImpl,
  SketchFolderImplParams,
  createSketchFolderImpl,
} from './sketchFolder'
import { SKETCHBOOK_SCHEME } from './sketchbookFs'
import {
  FileResource,
  Folder,
  Resource,
  Sketch,
  Sketchbook,
  isFolder,
  isSketch,
} from './types'

export interface HasSketchFolder {
  readonly sketch: SketchFolder
}

export function hasSketchFolder(arg: unknown): arg is HasSketchFolder {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    (<HasSketchFolder>arg).sketch instanceof SketchFolderImpl
  )
}

/**
 * A sketchbook per workspace folder. Only workspace folders with `file` URI
 * scheme are included.
 */
export class Sketchbooks implements vscode.Disposable {
  private readonly toDispose: vscode.Disposable[]
  private readonly _onDidChange: vscode.EventEmitter<Map<string, Sketchbook>>
  private readonly _onDidChangeSketchFolders: vscode.EventEmitter<SketchFoldersChangeEvent>
  private readonly _onDidChangeResolvedSketches: vscode.EventEmitter<void>
  private readonly _onDidChangeUserSketchbook: vscode.EventEmitter<void>
  private readonly _onDidRefresh: vscode.EventEmitter<void>
  /**
   * Keys are the `SketchbookTree#cwd` paths converted to `file:///` URI
   * strings.
   */
  private _sketchbooks: Map<string, Sketchbook> | undefined
  private _resolvedSketches: SketchFolderImpl[]
  private _currentUserDirPath: string | undefined
  private readonly refreshDebounced: () => void
  private refreshPromise: Promise<void> | undefined
  private refreshResolve: (() => void) | undefined
  private _isLoading = false
  private _isEmpty = true

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly boardlabContext: BoardLabContextImpl
  ) {
    this._resolvedSketches = []
    this._currentUserDirPath =
      boardlabContext.cliContext.cliConfig.data?.userDirPath
    this._onDidChange = new vscode.EventEmitter()
    this._onDidChangeSketchFolders = new vscode.EventEmitter()
    this._onDidChangeResolvedSketches = new vscode.EventEmitter()
    this._onDidChangeUserSketchbook = new vscode.EventEmitter()
    this._onDidRefresh = new vscode.EventEmitter()
    this.refreshDebounced = debounce(() => {
      this.refreshInternal().catch((error) =>
        console.warn('Failed to refresh sketchbooks', error)
      )
    }, 200)
    const inoWatcher = vscode.workspace.createFileSystemWatcher(
      '**/*.ino',
      false,
      true,
      false
    )
    this.toDispose = [
      this._onDidChange,
      this._onDidChangeSketchFolders,
      this._onDidChangeResolvedSketches,
      inoWatcher,
      inoWatcher.onDidCreate((event) => {
        if (this.isMainSketchFile(event)) {
          this.refresh()
        }
      }),
      inoWatcher.onDidDelete((event) => {
        if (this.isMainSketchFile(event)) {
          this.refresh()
        }
      }),
      boardlabContext.cliContext.cliConfig.onDidChangeData((newCliConfig) => {
        if (this._currentUserDirPath !== newCliConfig?.userDirPath) {
          this._currentUserDirPath = newCliConfig?.userDirPath
          this._sketchbooks = undefined
          this._onDidChangeUserSketchbook.fire()

          this.refresh()
        }
      }),
      this._onDidChangeUserSketchbook,
      this._onDidRefresh,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    ]
    this.refresh()
  }

  private async resolveOpenedSketchFolders(
    openedSketches?: readonly Sketch[]
  ): Promise<void> {
    const sketches = openedSketches ?? this.openedSketches
    const { arduino } = await this.boardlabContext.client
    const resolvedSketches = await Promise.all(
      sketches.map((sketch) => this.resolve(sketch, arduino))
    )
    const validSketches = resolvedSketches.filter((sketch) =>
      Boolean(sketch)
    ) as SketchFolderImpl[]
    this._resolvedSketches = validSketches
    this._onDidChangeResolvedSketches.fire()
  }

  private isMainSketchFile(uri: vscode.Uri): boolean {
    if (uri.scheme === 'file') {
      const path = uri.fsPath
      return isMainSketchFile(path)
    }
    return false
  }

  refresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = new Promise((resolve) => {
        this.refreshResolve = resolve
      })
    }
    this.setSketchbooksLoading(true)
    this.refreshDebounced()
    return this.refreshPromise
  }

  private async refreshInternal(): Promise<void> {
    try {
      const previousSketchbooks = this._sketchbooks ?? new Map()
      const oldOpenedSketches = this.getOpenedSketchesFrom(previousSketchbooks)
      const newSketchbooks = await this.loadSketchbooks()
      this._sketchbooks = newSketchbooks
      this._onDidChange.fire(this._sketchbooks)
      const newOpenedSketches = this.getOpenedSketchesFrom(newSketchbooks)
      this.setSketchbooksEmpty(newOpenedSketches.length === 0)
      const addedPaths = newOpenedSketches
        .filter((sketch) =>
          oldOpenedSketches.every(
            (otherSketch) =>
              otherSketch.uri.toString() !== sketch.uri.toString()
          )
        )
        .map((sketch) => sketch.uri.fsPath)
      const removedPaths = oldOpenedSketches
        .filter((sketch) =>
          newOpenedSketches.every(
            (otherSketch) =>
              otherSketch.uri.toString() !== sketch.uri.toString()
          )
        )
        .map((sketch) => sketch.uri.fsPath)
      this._onDidChangeSketchFolders.fire({ addedPaths, removedPaths })
      await this.resolveOpenedSketchFolders(newOpenedSketches)
      this._onDidRefresh.fire()
    } finally {
      this.setSketchbooksLoading(false)
      if (this.refreshResolve) {
        this.refreshResolve()
        this.refreshResolve = undefined
        this.refreshPromise = undefined
      }
    }
  }

  get isLoading(): boolean {
    return this._isLoading
  }

  private setSketchbooksLoading(loading: boolean): void {
    if (this._isLoading === loading) {
      return
    }
    this._isLoading = loading
    vscode.commands.executeCommand(
      'setContext',
      'boardlab.sketchbooks.loading',
      loading
    )
  }

  private setSketchbooksEmpty(empty: boolean): void {
    if (this._isEmpty === empty) {
      return
    }
    this._isEmpty = empty
    vscode.commands.executeCommand(
      'setContext',
      'boardlab.sketchbooks.empty',
      empty
    )
  }

  get isEmpty(): boolean {
    return this._isEmpty
  }

  private getOpenedSketchesFrom(
    sketchbooks: Map<string, Sketchbook>
  ): readonly Sketch[] {
    return Array.from(sketchbooks.values()).flatMap(
      (sketchbook) => sketchbook.sketches
    )
  }

  private async loadSketchbooks(): Promise<Map<string, Sketchbook>> {
    const rootPaths = new Set(
      (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === 'file')
        .map(({ uri }) => uri.fsPath)
    )
    if (this._currentUserDirPath) {
      rootPaths.add(this._currentUserDirPath)
    }

    const entries = await Promise.all(
      Array.from(rootPaths).map(async (path) => {
        const uri = vscode.Uri.file(path).toString()
        try {
          const tree = await sketchbookTree(path)
          const sketchbook = createSketchbook(tree)
          return [uri, sketchbook] as const
        } catch (error) {
          console.warn(`Could not load sketchbook at ${path}: ${error}`)
          return undefined
        }
      })
    )

    const map = new Map<string, Sketchbook>()
    for (const entry of entries) {
      if (entry) {
        map.set(entry[0], entry[1])
      }
    }
    return map
  }

  get userSketchbook(): Sketchbook | undefined {
    let userSketchbookUri: vscode.Uri | undefined
    if (this._currentUserDirPath) {
      userSketchbookUri = vscode.Uri.file(this._currentUserDirPath)
    }

    return userSketchbookUri
      ? this.all().get(userSketchbookUri.toString())
      : undefined
  }

  get onDidChangeUserSketchbook(): vscode.Event<void> {
    return this._onDidChangeUserSketchbook.event
  }

  get onDidRefresh(): vscode.Event<void> {
    return this._onDidRefresh.event
  }

  get openedSketches(): readonly Sketch[] {
    return this.getOpenedSketchesFrom(this.all())
  }

  get resolvedSketchFolders(): readonly SketchFolderImpl[] {
    return this._resolvedSketches
  }

  async loadChildren(resource: Resource): Promise<Resource[]> {
    const children = loadChildrenForResource(resource)
    resource.children = children
    return children
  }

  all(): Map<string, Sketchbook> {
    if (!this._sketchbooks) {
      this._sketchbooks = new Map()
      this.refresh()
    }
    return this._sketchbooks
  }

  /** The `uri` can be the URI to the sketch folder or to any contained resource. */
  find(uri: string): Sketch | undefined {
    for (const sketchbook of this.all().values()) {
      const sketch = sketchbook.sketches.find(({ uri: sketchUri }) =>
        uri.startsWith(sketchUri.toString())
      )
      if (sketch) {
        return sketch
      }
    }
    return undefined
  }

  findSketchbook(sketch: Sketch): Sketchbook | undefined {
    return Array.from(this.all().values())
      .sort(
        (left, right) =>
          left.uri.toString().length - right.uri.toString().length
      )
      .reverse() // longest first
      .find((sketchbook) =>
        sketch.uri.toString().startsWith(sketchbook.uri.toString())
      )
  }

  /** @deprecated Use `onDidChangeSketchFolders`. */
  get onDidChange(): vscode.Event<Map<string, Sketchbook>> {
    return this._onDidChange.event
  }

  get onDidChangeSketchFolders(): vscode.Event<SketchFoldersChangeEvent> {
    return this._onDidChangeSketchFolders.event
  }

  get onDidChangeResolvedSketches(): vscode.Event<void> {
    return this._onDidChangeResolvedSketches.event
  }

  async resolve(
    pathLike: SketchPathLike,
    arduino: Arduino,
    memento: vscode.Memento = this.context.globalState
  ): Promise<SketchFolderImpl | undefined> {
    let sketch: Sketch | undefined
    if (typeof pathLike === 'string') {
      sketch = this.find(vscode.Uri.file(pathLike).toString())
    } else if (pathLike instanceof vscode.Uri) {
      sketch = this.find(pathLike.toString())
    } else if (isSketch(pathLike)) {
      sketch = pathLike
    } else {
      this.assertIsOpened(pathLike)
      return Promise.resolve(pathLike)
    }
    if (!sketch) {
      console.warn(`Could not resolve sketch: ${JSON.stringify(pathLike)}`)
      return undefined
    }
    this.assertIsOpened(sketch)
    const params: SketchFolderImplParams = {
      state: { sketchPath: sketch.uri.fsPath },
      loaders: [
        async (prevState: SketchFolderState, sketchFolder) => {
          const fqbn = prevState.board?.fqbn
          const boardDetails = fqbn
            ? await getBoardDetails(fqbn, arduino)
            : undefined
          const defaultBoardDetails =
            boardDetails &&
            new FQBN(boardDetails.fqbn)
              .withConfigOptions(...boardDetails.configOptions)
              .toString()
          sketchFolder.defaultConfigOptions = defaultBoardDetails
          const selectedProgrammer =
            prevState.selectedProgrammer ??
            boardDetails?.programmers.find(
              (p) => p.id === boardDetails?.defaultProgrammerId
            )
          // TODO: fix typing in boars-list
          const port: any = prevState.port
            ? (resolvePort(
                createPortKey(prevState.port),
                arduino,
                this.boardlabContext.boardsListWatcher.detectedPorts
              ) ?? prevState.port)
            : undefined
          return {
            ...prevState,
            board: boardDetails ?? prevState.board,
            port: port ?? prevState.port,
            selectedProgrammer,
            // Config options now store only non-default overrides.
            // Defaults are captured in `defaultConfigOptions`, so we keep
            // whatever overrides we already had without recomputing them here.
            configOptions: prevState.configOptions,
          }
        },
      ],
      get: (key) => memento.get(key),
      update: (key, value) => memento.update(key, value),
    }
    const sketchFolder = await createSketchFolderImpl(params)
    return sketchFolder
  }

  private assertIsOpened(sketch: Sketch | SketchFolder): void {
    const openedMatch = this.openedSketches.find((openedSketch) =>
      sketchPathEquals(sketch, openedSketch)
    )
    if (!openedMatch) {
      throw new Error(
        `Sketch is not opened: ${sketchFolderUri(sketch)}, ${JSON.stringify(this.openedSketches)}`
      )
    }
  }

  private assertIsResolved(sketch: Sketch | SketchFolder): SketchFolder {
    this.assertIsOpened(sketch)
    const resolvedMatch = this.resolvedSketchFolders.find((resolvedSketch) =>
      sketchPathEquals(sketch, resolvedSketch)
    )
    if (!resolvedMatch) {
      throw new Error(
        `Sketch is not resolved: ${sketchFolderUri(sketch)}, ${JSON.stringify(this.resolvedSketchFolders)}`
      )
    }
    return resolvedMatch
  }

  dispose() {
    return vscode.Disposable.from(...this.toDispose).dispose()
  }
}

export function sketchPathEquals(
  left: Sketch | SketchFolder,
  right: Sketch | SketchFolder
): boolean {
  const leftUri = sketchFolderUri(left)
  const rightUri = sketchFolderUri(right)
  return leftUri === rightUri
}

function sketchFolderUri(sketch: Sketch | SketchFolder): string {
  return isSketch(sketch)
    ? sketch.uri.toString()
    : vscode.Uri.file(sketch.sketchPath).toString()
}

/** The sketch folder or the path/URI to the sketch folder. */
export type SketchPathLike = SketchFolderImpl | Sketch | string | vscode.Uri

export type SketchFolderState = Partial<
  Pick<SketchFolder, 'board' | 'port' | 'configOptions' | 'selectedProgrammer'>
> &
  Readonly<Required<Pick<SketchFolder, 'sketchPath'>>>

// async function restoreFromSketchProfile(
//   sketch: Sketch
// ): Promise<SketchFolderState | undefined> {
//   // TODO: Load configOptions, maybe the programmer from sketch.yaml
//   return undefined
// }

function createSketchbook(tree: SketchbookTree): Sketchbook {
  const uri = vscode.Uri.file(tree.cwd)
  if (typeof tree.root === 'string') {
    const sketch = {
      uri,
      mainSketchFileUri: toReadonlyUri(join(tree.cwd, tree.root)),
      label: tree.root,
      type: 'sketch',
      children: undefined,
    } as Sketch
    return {
      uri: sketch.uri,
      children: [sketch],
      sketches: [sketch],
      label: sketch.label,
      type: 'folder',
    }
  }
  const sketches: Sketch[] = []
  const children = resolveChildren(
    tree.cwd,
    Object.entries(tree.root),
    sketches
  )
  return { uri, children, sketches, label: basename(tree.cwd), type: 'folder' }
}

function resolveChildren(
  path: string,
  entries: [label: string, value: TreeFolder | TreeSketch][],
  visited: Sketch[] = []
): Resource[] {
  return entries.map(([label, value]) => {
    const uri = vscode.Uri.file(join(path, label))
    if (typeof value === 'string') {
      const sketchDir = join(path, label)
      const sketch = {
        uri,
        mainSketchFileUri: toReadonlyUri(join(sketchDir, value)),
        label,
        type: 'sketch',
        children: undefined,
      } as Sketch
      visited.push(sketch)
      return sketch
    }
    const children = resolveChildren(
      join(path, label),
      Object.entries(value),
      visited
    )
    return { uri, children, label, type: 'folder' } as Folder
  })
}

function readSketchChildren(
  dirPath: string,
  mainFileName?: string
): Resource[] {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    const resources = entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => toResourceFromDirent(dirPath, entry, mainFileName))
    resources.sort((left, right) => {
      const diff = resourceSortWeight(left) - resourceSortWeight(right)
      if (diff !== 0) {
        return diff
      }
      return left.label.localeCompare(right.label)
    })
    return resources
  } catch (error) {
    console.warn(`Failed to read sketch contents from ${dirPath}:`, error)
    return []
  }
}

function toResourceFromDirent(
  basePath: string,
  entry: Dirent,
  mainFileName?: string
): Resource {
  const absolute = join(basePath, entry.name)
  if (entry.isDirectory()) {
    return {
      uri: vscode.Uri.file(absolute),
      label: entry.name,
      type: 'folder',
      children: undefined,
    } as Folder
  }
  return {
    uri: toReadonlyUri(absolute),
    label: entry.name,
    type: 'file',
    isMainSketch: mainFileName === entry.name,
  } as FileResource
}

function toReadonlyUri(pathValue: string): vscode.Uri {
  return vscode.Uri.file(pathValue).with({ scheme: SKETCHBOOK_SCHEME })
}

function resourceSortWeight(resource: Resource): number {
  if (resource.type === 'folder') return 0
  if (resource.type === 'sketch') return 1
  return 2
}

function loadChildrenForResource(resource: Resource): Resource[] {
  if (isSketch(resource)) {
    const folderPath = resource.uri.fsPath
    const mainName = `${basename(folderPath)}.ino`
    return readSketchChildren(folderPath, mainName)
  }
  if (isFolder(resource)) {
    return readSketchChildren(resource.uri.fsPath)
  }
  return []
}
