import * as path from 'node:path'

import {
  IndexUpdateReport,
  // eslint-disable-next-line camelcase
  IndexUpdateReport_Status,
  MonitorPortSettingDescriptor,
  type BuilderResult,
} from 'ardunno-cli/api'
import {
  BoardIdentifier,
  BoardsConfig,
  BoardsListItemWithBoard,
  Defined,
  PortIdentifier,
  boardIdentifierEquals,
  isBoardIdentifier,
  isBoardsListItem,
  isPortIdentifier,
} from 'boards-list'
import { FQBN } from 'fqbn'
import defer from 'p-defer'
import * as vscode from 'vscode'
import {
  BoardDetails as ApiBoardDetails,
  ArduinoContext,
  ArduinoState,
  ChangeEvent,
  CliConfig,
  CompileSummary,
  ConfigValue,
  Port,
  Programmer,
  SketchFolder,
  SketchFoldersChangeEvent,
} from 'vscode-arduino-api'
import type { Messenger } from 'vscode-messenger'

import {
  UninstallEventParams,
  getSelectedBoard,
  notifyDidChangeSelectedBoard,
  type InstallEventParams,
} from '@boardlab/protocol'

import { findBoardHistoryMatches, matchBoardByName } from './boardNameMatch'
import {
  PlatformNotInstalledError,
  ensureBoardDetails,
  getBoardDetails,
  getSelectedConfigValue,
  isBoardDetails,
  pickBoard,
} from './boards'
import { BoardsListWatcher } from './central/boardsListWatcher'
import {
  InMemoryMonitorsRegistry,
  MonitorsRegistry,
} from './central/monitorsRegistry'
import { PortQName } from './cli/arduino'
import { Client } from './cli/client'
import { TrackedCliConfig } from './cli/config'
import { CliContext } from './cli/context'
import { DaemonAddress } from './cli/daemon'
import { toCompileSummary } from './compile'
import { computeConfigOverrides } from './configOptions'
import { MonitorManager } from './monitor/monitorManager'
import { getPlatformRequirement, PlatformInfo } from './platformMissing'
import {
  collectHistoryUpdates,
  matchesPlatformId,
  toUnresolvedBoard,
} from './platformUtils'
import { pickPort } from './ports'
import { readProfiles } from './profile/profiles'
import { LibrariesManager, PlatformsManager } from './resourcesManager'
import { ConfigOptionItem } from './sketch/currentSketchView'
import { SketchFolderImpl } from './sketch/sketchFolder'
import { restoreCurrentSketch } from './sketch/sketchRestore'
import {
  SketchPathLike,
  Sketchbooks,
  hasSketchFolder,
  sketchPathEquals,
} from './sketch/sketchbooks'
import { pickSketch } from './sketch/sketches'
import { Sketch } from './sketch/types'
import { BaseRecentItems, RecentItems, disposeAll, mementoKey } from './utils'

class MementoRecentItems<T> extends BaseRecentItems<T> {
  constructor(
    private readonly mementoKey: string,
    private readonly memento: vscode.Memento,
    equivalence?: (left: T, right: T) => boolean,
    maxHistory?: number
  ) {
    super(
      equivalence ??
        ((left: T, right: T) => {
          return left === right
        }),
      maxHistory
    )
    this._items.push(...memento.get<T[]>(mementoKey, []))
  }

  protected async save(items: T[]): Promise<void> {
    return this.memento.update(this.mementoKey, items)
  }
}

const LAST_CURRENT_SKETCH_WORKSPACE_KEY = mementoKey('lastCurrentSketchPath')

const arduinoCliConfigMapping: Record<
  keyof Omit<TrackedCliConfig, 'validationIssues'>,
  string
> = {
  userDirPath: 'directories.user',
  dataDirPath: 'directories.data',
  additionalUrls: 'board_manager.additional_urls',
  networkProxy: 'network.proxy',
  locale: 'locale',
}

export interface BoardLabContext extends ArduinoContext {
  readonly cliContext: CliContext
  readonly sketchbooks: Sketchbooks
  /**
   * Resolves once the initial sketchbook refresh completes and the first
   * current-sketch restore attempt has finished.
   */
  readonly whenCurrentSketchReady: Promise<void>
  readonly client: Promise<Client>
  readonly platformsManager: PlatformsManager
  readonly librariesManager: LibrariesManager
  readonly monitorManager: MonitorManager
  readonly boardsListWatcher: BoardsListWatcher
  readonly monitorsRegistry: MonitorsRegistry
  readonly extensionUri: vscode.Uri
  readonly outputChannel: vscode.OutputChannel
}

type SketchPort = SketchFolder['port']
type SelectedPort = NonNullable<SketchPort>

export function createBoardLabContext(
  context: vscode.ExtensionContext,
  messenger: Messenger,
  start = true,
  outputChannel?: vscode.OutputChannel
): BoardLabContextImpl {
  const output =
    outputChannel ??
    vscode.window.createOutputChannel('BoardLab', { log: true })
  if (!outputChannel) {
    context.subscriptions.push(output)
  }
  const boardlabContext = new BoardLabContextImpl(context, messenger, output)
  if (start) {
    boardlabContext.cliContext.daemon.start()
  }
  return boardlabContext
}

export class BoardLabContextImpl implements BoardLabContext {
  readonly cliContext: CliContext
  readonly sketchbooks: Sketchbooks
  readonly whenCurrentSketchReady: Promise<void>
  readonly outputChannel: vscode.OutputChannel
  revealSketch: (sketch: Sketch | SketchFolder) => Promise<void> = async () => {
    /* NOOP */
  }

  readonly platformsManager: PlatformsManager
  readonly librariesManager: LibrariesManager
  readonly monitorManager: MonitorManager
  readonly boardsListWatcher: BoardsListWatcher
  readonly monitorsRegistry: MonitorsRegistry

  private readonly pinnedSketches: RecentItems<string>
  private readonly recentSketches: RecentItems<string>
  private readonly pinnedBoards: RecentItems<BoardIdentifier> // TODO: use FQBN?
  private readonly recentBoards: RecentItems<BoardIdentifier>
  private readonly pinnedPorts: RecentItems<PortQName>
  private readonly recentPorts: RecentItems<PortQName>
  private readonly workspaceState: vscode.Memento

  private readonly _onDidChangeCurrentSketch: vscode.EventEmitter<
    SketchFolder | undefined
  >

  private readonly _onDidChangeSketch: vscode.EventEmitter<
    ChangeEvent<SketchFolder>
  >

  private readonly _onDidChangeConfig: vscode.EventEmitter<
    ChangeEvent<CliConfig>
  >

  private readonly _onDidChange: vscode.EventEmitter<unknown>

  private _currentSketchIndex = -1
  private _client?: Promise<Client>
  private _currentCliConfig?: TrackedCliConfig

  // Active profiles per profiles document URI (sketch.yaml)
  private readonly activeProfilesByUri: Map<string, string>
  private readonly portSettingsCache = new Map<
    string,
    MonitorPortSettingDescriptor[]
  >()

  private readonly _onDidChangeActiveProfile = new vscode.EventEmitter<
    Readonly<{ uri: string; name?: string }>
  >()

  private _boardDetailsCache: Map<
    string,
    ApiBoardDetails | PlatformNotInstalledError
  > = new Map()

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly messenger: Messenger,
    outputChannel: vscode.OutputChannel
  ) {
    this.outputChannel = outputChannel
    this.workspaceState = context.workspaceState
    this.cliContext = new CliContext(context)
    this._client = createClient(this.cliContext)
    this._currentCliConfig = this.snapshotCliConfig(
      this.cliContext.cliConfig.data
    )
    context.subscriptions.push(
      this.cliContext.cliConfig.onDidChangeData((data) => {
        const previous = this._currentCliConfig
        const current = this.snapshotCliConfig(data)

        const changedProperties: (keyof CliConfig)[] = []
        if (previous?.dataDirPath !== current?.dataDirPath) {
          changedProperties.push('dataDirPath')
        }
        if (previous?.userDirPath !== current?.userDirPath) {
          changedProperties.push('userDirPath')
        }

        const internalChangedProperties: (keyof TrackedCliConfig)[] = [
          ...changedProperties,
        ]

        if (
          previous?.additionalUrls?.length !==
            current?.additionalUrls?.length ||
          new Set([...(previous?.additionalUrls ?? [])]).size !==
            new Set([...(current?.additionalUrls ?? [])]).size
        ) {
          internalChangedProperties.push('additionalUrls')
        }
        if (previous?.networkProxy !== current?.networkProxy) {
          internalChangedProperties.push('networkProxy')
        }
        if (previous?.locale !== current?.locale) {
          internalChangedProperties.push('locale')
        }

        if (!changedProperties.length && !internalChangedProperties.length) {
          return
        }

        this._currentCliConfig = current

        // No package/libraries index update, etc. when the previous state was undefined (first load)
        if (current && internalChangedProperties.length && previous) {
          this.handleCliConfigChange({
            object: current,
            changedProperties: internalChangedProperties,
          })
        }

        // Only fires when API props changed
        if (current && changedProperties.length) {
          this._onDidChangeConfig.fire({
            object: current,
            changedProperties,
          })
        }
      })
    )
    this.sketchbooks = new Sketchbooks(context, this)
    this.platformsManager = new PlatformsManager(
      this,
      messenger,
      'boardlab.platformsManager'
    )
    this.librariesManager = new LibrariesManager(
      this,
      messenger,
      'boardlab.librariesManager'
    )
    this.monitorManager = new MonitorManager(
      context,
      this.cliContext,
      messenger,
      outputChannel
    )
    this.monitorsRegistry = new InMemoryMonitorsRegistry()
    this.boardsListWatcher = new BoardsListWatcher(() =>
      this.monitorManager.getBridgeInfo()
    )
    this.boardsListWatcher.start()
    // Load active profiles from global state
    const saved = (context.globalState.get(
      mementoKey('activeProfiles', 'profiles')
    ) || {}) as Record<string, string>
    this.activeProfilesByUri = new Map(Object.entries(saved))
    // this.cliContext.update(); // check for CLI version updates!

    const memento = context.globalState
    const workspaceScope =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'global'
    this.pinnedSketches = new MementoRecentItems<string>(
      mementoKey('pinnedSketches'),
      memento
    )
    this.recentSketches = new MementoRecentItems<string>(
      mementoKey('recentSketches'),
      memento
    )
    this.pinnedBoards = new MementoRecentItems<BoardIdentifier>(
      mementoKey('pinnedBoards', workspaceScope),
      memento,
      boardIdentifierEquals
    )
    this.recentBoards = new MementoRecentItems<BoardIdentifier>(
      mementoKey('recentBoards', workspaceScope),
      memento,
      boardIdentifierEquals
    )
    this.pinnedPorts = new MementoRecentItems<PortQName>(
      mementoKey('pinnedPorts'),
      memento
    )
    this.recentPorts = new MementoRecentItems<PortQName>(
      mementoKey('recentPorts'),
      memento
    )

    this._onDidChangeCurrentSketch = new vscode.EventEmitter()
    this._onDidChangeSketch = new vscode.EventEmitter()
    this._onDidChangeConfig = new vscode.EventEmitter()
    /** @deprecated Never emits events */
    this._onDidChange = new vscode.EventEmitter()

    context.subscriptions.push(
      this._onDidChangeCurrentSketch,
      this._onDidChangeSketch,
      this._onDidChangeConfig,
      this.pinnedSketches,
      this.recentSketches,
      this.pinnedBoards,
      this.recentBoards,
      this.pinnedPorts,
      this.recentPorts,
      this.sketchbooks,
      this.platformsManager,
      this.librariesManager,
      this.monitorManager,
      this.monitorsRegistry,
      this.boardsListWatcher,
      this._onDidChangeActiveProfile,
      vscode.commands.registerCommand('boardlab.selectSketch', () =>
        this.selectSketch()
      ),
      vscode.commands.registerCommand(
        'boardlab.openMainSketchFile',
        async () => {
          const sketchFolder = this.currentSketch ?? (await this.selectSketch())
          if (!sketchFolder) {
            return
          }
          const sketchFolderName = path.basename(sketchFolder.sketchPath)
          const mainSketchFileUri = vscode.Uri.file(
            path.join(sketchFolder.sketchPath, `${sketchFolderName}.ino`)
          )
          return vscode.window.showTextDocument(mainSketchFileUri)
        }
      ),
      vscode.commands.registerCommand('boardlab.selectBoard', (params) => {
        const sketch = hasSketchFolder(params) ? params.sketch : undefined
        return this.selectBoard(sketch)
      }),
      vscode.commands.registerCommand('boardlab.selectPort', (params) => {
        const sketch = hasSketchFolder(params) ? params.sketch : undefined
        return this.selectPort(sketch)
      }),
      vscode.commands.registerCommand('boardlab.configureBoard', (params) => {
        const sketch = hasSketchFolder(params) ? params.sketch : undefined
        return this.configureBoard(sketch)
      }),
      vscode.commands.registerCommand('boardlab.selectProgrammer', (params) => {
        const sketch = hasSketchFolder(params) ? params.sketch : undefined
        return this.selectProgrammer(sketch)
      }),
      vscode.commands.registerCommand(
        'boardlab.selectConfigOption',
        (params) => {
          if (typeof params === 'string') {
            return this.selectConfigOption(params)
          }
          type HasOption = Readonly<{ option: string }>
          const hasOption = (arg: unknown): arg is HasOption =>
            typeof arg === 'object' &&
            arg !== null &&
            typeof (<HasOption>arg).option === 'string'
          if (hasSketchFolder(params) && hasOption(params)) {
            return this.selectConfigOption(params.option, params.sketch)
          }
        }
      ),
      vscode.commands.registerCommand(
        'boardlab.resetConfigOption',
        (params) => {
          if (
            params instanceof ConfigOptionItem &&
            params.sketch instanceof SketchFolderImpl &&
            isBoardDetails(params.sketch.board) &&
            params.defaultConfigValue
          ) {
            this.updateConfigOptions(
              params.sketch,
              params.option,
              params.defaultConfigValue
            )
          }
        }
      ),
      vscode.commands.registerCommand('boardlab.pickSketch', () =>
        pickSketch(this.sketchbooks, this.pinnedSketches, this.recentSketches)
      ),
      vscode.commands.registerCommand('boardlab.pickBoard', () =>
        this.pickBoard()
      ),
      vscode.commands.registerCommand('boardlab.pickPort', () =>
        this.pickPort()
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.handleActiveTextEditorDidChange(editor)
      ),
      this.sketchbooks,
      messenger.onRequest(
        getSelectedBoard,
        async () => this.currentSketch?.board
      ),
      this.platformsManager.onDidInstall((event) => {
        this._boardDetailsCache = new Map()
        this.resolveMissingBoardsAfterPlatformInstall(event).catch((error) =>
          console.warn('Failed to resolve boards after platform install', error)
        )
      }),
      this.platformsManager.onDidUninstall((event) => {
        this._boardDetailsCache = new Map()
        this.handlePlatformUninstalled(event).catch((error) =>
          console.warn('Failed to handle platform uninstall', error)
        )
      })
    )
    vscode.commands.executeCommand(
      'setContext',
      'currentSketchPath',
      this.currentSketch?.sketchPath ?? ''
    )
    const lastSelectedSketchPath = this.workspaceState.get<string>(
      LAST_CURRENT_SKETCH_WORKSPACE_KEY
    )

    this.whenCurrentSketchReady = this.initializeCurrentSketch(
      lastSelectedSketchPath
    )
  }

  // --- Active Profile API (extension-local) ---
  get onDidChangeActiveProfile(): vscode.Event<
    Readonly<{ uri: string; name?: string }>
  > {
    return this._onDidChangeActiveProfile.event
  }

  /**
   * Returns the active profile name for the given profiles document URI or
   * sketch folder, if set.
   */
  getActiveProfileForUri(
    uriOrSketchFolder:
      | string
      | vscode.Uri
      | Pick<SketchFolder, 'sketchPath'>
      | undefined
  ): string | undefined {
    if (!uriOrSketchFolder) {
      return undefined
    }
    let uri: string
    if (typeof uriOrSketchFolder === 'string') {
      uri = uriOrSketchFolder
    } else if (uriOrSketchFolder instanceof vscode.Uri) {
      uri = uriOrSketchFolder.toString()
    } else {
      uri = vscode.Uri.file(
        path.join(uriOrSketchFolder.sketchPath, 'sketch.yaml')
      ).toString()
    }
    return this.activeProfilesByUri.get(uri)
  }

  async getValidatedActiveProfileForSketch(
    sketchPath: string
  ): Promise<string | undefined> {
    try {
      const docUri = vscode.Uri.file(path.join(sketchPath, 'sketch.yaml'))
      const name = this.activeProfilesByUri.get(docUri.toString())
      if (!name) return undefined

      const profiles = await readProfiles(sketchPath, false).catch(
        () => undefined
      )
      const container = (profiles as any)?.profiles ?? {}
      return container && typeof container[name] !== 'undefined'
        ? name
        : undefined
    } catch {
      return undefined
    }
  }

  /** Sets or clears the active profile for the given profiles document URI. */
  async setActiveProfileForUri(
    uri: string,
    name: string | undefined
  ): Promise<void> {
    const changed =
      (name ?? undefined) !== (this.activeProfilesByUri.get(uri) ?? undefined)
    if (!changed) return

    if (!name) this.activeProfilesByUri.delete(uri)
    else this.activeProfilesByUri.set(uri, name)

    await this.persistActiveProfiles()
    this._onDidChangeActiveProfile.fire({ uri, name })
  }

  private async persistActiveProfiles(): Promise<void> {
    const obj = Object.fromEntries(this.activeProfilesByUri.entries())
    await this.context.globalState.update(
      mementoKey('activeProfiles', 'profiles'),
      obj
    )
  }

  private async syncCliConfig(
    event: ChangeEvent<TrackedCliConfig>,
    reportOneUnitOfWork?: () => void
  ): Promise<void> {
    if (!event.changedProperties.length) return
    await this.updateDaemonState(event, reportOneUnitOfWork)
    // await this.persistDaemonState() // XXX: no need to write it to the disk, the user changes the file directly
    // TODO: this will be required if the file is changed with a graphical editor
    reportOneUnitOfWork?.()
  }

  private async updateDaemonState(
    event: ChangeEvent<TrackedCliConfig>,
    reportOneUnitOfWork?: () => void
  ): Promise<void> {
    const { arduino } = await this.client
    for (const property of event.changedProperties) {
      const key = arduinoCliConfigMapping[property]
      if (key) {
        await arduino.setConfiguration({
          key,
          encodedValue: JSON.stringify(event.object[property]),
          valueFormat: 'json',
        })
      }
      reportOneUnitOfWork?.()
    }
  }

  // private async persistDaemonState(): Promise<void> {
  //   const { arduino } = await this.client
  //   await arduino.saveConfiguration({ settingsFormat: 'yaml' })
  // }

  private async handleCliConfigChange(
    event: ChangeEvent<TrackedCliConfig>
  ): Promise<void> {
    const failedIndexUpdateReports: IndexUpdateReport[] = []
    let mustUpdatePackageIndex = false
    let mustUpdateLibraryIndex = false
    let didUpdatePackageIndex = false
    let didUpdateLibraryIndex = false
    let totalWork = 0

    if (event.changedProperties.includes('additionalUrls')) {
      mustUpdatePackageIndex = true
      // +1 for the `package_index.tar.bz2` when updating the platform index.
      totalWork += 1
      totalWork += event.object.additionalUrls?.length ?? 0
    }

    // when the sketchbook location changes, the library index must be updated
    if (event.changedProperties.includes('userDirPath')) {
      mustUpdateLibraryIndex = true
      // The `library_index.json.gz` and `library_index.json.sig` when running the library index update.
      totalWork += 2
    }

    // sync props to CLI daemon
    totalWork++
    const progressPerUnitOfWork = 100 / totalWork

    const { arduino } = await this.client
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: true,
        title: 'Updating package index',
      },
      async (progress, token) => {
        if (token.isCancellationRequested) {
          return
        }
        const controller = new AbortController()
        const toDispose = token.onCancellationRequested(() => {
          controller.abort()
        })
        const { signal } = controller

        try {
          // Update daemon state from the changed config read from the file
          await this.syncCliConfig(event, () =>
            progress.report({ increment: progressPerUnitOfWork })
          )

          if (mustUpdatePackageIndex) {
            for await (const { message } of arduino.updatePackageIndex(
              { ignoreCustomPackageIndexes: false },
              signal
            )) {
              switch (message?.$case) {
                case 'downloadProgress':
                  switch (message.downloadProgress.message?.$case) {
                    case 'end': {
                      progress.report({ increment: progressPerUnitOfWork })
                      break
                    }
                  }
                  break
                case 'result': {
                  // Update index if at least one index was updated
                  if (
                    message.result.updatedIndexes.some(
                      (updateResult) =>
                        updateResult.status ===
                        // eslint-disable-next-line camelcase
                        IndexUpdateReport_Status.STATUS_UPDATED
                    )
                  ) {
                    didUpdatePackageIndex = true
                  }

                  failedIndexUpdateReports.push(
                    ...message.result.updatedIndexes.filter(
                      (updateResult) =>
                        updateResult.status ===
                        // eslint-disable-next-line camelcase
                        IndexUpdateReport_Status.STATUS_FAILED
                    )
                  )
                  break
                }
              }
            }
          }

          if (mustUpdateLibraryIndex) {
            for await (const { message } of arduino.updateLibraryIndex({})) {
              switch (message?.$case) {
                case 'downloadProgress':
                  switch (message.downloadProgress.message?.$case) {
                    case 'end': {
                      progress.report({ increment: progressPerUnitOfWork })
                      break
                    }
                  }
                  break
                case 'result': {
                  didUpdateLibraryIndex =
                    message.result.librariesIndex?.status ===
                    // eslint-disable-next-line camelcase
                    IndexUpdateReport_Status.STATUS_UPDATED

                  if (
                    message.result.librariesIndex?.status ===
                    // eslint-disable-next-line camelcase
                    IndexUpdateReport_Status.STATUS_FAILED
                  ) {
                    failedIndexUpdateReports.push(message.result.librariesIndex)
                  }
                  break
                }
              }
            }
          }

          if (didUpdatePackageIndex || didUpdateLibraryIndex) {
            await arduino.init()
          }

          if (didUpdatePackageIndex) {
            this.platformsManager.notifyIndexUpdated()
          }
          if (didUpdateLibraryIndex) {
            this.librariesManager.notifyIndexUpdated()
          }
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') {
            // ignore
          } else {
            throw e
          }
        } finally {
          toDispose.dispose()
        }
      }
    )
  }

  private async handleActiveTextEditorDidChange(
    editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor
  ): Promise<boolean> {
    const uri = editor?.document.uri
    if (uri) {
      const sketch = this.sketchbooks.find(uri.toString())
      if (sketch && this.isSketchInWorkspace(sketch)) {
        const currentSketch = this.currentSketch
        if (currentSketch && sketchPathEquals(currentSketch, sketch)) {
          return true
        }
        return this.updateCurrentSketch(sketch)
      }
    }
    return false
  }

  private async initializeCurrentSketch(
    lastSelectedSketchPath: string | undefined
  ): Promise<void> {
    try {
      const currentSketchFound = await this.handleActiveTextEditorDidChange(
        vscode.window.activeTextEditor
      )
      if (!currentSketchFound) {
        await restoreCurrentSketch(
          () => ({
            lastSelectedSketchPath,
            openedSketchPaths: this.getWorkspaceOpenedSketchPaths(),
            resolvedSketchPaths: this.getWorkspaceResolvedSketches().map(
              (sketch) => sketch.sketchPath
            ),
            isLoading: this.sketchbooks.isLoading,
            isEmpty: this.sketchbooks.isEmpty,
          }),
          {
            updateCurrentSketch: (sketchPath) =>
              this.updateCurrentSketch(sketchPath),
            onDidRefresh: (listener) => this.sketchbooks.onDidRefresh(listener),
          }
        )
      }
      await this.waitForSketchbooksReady()
    } catch (error) {
      console.warn('Failed to restore initial sketch selection', error)
    }
  }

  private async waitForSketchbooksReady(): Promise<void> {
    if (!this.sketchbooks.isLoading) {
      return
    }
    await new Promise<void>((resolve) => {
      let resolved = false
      let disposable = new vscode.Disposable(() => {
        /* noop */
      })
      const finalize = () => {
        if (resolved) {
          return
        }
        resolved = true
        disposable?.dispose()
        resolve()
      }
      disposable = this.sketchbooks.onDidRefresh(() => {
        if (!this.sketchbooks.isLoading) {
          finalize()
        }
      })
      this.context.subscriptions.push(disposable)
      if (!this.sketchbooks.isLoading) {
        finalize()
      }
    })
  }

  get extensionUri(): vscode.Uri {
    return this.context.extensionUri
  }

  get openedSketches(): readonly SketchFolder[] {
    const { openedSketches, resolvedSketchFolders } = this.sketchbooks
    return openedSketches.reduce((acc, openedSketch) => {
      const resolvedSketch = resolvedSketchFolders.find((sketchFolder) =>
        sketchPathEquals(sketchFolder, openedSketch)
      )
      return acc.concat(
        resolvedSketch ?? {
          board: undefined,
          compileSummary: undefined,
          configOptions: undefined,
          port: undefined,
          selectedProgrammer: undefined,
          sketchPath: openedSketch.uri.fsPath,
        }
      )
    }, [] as SketchFolder[])
  }

  get onDidChangeCurrentSketch(): vscode.Event<SketchFolder | undefined> {
    return this._onDidChangeCurrentSketch.event
  }

  get onDidChangeSketchFolders(): vscode.Event<SketchFoldersChangeEvent> {
    return this.sketchbooks.onDidChangeSketchFolders
  }

  get onDidChangeSketch(): vscode.Event<ChangeEvent<SketchFolder>> {
    return this._onDidChangeSketch.event
  }

  get onDidChangeConfig(): vscode.Event<ChangeEvent<CliConfig>> {
    return this._onDidChangeConfig.event
  }

  /** @deprecated Always undefined */
  compileSummary: CompileSummary | undefined
  /** @deprecated Always undefined */
  fqbn: string | undefined
  /** @deprecated Always undefined */
  port: Port | undefined
  /** @deprecated Always undefined */
  boardDetails: ApiBoardDetails | undefined
  /** @deprecated Always undefined */
  userDirPath: string | undefined
  /** @deprecated Always undefined */
  dataDirPath: string | undefined
  /** @deprecated Always undefined */
  sketchPath: string | undefined
  /** @deprecated Never emits */
  onDidChange<T extends keyof ArduinoState>(
    _: T
  ): vscode.Event<ArduinoState[T]> {
    return this._onDidChange.event as vscode.Event<ArduinoState[T]>
  }

  get client(): Promise<Client> {
    if (!this._client) {
      this._client = createClient(this.cliContext)
    }
    return this._client
  }

  get config(): CliConfig {
    if (!this._currentCliConfig) {
      return {
        dataDirPath: undefined,
        userDirPath: undefined,
      }
    }
    return this._currentCliConfig
  }

  get currentSketch(): SketchFolder | undefined {
    return this.openedSketches[this._currentSketchIndex]
  }

  private getWorkspaceResolvedSketches(): readonly SketchFolderImpl[] {
    return this.sketchbooks.resolvedSketchFolders.filter((sketch) =>
      this.isSketchInWorkspace(sketch)
    )
  }

  private getWorkspaceOpenedSketchPaths(): string[] {
    return this.openedSketches
      .filter((sketch) => this.isSketchInWorkspace(sketch))
      .map((sketch) => sketch.sketchPath)
  }

  private isSketchInWorkspace(sketch: SketchFolder | Sketch): boolean {
    const uri =
      'sketchPath' in sketch ? vscode.Uri.file(sketch.sketchPath) : sketch.uri
    return Boolean(vscode.workspace.getWorkspaceFolder(uri))
  }

  private snapshotCliConfig(
    config: TrackedCliConfig | undefined
  ): TrackedCliConfig | undefined {
    if (!config) {
      return undefined
    }
    return {
      dataDirPath: config.dataDirPath,
      userDirPath: config.userDirPath,
      additionalUrls: config.additionalUrls ?? [],
    }
  }

  private async updateCurrentSketch(
    pathLike: SketchPathLike
  ): Promise<boolean> {
    const { arduino } = await this.client
    const sketch = await this.sketchbooks.resolve(pathLike, arduino)
    if (sketch) {
      const index = this.openedSketches.findIndex((s) =>
        sketchPathEquals(s, sketch)
      )
      this._currentSketchIndex = index
      vscode.commands.executeCommand(
        'setContext',
        'currentSketchPath',
        sketch.sketchPath
      )
      this._onDidChangeCurrentSketch.fire(sketch)
      await this.workspaceState.update(
        LAST_CURRENT_SKETCH_WORKSPACE_KEY,
        sketch.sketchPath
      )
      return true
    }
    vscode.window.showErrorMessage(`Sketch ${pathLike} is not opened.`)
    return false
  }

  async selectSketch(): Promise<SketchFolder | undefined> {
    const sketch = await pickSketch(
      this.sketchbooks,
      this.pinnedSketches,
      this.recentSketches
    )
    if (sketch) {
      await this.updateCurrentSketch(sketch)
      return this.currentSketch
    }
    return undefined
  }

  async updateCompileSummary(
    sketchPath: string,
    result: BuilderResult | undefined
  ): Promise<void> {
    let sketch = this.sketchbooks.resolvedSketchFolders.find(
      (folder) => folder.sketchPath === sketchPath
    )
    if (!sketch) {
      const { arduino } = await this.client
      sketch = await this.sketchbooks.resolve(sketchPath, arduino)
    }
    if (!sketch) {
      return
    }
    const previous = sketch.compileSummary
    const summary = result ? toCompileSummary(result) : undefined
    if (!summary && !previous) {
      return
    }
    sketch.compileSummary = summary
    this._onDidChangeSketch.fire({
      object: sketch,
      changedProperties: ['compileSummary'],
    })
  }

  async pickBoardsConfig(currentSketch: SketchFolder | undefined): Promise<
    | Readonly<{
        selectedBoard: BoardIdentifier | ApiBoardDetails
        selectedPort: SelectedPort
      }>
    | undefined
  > {
    if (!currentSketch) {
      return undefined
    }
    const { arduino } = await this.client
    const boardsConfig = {
      selectedBoard: currentSketch.board,
      selectedPort: currentSketch.port,
    }
    const pickedBoard = await pickBoard(
      arduino,
      boardsConfig,
      this.boardsListWatcher.detectedPorts,
      this.boardsListWatcher.onDidChangeDetectedPorts
    )
    let board: BoardIdentifier
    let port: SketchPort
    if (isBoardsListItem(pickedBoard)) {
      port = pickedBoard.port
      board = pickedBoard.board
    } else if (pickedBoard) {
      board = pickedBoard
      port = await this.pickPort(currentSketch)
    } else {
      return undefined
    }
    if (!port) {
      return undefined
    }
    return {
      selectedBoard: board,
      selectedPort: port,
    }
  }

  async selectBoardsConfig(
    currentSketch:
      | SketchFolder
      | Promise<SketchFolder | undefined>
      | undefined = this.selectSketch()
  ): Promise<Defined<BoardsConfig> | undefined> {
    const sketch = await currentSketch
    if (!(sketch instanceof SketchFolderImpl)) {
      return undefined
    }
    const boardsConfig = await this.pickBoardsConfig(sketch)
    if (!boardsConfig) {
      return undefined
    }
    sketch.setBoard(boardsConfig.selectedBoard)
    sketch.setPort(boardsConfig.selectedPort)
    this.emitSketchChange(sketch, 'port', 'board')
    return boardsConfig
  }

  async pickPort(
    currentSketch: SketchFolder | undefined = this.currentSketch
  ): Promise<SketchPort> {
    if (!currentSketch) {
      return undefined
    }
    const port = await pickPort(
      () => this.boardsListWatcher.detectedPorts,
      this.boardsListWatcher.onDidChangeDetectedPorts,
      this.pinnedPorts,
      this.recentPorts
    )
    return port
  }

  async selectPort(
    currentSketch:
      | SketchFolder
      | Promise<SketchFolder | undefined>
      | undefined = this.currentSketch ?? this.selectSketch()
  ): Promise<SketchPort> {
    const sketch = await currentSketch
    if (!(sketch instanceof SketchFolderImpl)) {
      return undefined
    }
    const port = await this.pickPort(sketch)
    if (!port) {
      return undefined
    }
    sketch.setPort(port)
    this.emitSketchChange(sketch, 'port')
    return port
  }

  async pickBoard(
    currentSketch: SketchFolder | undefined = this.currentSketch
  ): Promise<BoardsListItemWithBoard | BoardIdentifier | undefined> {
    if (!currentSketch) {
      return undefined
    }
    const boardsConfig: BoardsConfig = {
      selectedBoard: this.currentSketch?.board,
      selectedPort: this.currentSketch?.port,
    }
    const { arduino } = await this.client
    return pickBoard(
      arduino,
      boardsConfig,
      this.boardsListWatcher.detectedPorts,
      this.boardsListWatcher.onDidChangeDetectedPorts,
      this.pinnedBoards,
      this.recentBoards
    )
  }

  async getPortSettingsForProtocol(
    protocol: string,
    fqbn?: string
  ): Promise<MonitorPortSettingDescriptor[]> {
    const cached = this.portSettingsCache.get(protocol)
    if (cached) return cached
    const { arduino } = await this.client
    const { settings } = await arduino.enumeratePortConfigs({
      portProtocol: protocol,
      fqbn: fqbn ?? '',
    })
    this.portSettingsCache.set(protocol, settings ?? [])
    return settings ?? []
  }

  async getBoardDetails(fqbn: string | FQBN): Promise<ApiBoardDetails> {
    const sanitized =
      typeof fqbn === 'string'
        ? new FQBN(fqbn).toString(true)
        : fqbn.toString(true)

    const cached = this._boardDetailsCache.get(sanitized)
    if (cached) {
      if (cached instanceof PlatformNotInstalledError) {
        throw cached
      }
      return cached
    }

    const { arduino } = await this.client
    try {
      const boardDetails = await ensureBoardDetails(sanitized, arduino)
      this._boardDetailsCache.set(sanitized, boardDetails)
      return boardDetails
    } catch (err) {
      if (err instanceof PlatformNotInstalledError) {
        this._boardDetailsCache.set(sanitized, err)
      }
      throw err
    }
  }

  async selectBoard(
    currentSketch:
      | SketchFolder
      | Promise<SketchFolder | undefined>
      | undefined = this.currentSketch ?? this.selectSketch()
  ): Promise<BoardsListItemWithBoard | BoardIdentifier | undefined> {
    const sketch = await currentSketch
    if (!(sketch instanceof SketchFolderImpl)) {
      return undefined
    }
    const picked = await this.pickBoard(sketch)
    if (!picked) {
      return undefined
    }
    let board: BoardIdentifier | ApiBoardDetails | undefined
    let port: PortIdentifier | undefined
    if (isBoardIdentifier(picked)) {
      board = picked
    } else {
      board = picked.board
    }
    if (picked && 'port' in picked && isPortIdentifier(picked.port)) {
      port = picked.port
    }

    let platformRequirement: Required<PlatformInfo> | undefined
    if (board.fqbn) {
      const { arduino } = await this.client
      const boardDetails = await getBoardDetails(board.fqbn, arduino)
      if (boardDetails) {
        board = boardDetails
      } else {
        try {
          // for attached + detected Arduino boards when fqbn is available but platform is missing
          const fqbn = new FQBN(board.fqbn)
          const platformId = `${fqbn.vendor}:${fqbn.arch}`
          const platform =
            await this.platformsManager.lookupPlatformQuick(platformId)
          if (platform) {
            platformRequirement = {
              id: platformId,
              name: platform.label,
              version: platform.availableVersions[0],
            }
          }
        } catch {}
      }
    }
    if (!platformRequirement) {
      platformRequirement =
        !isBoardDetails(board) && board
          ? getPlatformRequirement(board)
          : undefined
    }

    if (platformRequirement && board) {
      const { id, name, version } = platformRequirement

      vscode.window
        .showInformationMessage(
          `To ensure the proper functioning of the extension, the ${name} (${id}) platform must be installed for the ${board.name} board. Would you like to proceed with the installation now?`,
          'Install',
          'Skip'
        )
        .then(async (answer) => {
          if (answer === 'Install') {
            await this.platformsManager.install({
              id,
              name,
              version,
            })
            // TODO: reselect board with FQBN!
          }
        })
    }
    sketch.setBoard(board)
    if (port) {
      sketch.setPort(port)
    }
    this.emitSketchChange(sketch, 'port', 'board')

    // TODO: move this somewhere else
    this.messenger.sendNotification(
      notifyDidChangeSelectedBoard,
      { type: 'webview', webviewType: 'boardlab.examples' },
      board
    )

    return board
  }

  async applyBoardSettingsFromFqbn(
    sketch: SketchFolderImpl,
    fqbn: string
  ): Promise<void> {
    const boardDetails = await this.getBoardDetails(fqbn)
    sketch.setBoard(boardDetails)
    const parsed = new FQBN(fqbn)
    const hasOptions = parsed.options && Object.keys(parsed.options).length > 0
    sketch.setConfigOptions(hasOptions ? parsed.toString() : undefined)
    this.emitSketchChange(sketch, 'board', 'configOptions')
  }

  async pickProgrammer(
    currentSketch: SketchFolder | undefined = this.currentSketch
  ): Promise<Programmer | undefined> {
    if (!currentSketch) {
      return undefined
    }
    const board = currentSketch.board
    if (!isBoardDetails(board)) {
      return undefined
    }
    if (!board.programmers.length) {
      return undefined
    }
    const selectedProgrammer = currentSketch.selectedProgrammer
    const selectedProgrammerId =
      typeof selectedProgrammer === 'string'
        ? selectedProgrammer
        : selectedProgrammer?.id

    type ProgrammerQuickItem = vscode.QuickPickItem & Programmer

    const programmerQuickItems: ProgrammerQuickItem[] = board.programmers.map(
      (p) => ({
        label: p.name,
        description: p.id,
        iconPath:
          p.id === selectedProgrammerId
            ? new vscode.ThemeIcon('check')
            : undefined,
        ...p,
      })
    )
    const selected = await vscode.window.showQuickPick(programmerQuickItems, {
      matchOnDescription: true,
      placeHolder: `Select a programmer for ${board.name}`,
    })
    if (!selected) {
      return undefined
    }
    return {
      id: selected.id,
      name: selected.name,
      platform: selected.platform,
    }
  }

  async selectProgrammer(
    currentSketch:
      | SketchFolder
      | Promise<SketchFolder | undefined>
      | undefined = this.currentSketch ?? this.selectSketch()
  ): Promise<Programmer | undefined> {
    const sketch = await currentSketch
    if (!(sketch instanceof SketchFolderImpl)) {
      return undefined
    }
    const programmer = await this.pickProgrammer(sketch)
    if (!programmer) {
      return undefined
    }
    sketch.setSelectedProgrammer(programmer)
    this.emitSketchChange(sketch, 'selectedProgrammer')
    return programmer
  }

  async pickConfigOption(
    option: string,
    currentSketch: SketchFolder | undefined = this.currentSketch
  ): Promise<Omit<ConfigValue, 'selected'> | undefined> {
    if (!(currentSketch instanceof SketchFolderImpl)) {
      return undefined
    }
    const board = currentSketch.board
    if (!isBoardDetails(board)) {
      return undefined
    }
    if (!board.configOptions.length) {
      return undefined
    }
    const configOption = board.configOptions.find(
      (configOption) => configOption.option === option
    )
    if (!configOption) {
      return undefined
    }
    const configValues = configOption.values
    const selectedValue = getSelectedConfigValue(
      option,
      configValues,
      currentSketch.configOptions ?? board.fqbn
    )

    const defaultOptions =
      (currentSketch.defaultConfigOptions &&
        new FQBN(currentSketch.defaultConfigOptions).options) ??
      {}
    const defaultValue = defaultOptions && defaultOptions[option]

    type ConfigValueQuickItem = vscode.QuickPickItem & ConfigValue
    const quickItems: ConfigValueQuickItem[] = configValues.map((v) => ({
      label: v.valueLabel,
      description: !defaultValue
        ? v.value
        : `${v.value}${v.value === defaultValue ? ' (default)' : ''}`,
      iconPath:
        selectedValue?.value === v.value
          ? new vscode.ThemeIcon('check')
          : undefined,
      ...v,
    }))

    const selected = await vscode.window.showQuickPick(quickItems, {
      matchOnDescription: true,
      placeHolder: `Select value for ${configOption.optionLabel}`,
    })

    if (!selected) {
      return undefined
    }
    return {
      value: selected.value,
      valueLabel: selected.valueLabel,
    }
  }

  async selectConfigOption(
    option: string,
    currentSketch:
      | SketchFolder
      | Promise<SketchFolder | undefined>
      | undefined = this.currentSketch ?? this.selectSketch()
  ): Promise<ConfigValue['value'] | undefined> {
    const sketch = await currentSketch
    if (!(sketch instanceof SketchFolderImpl)) {
      return undefined
    }
    const board = sketch.board
    if (!isBoardDetails(board)) {
      return undefined
    }
    const picked = await this.pickConfigOption(option, sketch)
    if (!picked) {
      return undefined
    }

    return this.updateConfigOptions(sketch, option, picked.value)
  }

  private updateConfigOptions(
    sketch: SketchFolderImpl,
    option: string,
    value: string
  ): ConfigValue['value'] | undefined {
    const board = sketch.board
    if (!isBoardDetails(board)) {
      return undefined
    }

    const overridesFqbn = computeConfigOverrides({
      boardFqbn: board.fqbn,
      boardConfigOptions: board.configOptions,
      defaultConfigOptions: sketch.defaultConfigOptions,
      currentConfigOptions: sketch.configOptions,
      option,
      value,
    })

    sketch.setConfigOptions(overridesFqbn)
    this.emitSketchChange(sketch, 'configOptions')
    return value
  }

  async configureBoard(
    currentSketch:
      | SketchFolder
      | Promise<SketchFolder | undefined>
      | undefined = this.currentSketch ?? this.selectSketch()
  ): Promise<void> {
    const sketch = await currentSketch
    if (!(sketch instanceof SketchFolderImpl)) {
      return
    }
    if (!sketch.board) {
      await this.selectBoard(sketch)
    }
    if (!sketch.board) {
      return
    }
    this.revealSketch(sketch)
  }

  private emitSketchChange(
    sketch: SketchFolder,
    ...changedProperties: ChangeEvent<SketchFolder>['changedProperties']
  ): void {
    if (!changedProperties.length) {
      return
    }
    this._onDidChangeSketch.fire({
      object: sketch,
      changedProperties,
    })
  }

  private async resolveMissingBoardsAfterPlatformInstall(
    event: InstallEventParams
  ): Promise<void> {
    const platformId = event.id
    const platformLabel = await this.platformsManager
      .lookupPlatformQuick(platformId)
      .then((entry) => entry?.label)
      .catch(() => undefined)

    const sketches = this.sketchbooks.resolvedSketchFolders
    if (!sketches.length) {
      return
    }

    const { arduino } = await this.client

    for (const sketch of sketches) {
      const board = sketch.board
      if (!board?.name || board.fqbn) {
        continue
      }

      const candidates = await arduino.searchBoard({ searchArgs: board.name })
      const match = matchBoardByName(board.name, candidates, {
        platformId,
      })
      if (!match?.board?.fqbn) {
        continue
      }

      const resolved =
        (await getBoardDetails(match.board.fqbn, arduino)) ?? match.board
      if (!resolved?.fqbn) {
        continue
      }

      const previousName = board.name
      sketch.setBoard(resolved)
      this.emitSketchChange(sketch, 'board')

      if (sketch === this.currentSketch) {
        this.messenger.sendNotification(
          notifyDidChangeSelectedBoard,
          { type: 'webview', webviewType: 'boardlab.examples' },
          resolved
        )
      }

      await this.updateBoardHistoryEntries(previousName, resolved)

      if (
        sketch === this.currentSketch &&
        match.kind !== 'exact' &&
        previousName !== resolved.name
      ) {
        await this.showBoardMatchNotice({
          previousName,
          resolvedName: resolved.name,
          platformId,
          platformLabel,
        })
      }
    }
  }

  private async updateBoardHistoryEntries(
    previousName: string,
    resolved: BoardIdentifier
  ): Promise<void> {
    const resolvedName = resolved.name
    const resolvedFqbn = resolved.fqbn
    if (!resolvedName || !resolvedFqbn) {
      return
    }

    const historyEntry: BoardIdentifier = {
      name: resolvedName,
      fqbn: resolvedFqbn,
    }

    const recentMatches = findBoardHistoryMatches(
      this.recentBoards.items,
      previousName
    )
    for (const candidate of recentMatches) {
      await this.recentBoards.remove(candidate)
    }
    if (recentMatches.length) {
      await this.recentBoards.add(historyEntry)
    }

    const pinnedMatches = findBoardHistoryMatches(
      this.pinnedBoards.items,
      previousName
    )
    for (const candidate of pinnedMatches) {
      await this.pinnedBoards.remove(candidate)
    }
    if (pinnedMatches.length) {
      await this.pinnedBoards.add(historyEntry)
    }
  }

  private async showBoardMatchNotice(params: {
    previousName: string
    resolvedName: string
    platformId: string
    platformLabel?: string
  }): Promise<void> {
    const platformName = params.platformLabel
      ? `${params.platformLabel} (${params.platformId})`
      : params.platformId
    const message = `After installing ${platformName}, board '${params.previousName}' was matched to '${params.resolvedName}' as the closest available board.`
    const action = await vscode.window.showInformationMessage(
      message,
      'Change Board',
      'OK'
    )
    if (action === 'Change Board') {
      await this.selectBoard(this.currentSketch)
    }
  }

  private async handlePlatformUninstalled(
    event: UninstallEventParams
  ): Promise<void> {
    const platformId = event.id
    const platformInfo = await this.getPlatformInfo(platformId)

    await this.updateHistoryForPlatformUninstall(platformId)

    const sketches = this.sketchbooks.resolvedSketchFolders
    if (!sketches.length) {
      return
    }

    for (const sketch of sketches) {
      const board = sketch.board
      if (!board?.fqbn || !matchesPlatformId(board.fqbn, platformId)) {
        continue
      }

      const unresolved = toUnresolvedBoard(board, platformInfo)
      sketch.setBoard(unresolved)
      this.emitSketchChange(sketch, 'board')

      if (sketch === this.currentSketch) {
        this.messenger.sendNotification(
          notifyDidChangeSelectedBoard,
          { type: 'webview', webviewType: 'boardlab.examples' },
          unresolved
        )
      }
    }
  }

  private async getPlatformInfo(
    platformId: string
  ): Promise<{ id: string; name?: string; version?: string }> {
    const quick = await this.platformsManager
      .lookupPlatformQuick(platformId)
      .catch(() => undefined)
    const version = quick?.availableVersions?.[0] || quick?.installedVersion
    return {
      id: platformId,
      name: quick?.label,
      version,
    }
  }

  private async updateHistoryForPlatformUninstall(
    platformId: string
  ): Promise<void> {
    const recentUpdates = collectHistoryUpdates(
      this.recentBoards.items,
      platformId
    )
    await this.applyHistoryUpdates(this.recentBoards, recentUpdates)

    const pinnedUpdates = collectHistoryUpdates(
      this.pinnedBoards.items,
      platformId
    )
    await this.applyHistoryUpdates(this.pinnedBoards, pinnedUpdates)
  }

  private async applyHistoryUpdates(
    history: RecentItems<BoardIdentifier>,
    updates: { remove: BoardIdentifier[]; add: BoardIdentifier[] }
  ): Promise<void> {
    for (const item of updates.remove) {
      await history.remove(item)
    }
    for (const item of updates.add) {
      await history.add(item)
    }
  }
}

async function createClient(cliContext: CliContext): Promise<Client> {
  const { daemon } = cliContext
  const { address } = daemon
  if (address) {
    return initClient(address)
  }
  const deferred = defer<Client>()
  const toDispose = [
    daemon.onDidChangeAddress((address) => {
      if (address) {
        deferred.resolve(initClient(address))
      }
    }),
  ]
  return deferred.promise.finally(() => disposeAll(...toDispose))
}

function initClient(address: DaemonAddress) {
  const client = new Client(address)
  return Promise.resolve(
    vscode.window.withProgress(
      { title: 'Arduino CLI', location: vscode.ProgressLocation.Window },
      async (progress) => {
        await client.start(progress)
        return client
      }
    )
  )
}
