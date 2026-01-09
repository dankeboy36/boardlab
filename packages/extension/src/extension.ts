import { promises as fs } from 'node:fs'
import os from 'node:os'
import * as path from 'node:path'

import type { Mutable, PortIdentifier } from 'boards-list'
import { createPortKey } from 'boards-list'
import { FQBN, valid as isValidFQBN } from 'fqbn'
import * as vscode from 'vscode'
import { Messenger } from 'vscode-messenger'

import type {
  LibraryFilterTopic,
  LibraryFilterType,
  LineEnding,
  MonitorSelectionNotification,
  Resource,
  Version,
  VscodeDataContextParams,
} from '@boardlab/protocol'
import {
  getExampleTree as getExampleTreeRequest,
  getMonitorSelection,
  LibraryFilterTopicLiterals,
  LibraryFilterTypeLiterals,
  listExamples as listExamplesRequest,
  notifyLibrariesFilterChanged,
  notifyPlatformsFilterChanged,
  openExampleReadme as openExampleReadmeRequest,
  openExampleResource as openExampleResourceRequest,
  openExampleSketch as openExampleSketchRequest,
  PlatformFilterTypeLiterals,
  requestConfigureLineEnding,
  requestShowWebviewMessage,
  setLibrariesFilterContext as setLibrariesFilterContextReq,
  setPlatformsFilterContext as setPlatformsFilterContextReq,
} from '@boardlab/protocol'

import { BoardLabContextImpl, createBoardLabContext } from './boardlabContext'
import { AddAdditionalPackageIndexUrlParams } from './cli/config'
import { MonitorEditors, PlotterEditors } from './editors/monitorEditors'
import { ProfilesEditorProvider } from './editors/profilesEditor'
import {
  BoardLabExampleFs,
  buildExampleUri,
  EXAMPLE_SCHEME,
} from './examples/exampleFs'
import { registerExampleReadmeActions } from './examples/exampleReadmeActions'
import { registerExampleReadmeFs } from './examples/exampleReadmeFs'
import { ExamplesIndex } from './examples/examplesIndex'
import { registerExampleCommands } from './examples/importCommands'
import { showLibraryReadme } from './examples/readme'
import { showBuiltinSketchReadmeFromFolderStrict } from './examples/showBuiltinSketchReadme'
import { MonitorFileSystemProvider } from './monitor/monitorFs'
import { MonitorResourceStore } from './monitor/monitorResources'
import { MonitorSelectionCoordinator } from './monitor/monitorSelections'
import { MonitorStatusBar } from './monitor/monitorStatusBar'
import {
  logDetectedPorts,
  logMonitorBridgeMetrics,
} from './monitor/bridgeMetrics'
import { formatMonitorUri, MONITOR_URI_SCHEME } from './monitor/monitorUri'
import { collectCliDiagnostics } from './profile/cliDiagnostics'
import { readProfile, readProfiles, updateProfile } from './profile/profiles'
import { ProfilesCodeActionProvider } from './profile/codeActions'
import { validateProfilesYAML } from './profile/validation'
import { registerProfilesYamlValidation } from './profile/validationHost'
import { CurrentSketchView } from './sketch/currentSketchView'
import {
  cloneSketch,
  openNewSketchWizard,
  openSketch,
  openSketchInNewWindow,
  type AddSketchFolderArgs,
  type CloneSketchArgs,
  type NewSketchParams,
} from './sketch/newSketchWizard'
import { registerSketchbookReadonlyFs } from './sketch/sketchbookFs'
import { SketchbookView } from './sketch/sketchbookView'
import { SketchFolderImpl } from './sketch/sketchFolder'
import type { Resource as SketchResource } from './sketch/types'
import { BoardLabTasks } from './tasks'
import { PlatformMissingStatusBar } from './platformMissingStatusBar'
import {
  getTaskStatus,
  markTaskFinished,
  markTaskRunning,
  tryStopTask,
  type TaskKind,
} from './taskTracker'
import {
  ExamplesViewProvider,
  LibrariesManagerViewProvider,
  PlatformsManagerViewProvider,
} from './webviews/viewProvider'

const TERMINAL_SETTING_KEYS = [
  'boardlab.monitor.cursorStyle',
  'boardlab.monitor.cursorInactiveStyle',
  'boardlab.monitor.cursorBlink',
  'boardlab.monitor.scrollback',
  'boardlab.monitor.fontSize',
]

const MONITOR_BRIDGE_LOG_DIR = path.join(
  os.tmpdir(),
  '.boardlab',
  'monitor-bridge'
)

interface MonitorBridgeLogFile {
  readonly name: string
  readonly path: string
  readonly mtime: number
}

async function readMonitorBridgeLogFiles(): Promise<MonitorBridgeLogFile[]> {
  try {
    const entries = await fs.readdir(MONITOR_BRIDGE_LOG_DIR, {
      withFileTypes: true,
    })
    const details = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const name = entry.name
          const filePath = path.join(MONITOR_BRIDGE_LOG_DIR, name)
          const stats = await fs.stat(filePath).catch(() => undefined)
          if (!stats) {
            return undefined
          }
          return { name, path: filePath, mtime: stats.mtimeMs }
        })
    )
    return details
      .filter((entry): entry is MonitorBridgeLogFile => Boolean(entry))
      .sort((a, b) => b.mtime - a.mtime)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return []
    }
    throw error
  }
}

async function openMonitorBridgeLogFile(
  file: MonitorBridgeLogFile,
  options?: { ensureTail?: boolean }
) {
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(file.path)
  )
  const editor = await vscode.window.showTextDocument(document, {
    preview: true,
  })
  if (options?.ensureTail && document.lineCount > 0) {
    const lastLine = Math.max(0, document.lineCount - 1)
    editor.revealRange(
      new vscode.Range(lastLine, 0, lastLine, 0),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    )
  }
}

async function tailLatestMonitorBridgeLog() {
  const files = await readMonitorBridgeLogFiles()
  if (!files.length) {
    vscode.window.showInformationMessage(
      'No monitor bridge log files are available yet.'
    )
    return
  }
  await openMonitorBridgeLogFile(files[0], { ensureTail: true })
}

async function showMonitorBridgeLogPicker() {
  const files = await readMonitorBridgeLogFiles()
  if (!files.length) {
    vscode.window.showInformationMessage(
      'No monitor bridge log files are available yet.'
    )
    return
  }
  const picks = files.map((file) => ({
    label: file.name,
    description: new Date(file.mtime).toLocaleString(),
    detail: file.path,
    file,
  }))
  const selection = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Select a monitor bridge log file',
  })
  if (selection) {
    await openMonitorBridgeLogFile(selection.file, { ensureTail: true })
  }
}

interface SketchTaskParamsInput {
  sketchPath?: string
  fqbn?: string
  port?: string
  programmer?: string
}

interface SketchTaskParamsOptions {
  needFqbn?: boolean
  needPort?: boolean
  needProgrammer?: boolean
  reuseCurrentBoard?: boolean
  reuseCurrentPort?: boolean
}

export function activate(context: vscode.ExtensionContext) {
  const start = performance.now()
  const messenger = new Messenger({ ignoreHiddenViews: false, debugLog: true })

  const outputChannel = vscode.window.createOutputChannel('BoardLab', {
    log: true,
  })
  context.subscriptions.push(outputChannel)

  const boardlabContext = createBoardLabContext(
    context,
    messenger,
    true,
    outputChannel
  )
  console.log('Central services ready', {
    boardsListWatcher: boardlabContext.boardsListWatcher.constructor.name,
    monitorsRegistry: boardlabContext.monitorsRegistry.constructor.name,
  })

  const tasks = new BoardLabTasks(boardlabContext)
  console.log('Registered tasks provider')
  const platformMissingStatusBar = new PlatformMissingStatusBar(boardlabContext)
  console.log('Registered platform status bar')
  const monitorStatusBar = new MonitorStatusBar(boardlabContext)
  console.log('Registered monitor status bar')
  const currentSketchView = new CurrentSketchView(boardlabContext)
  console.log('Registered sketches view')
  const sketchbook = new SketchbookView(context, boardlabContext.sketchbooks)
  console.log('Registered sketchbook view')
  registerSketchbookReadonlyFs(context)

  const resolveSketchForProfileCommand = async (
    arg?: unknown
  ): Promise<SketchFolderImpl | undefined> => {
    let sketchPath: string | undefined
    if (arg && typeof arg === 'object') {
      const anyArg = arg as any
      if (typeof anyArg.sketchPath === 'string') {
        sketchPath = anyArg.sketchPath
      } else if (typeof anyArg.toolArgs?.sketchPath === 'string') {
        sketchPath = anyArg.toolArgs.sketchPath
      } else if (typeof anyArg.sketch?.sketchPath === 'string') {
        sketchPath = anyArg.sketch.sketchPath
      }
    }

    let sketch = boardlabContext.currentSketch
    if (sketchPath && sketch?.sketchPath !== sketchPath) {
      const { arduino } = await boardlabContext.client
      sketch = await boardlabContext.sketchbooks.resolve(sketchPath, arduino)
    }
    if (!sketch) {
      sketch = await boardlabContext.selectSketch()
    }
    if (!(sketch instanceof SketchFolderImpl)) {
      return undefined
    }
    return sketch
  }

  const getSketchBoardSettings = (
    sketch: SketchFolderImpl
  ): string | undefined => {
    const fqbn = sketch.configOptions ?? sketch.board?.fqbn
    if (!fqbn) {
      return undefined
    }
    try {
      return new FQBN(fqbn).toString()
    } catch {
      return fqbn
    }
  }

  const promptNewProfileName = async (
    existing: string[]
  ): Promise<string | undefined> => {
    const name = await vscode.window.showInputBox({
      title: 'Create Profile',
      prompt: 'Profile name',
      validateInput: (value) => {
        const trimmed = value.trim()
        if (!trimmed) {
          return 'Profile name is required.'
        }
        if (existing.includes(trimmed)) {
          return 'Profile already exists.'
        }
        return undefined
      },
    })
    const trimmed = name?.trim()
    return trimmed || undefined
  }

  const pickProfileForSketch = async (
    sketchPath: string,
    options: { allowCreate: boolean; placeHolder: string }
  ): Promise<{ name: string; isNew: boolean } | undefined> => {
    let profiles
    try {
      profiles = await readProfiles(sketchPath, options.allowCreate)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      const message =
        err?.code === 'ENOENT'
          ? 'No sketch.yaml profile found for this sketch.'
          : error instanceof Error
            ? error.message
            : String(error)
      vscode.window.showErrorMessage(
        `Failed to read sketch profiles: ${message}`
      )
      return undefined
    }

    const profileNames = Object.keys(profiles.profiles ?? {})
    if (!options.allowCreate && profileNames.length === 0) {
      vscode.window.showInformationMessage('No profiles found for this sketch.')
      return undefined
    }

    const activeProfile =
      await boardlabContext.getValidatedActiveProfileForSketch(sketchPath)
    const items: (vscode.QuickPickItem & {
      value?: string
      isCreate?: boolean
    })[] = []

    if (options.allowCreate) {
      items.push({
        label: '$(add) Create profile...',
        isCreate: true,
      })
    }

    for (const name of profileNames) {
      items.push({
        label: name,
        description: name === activeProfile ? 'Active profile' : undefined,
        value: name,
      })
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: options.placeHolder,
    })
    if (!picked) {
      return undefined
    }

    if (picked.isCreate) {
      const name = await promptNewProfileName(profileNames)
      if (!name) {
        return undefined
      }
      return { name, isNew: true }
    }

    if (!picked.value) {
      return undefined
    }
    return { name: picked.value, isNew: false }
  }

  const applyProfileBoardSettingsToSketch = async (
    sketch: SketchFolderImpl,
    profileName: string
  ): Promise<boolean> => {
    let profile
    try {
      profile = await readProfile(sketch.sketchPath, profileName, false)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      vscode.window.showErrorMessage(
        `Failed to read profile "${profileName}": ${message}`
      )
      return false
    }

    const fqbn = profile.fqbn
    if (!fqbn) {
      vscode.window.showErrorMessage(
        `Profile "${profileName}" does not define board settings.`
      )
      return false
    }

    try {
      await boardlabContext.applyBoardSettingsFromFqbn(sketch, fqbn)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      vscode.window.showErrorMessage(
        `Failed to apply board settings from profile "${profileName}": ${message}`
      )
      return false
    }

    vscode.window.showInformationMessage(
      `Synced board settings from profile "${profileName}" to the current sketch.`
    )
    return true
  }

  context.subscriptions.push(platformMissingStatusBar, monitorStatusBar)

  context.subscriptions.push(
    vscode.tasks.onDidStartTask((event) => {
      const def = event.execution.task.definition as any
      if (!def || def.type !== 'boardlab' || typeof def.command !== 'string') {
        return
      }
      const kind = def.command as TaskKind
      const sketchPath: string | undefined = def.sketchPath
      const port: string | undefined = def.port
      markTaskRunning(kind, sketchPath, port, event.execution)
      currentSketchView.refresh()
    }),
    vscode.tasks.onDidEndTask((event) => {
      const def = event.execution.task.definition as any
      if (!def || def.type !== 'boardlab' || typeof def.command !== 'string') {
        return
      }
      const kind = def.command as TaskKind
      const sketchPath: string | undefined = def.sketchPath
      const port: string | undefined = def.port
      // We do not have exit code here; treat all ends as "succeeded" for now.
      markTaskFinished(kind, sketchPath, port, true)
      if (kind === 'compile' && sketchPath) {
        tasks.clearCompileProgress(sketchPath)
      }
      currentSketchView.refresh()
    }),
    vscode.commands.registerCommand('boardlab.extensions.searchBoardLab', () =>
      vscode.commands.executeCommand(
        'workbench.extensions.search',
        '@tag:boardlab'
      )
    ),
    vscode.commands.registerCommand('boardlab.configureCurrentSketch', () =>
      currentSketchView.revealCurrentSketch()
    ),
    vscode.commands.registerCommand(
      'boardlab.openNewSketchWizard',
      async (params: NewSketchParams = {}) => {
        await openNewSketchWizard(boardlabContext, params)
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.compile',
      async (params: { sketchPath?: string; fqbn?: string } = {}) => {
        const resolved = await resolveSketchTaskParams(
          boardlabContext,
          params,
          {
            needFqbn: true,
            reuseCurrentBoard: false,
          }
        )
        if (!resolved || !resolved.fqbn) {
          return
        }
        const { sketchPath, fqbn } = resolved
        await tasks.compile({ sketchPath, fqbn })
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.task.runFromTree',
      async (arg?: unknown) => {
        // Normalize arguments: either meta object or TreeItem with a command meta.
        let params:
          | {
              kind: TaskKind
              sketchPath: string
              port?: string
              fqbn?: string
              programmer?: string
              commandId: string
            }
          | undefined

        if (arg && typeof arg === 'object') {
          const anyArg = arg as any
          if (
            typeof anyArg.kind === 'string' &&
            typeof anyArg.commandId === 'string'
          ) {
            params = anyArg
          } else if (
            anyArg.command &&
            Array.isArray(anyArg.command.arguments) &&
            anyArg.command.arguments.length
          ) {
            const meta = anyArg.command.arguments[0]
            if (
              meta &&
              typeof meta.kind === 'string' &&
              typeof meta.commandId === 'string'
            ) {
              params = meta
            }
          }
        }

        if (!params) {
          return
        }

        const { kind, sketchPath, port, commandId, fqbn, programmer } = params
        const status = getTaskStatus(kind, sketchPath, port)
        if (status === 'running' || status === 'blocked') {
          vscode.window.showInformationMessage(
            'A task is already running for this sketch or port.'
          )
          return
        }
        await vscode.commands.executeCommand(commandId, {
          sketchPath,
          port,
          fqbn,
          programmer,
        })
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.tool.runFromTree',
      async (arg?: unknown) => {
        if (!arg || typeof arg !== 'object') {
          return
        }
        const anyArg = arg as any
        const commandId: string | undefined = anyArg.toolCommandId
        const toolArgs: unknown = anyArg.toolArgs
        if (!commandId) {
          return
        }
        await vscode.commands.executeCommand(commandId, toolArgs)
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.task.stopFromTree',
      async (arg?: unknown) => {
        let params:
          | {
              kind: TaskKind
              sketchPath: string
              port?: string
            }
          | undefined

        if (arg && typeof arg === 'object') {
          const anyArg = arg as any
          if (
            typeof anyArg.kind === 'string' &&
            typeof anyArg.sketchPath === 'string'
          ) {
            params = anyArg
          } else if (
            anyArg.command &&
            Array.isArray(anyArg.command.arguments) &&
            anyArg.command.arguments.length
          ) {
            const meta = anyArg.command.arguments[0]
            if (
              meta &&
              typeof meta.kind === 'string' &&
              typeof meta.sketchPath === 'string'
            ) {
              params = meta
            }
          }
        }

        if (!params) {
          return
        }
        const { kind, sketchPath, port } = params
        const status = getTaskStatus(kind, sketchPath, port)
        if (status !== 'running') {
          return
        }
        await tryStopTask(kind, sketchPath, port)
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.upload',
      async (
        params: { sketchPath?: string; fqbn?: string; port?: string } = {}
      ) => {
        const resolved = await resolveSketchTaskParams(
          boardlabContext,
          params,
          {
            needFqbn: true,
            needPort: true,
          }
        )
        if (!resolved || !resolved.fqbn || !resolved.port) {
          return
        }
        const { sketchPath, fqbn, port } = resolved
        await tasks.upload({ sketchPath, fqbn, port })
      }
    ),
    vscode.commands.registerCommand('boardlab.openMonitor', async () => {
      await vscode.commands.executeCommand('boardlab.monitor.focus')
    }),
    vscode.commands.registerCommand(
      'boardlab.exportBinary',
      async (params: { sketchPath?: string; fqbn?: string } = {}) => {
        const resolved = await resolveSketchTaskParams(
          boardlabContext,
          params,
          {
            needFqbn: true,
          }
        )
        if (!resolved || !resolved.fqbn) {
          return
        }
        const { sketchPath, fqbn } = resolved
        await tasks.exportBinary({ sketchPath, fqbn })
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.uploadUsingProgrammer',
      async (
        params: {
          sketchPath?: string
          fqbn?: string
          port?: string
          programmer?: string
        } = {}
      ) => {
        const resolved = await resolveSketchTaskParams(
          boardlabContext,
          params,
          {
            needFqbn: true,
            needPort: true,
            needProgrammer: true,
          }
        )
        if (
          !resolved ||
          !resolved.fqbn ||
          !resolved.port ||
          !resolved.programmer
        ) {
          return
        }
        await tasks.uploadUsingProgrammer({
          sketchPath: resolved.sketchPath,
          fqbn: resolved.fqbn,
          port: resolved.port,
          programmer: resolved.programmer,
        })
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.burnBootloader',
      async (
        params: {
          sketchPath?: string
          fqbn?: string
          port?: string
          programmer?: string
        } = {}
      ) => {
        const resolved = await resolveSketchTaskParams(
          boardlabContext,
          params,
          {
            needFqbn: true,
            needPort: true,
            needProgrammer: true,
          }
        )
        if (
          !resolved ||
          !resolved.fqbn ||
          !resolved.port ||
          !resolved.programmer
        ) {
          return
        }
        const { sketchPath, fqbn, port, programmer } = resolved
        await tasks.burnBootloader({
          sketchPath,
          fqbn,
          port,
          programmer,
        })
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.getBoardInfo',
      async (params: { sketchPath?: string; port?: string } = {}) => {
        const resolved = await resolveSketchTaskParams(
          boardlabContext,
          params,
          {
            needPort: true,
          }
        )
        if (!resolved || !resolved.port) {
          return
        }
        const { sketchPath, port } = resolved
        await tasks.getBoardInfo({ sketchPath, port })
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.archiveSketch',
      async (params: { sketchPath?: string } = {}) => {
        const resolved = await resolveSketchTaskParams(
          boardlabContext,
          params,
          {}
        )
        if (!resolved) {
          return
        }
        const sketchPath = resolved.sketchPath
        const sketchName = path.basename(sketchPath)

        // Build default archive name: <sketchName>-<yymmdd>a.zip
        const now = new Date()
        const yy = String(now.getFullYear()).slice(-2)
        const mm = String(now.getMonth() + 1).padStart(2, '0')
        const dd = String(now.getDate()).padStart(2, '0')
        const archiveName = `${sketchName}-${yy}${mm}${dd}a.zip`

        // Prefer the Arduino CLI user data directory as default location.
        const userDirPath =
          boardlabContext.cliContext.cliConfig.data?.userDirPath ?? sketchPath
        const defaultUri = vscode.Uri.file(path.join(userDirPath, archiveName))

        const saveUri = await vscode.window.showSaveDialog({
          title: 'Archive Sketch',
          defaultUri,
          filters: { 'Zip Archive': ['zip'] },
        })
        if (!saveUri) {
          return
        }
        await tasks.archiveSketch({
          sketchPath,
          archivePath: saveUri.fsPath,
          overwrite: true,
        })
      }
    ),
    messenger.onRequest(
      requestShowWebviewMessage,
      async ({ level, message }) => {
        if (!message) {
          return
        }
        try {
          if (level === 'error') {
            await vscode.window.showErrorMessage(message)
          } else if (level === 'warning') {
            await vscode.window.showWarningMessage(message)
          } else {
            await vscode.window.showInformationMessage(message)
          }
        } catch (error) {
          console.error('Failed to show webview message', {
            level,
            message,
            error,
          })
        }
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.cloneSketch',
      async (input?: SketchResource | CloneSketchArgs) => {
        await cloneSketch(boardlabContext, input)
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.openSketch',
      async (input?: SketchResource | AddSketchFolderArgs) => {
        await openSketch(boardlabContext, input)
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.openSketchInNewWindow',
      async (input?: SketchResource | AddSketchFolderArgs) => {
        await openSketchInNewWindow(boardlabContext, input)
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.openTextEditor',
      async (arg?: string | vscode.Uri) => {
        let uriString: string | undefined
        if (typeof arg === 'string') {
          uriString = arg
        } else if (arg instanceof vscode.Uri) {
          uriString = arg.toString()
        }
        await profilesEditor.openRaw(uriString)
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.setActive',
      async (params: VscodeDataContextParams) => {
        const [profileName, uriString] = params.args ?? []
        if (!uriString) return

        await profilesEditor.setActiveProfileByCommand({
          uri: uriString,
          name: profileName,
        })
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.openSketchProfile',
      async (params?: { sketchPath?: string }) => {
        let sketchPath = params?.sketchPath
        if (!sketchPath) {
          const sketch =
            boardlabContext.currentSketch ??
            (await boardlabContext.selectSketch())
          sketchPath = sketch?.sketchPath
        }
        if (!sketchPath) {
          return
        }
        const uri = vscode.Uri.file(path.join(sketchPath, 'sketch.yaml'))
        try {
          await vscode.workspace.fs.stat(uri)
        } catch {
          vscode.window.showErrorMessage(
            `No sketch.yaml profile found for sketch at ${sketchPath}.`
          )
          return
        }
        await vscode.commands.executeCommand(
          'vscode.openWith',
          uri,
          'boardlab.profilesEditor'
        )
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.createSketchProfile',
      async (params?: { sketchPath?: string }) => {
        let sketchPath = params?.sketchPath
        let currentSketch = boardlabContext.currentSketch
        if (!sketchPath) {
          const sketch = currentSketch ?? (await boardlabContext.selectSketch())
          sketchPath = sketch?.sketchPath
          currentSketch = sketch ?? undefined
        }
        if (!sketchPath) {
          return
        }
        const uri = vscode.Uri.file(path.join(sketchPath, 'sketch.yaml'))
        try {
          await vscode.workspace.fs.stat(uri)
          vscode.window.showErrorMessage(
            `A sketch.yaml profile already exists for sketch at ${sketchPath}.`
          )
          return
        } catch {
          // OK, file does not exist
        }
        try {
          // Initialize sketch.yaml from current sketch state if available
          const sketch = currentSketch
          let content = ''
          if (
            sketch &&
            sketch.sketchPath === sketchPath &&
            (sketch.configOptions || sketch.board?.fqbn)
          ) {
            const fqbn = sketch.configOptions || sketch.board?.fqbn
            const selectedProgrammer = sketch.selectedProgrammer
            const programmerId =
              typeof selectedProgrammer === 'string'
                ? selectedProgrammer
                : (selectedProgrammer?.id ?? selectedProgrammer?.name)
            const profileName = 'Untitled 1'
            const parsedFQBN =
              fqbn && isValidFQBN(fqbn) ? new FQBN(fqbn) : undefined
            const platformId = parsedFQBN
              ? `${parsedFQBN.vendor}:${parsedFQBN.arch}`
              : undefined

            const profile: any = {}
            if (fqbn) profile.fqbn = fqbn
            if (programmerId) profile.programmer = programmerId
            if (platformId) {
              profile.platforms = [{ platform: platformId }]
            }

            // Serialize to YAML manually to avoid new deps here
            const lines: string[] = []
            lines.push('profiles:')
            lines.push(`  ${JSON.stringify(profileName)}:`)
            if (profile.fqbn) {
              lines.push(`    fqbn: ${JSON.stringify(profile.fqbn)}`)
            }
            if (profile.programmer) {
              lines.push(
                `    programmer: ${JSON.stringify(profile.programmer)}`
              )
            }
            if (profile.platforms && profile.platforms.length) {
              lines.push('    platforms:')
              for (const entry of profile.platforms) {
                lines.push(
                  `      - platform: ${JSON.stringify(entry.platform)}`
                )
              }
            }
            content = lines.join('\n') + '\n'
          }

          // Always create an empty file first so that the backing TextDocument
          // exists, then apply the initial profile via a workspace edit. This
          // keeps the change in VS Code's undo/redo stack.
          await vscode.workspace.fs.writeFile(uri, new Uint8Array())
          if (content && content.trim().length) {
            const document = await vscode.workspace.openTextDocument(uri)
            const edit = new vscode.WorkspaceEdit()
            const fullRange = new vscode.Range(
              document.positionAt(0),
              document.positionAt(document.getText().length)
            )
            edit.replace(document.uri, fullRange, content)
            await vscode.workspace.applyEdit(edit)
          }
          await vscode.commands.executeCommand(
            'vscode.openWith',
            uri,
            'boardlab.profilesEditor'
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          vscode.window.showErrorMessage(
            `Failed to create sketch.yaml for sketch at ${sketchPath}: ${message}`
          )
        }
        // Ensure Current Sketch view refreshes profile task label
        currentSketchView.refresh()
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.syncSketchBoardSettingsToProfile',
      async (arg?: unknown) => {
        const sketch = await resolveSketchForProfileCommand(arg)
        if (!sketch) {
          return
        }

        const boardSettings = getSketchBoardSettings(sketch)
        if (!boardSettings) {
          vscode.window.showErrorMessage(
            'The current sketch does not define board settings to sync.'
          )
          return
        }

        const pick = await pickProfileForSketch(sketch.sketchPath, {
          allowCreate: true,
          placeHolder:
            'Select a profile to overwrite with the current sketch board settings',
        })
        if (!pick) {
          return
        }

        try {
          await updateProfile(sketch.sketchPath, pick.name, {
            fqbn: boardSettings,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          vscode.window.showErrorMessage(
            `Failed to sync board settings to profile "${pick.name}": ${message}`
          )
          return
        }

        vscode.window.showInformationMessage(
          `Synced board settings from sketch to profile "${pick.name}".`
        )
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.syncSketchBoardSettingsToActiveProfile',
      async (arg?: unknown) => {
        const sketch = await resolveSketchForProfileCommand(arg)
        if (!sketch) {
          return
        }

        const activeProfile =
          await boardlabContext.getValidatedActiveProfileForSketch(
            sketch.sketchPath
          )
        if (!activeProfile) {
          vscode.window.showInformationMessage(
            'No active profile set for this sketch.'
          )
          return
        }

        const boardSettings = getSketchBoardSettings(sketch)
        if (!boardSettings) {
          vscode.window.showErrorMessage(
            'The current sketch does not define board settings to sync.'
          )
          return
        }

        try {
          await updateProfile(sketch.sketchPath, activeProfile, {
            fqbn: boardSettings,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          vscode.window.showErrorMessage(
            `Failed to sync board settings to profile "${activeProfile}": ${message}`
          )
          return
        }

        vscode.window.showInformationMessage(
          `Synced board settings from sketch to profile "${activeProfile}".`
        )
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.syncProfileBoardSettingsToSketch',
      async (arg?: unknown) => {
        const sketch = await resolveSketchForProfileCommand(arg)
        if (!sketch) {
          return
        }

        const pick = await pickProfileForSketch(sketch.sketchPath, {
          allowCreate: false,
          placeHolder:
            'Select a profile to load board settings into the current sketch',
        })
        if (!pick) {
          return
        }

        await applyProfileBoardSettingsToSketch(sketch, pick.name)
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.syncActiveProfileBoardSettingsToSketch',
      async (arg?: unknown) => {
        const sketch = await resolveSketchForProfileCommand(arg)
        if (!sketch) {
          return
        }

        const activeProfile =
          await boardlabContext.getValidatedActiveProfileForSketch(
            sketch.sketchPath
          )
        if (!activeProfile) {
          vscode.window.showInformationMessage(
            'No active profile set for this sketch.'
          )
          return
        }

        await applyProfileBoardSettingsToSketch(sketch, activeProfile)
      }
    ),
    messenger.onRequest(requestConfigureLineEnding, async ({ kind }) => {
      await configureLineEnding(kind)
    })
  )

  const { cliContext } = boardlabContext
  context.subscriptions.push(
    tasks,
    currentSketchView,
    sketchbook,
    vscode.commands.registerCommand(
      'boardlab.openArduinoCliConfig',
      async () => {
        await cliContext.cliConfig.ready()
        await cliContext.cliConfig.refresh({ allowPrompt: true })
        const uri = cliContext.cliConfig.uri
        if (!uri) {
          vscode.window.showWarningMessage(
            'Arduino CLI configuration path could not be resolved.'
          )
          return
        }
        try {
          const doc = await vscode.workspace.openTextDocument(uri)
          await vscode.window.showTextDocument(doc, { preview: false })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          vscode.window.showErrorMessage(
            `Failed to open Arduino CLI configuration: ${message}`
          )
        }
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.addAdditionalPackageIndexUrlToArduinoCliConfig',
      async (params?: Partial<AddAdditionalPackageIndexUrlParams>) => {
        let url = params?.url
        if (!url) {
          url = await vscode.window.showInputBox({
            title:
              'Platform package index URL to add to the Arduino CLI configuration',
            prompt:
              'Enter an additional platform package index URL (http/https/file).',
            placeHolder: 'https://example.com/package_index.json',
            validateInput: (value) => {
              const trimmed = value.trim()
              if (!trimmed) return 'URL is required'
              try {
                const url = new URL(trimmed)
                if (
                  url.protocol !== 'http:' &&
                  url.protocol !== 'https:' &&
                  url.protocol !== 'file:'
                ) {
                  return 'Only http/https/file URLs are supported'
                }
                return null
              } catch {
                return 'Invalid URL'
              }
            },
          })
        }
        if (!url) {
          return false
        }

        const added = await cliContext.cliConfig.addAdditionalPackageIndexUrl({
          ...params,
          url,
        })
        if (!added) {
          vscode.window.showInformationMessage(
            'The additional package index URL was already in the Arduino CLI config'
          )
        }
      }
    )
  )
  console.log('Took ' + (performance.now() - start))

  const librariesViewProvider = new LibrariesManagerViewProvider(
    context.extensionUri,
    context.extensionMode,
    messenger
  )
  const platformsViewProvider = new PlatformsManagerViewProvider(
    context.extensionUri,
    context.extensionMode,
    messenger
  )
  const examplesViewProvider = new ExamplesViewProvider(
    context.extensionUri,
    context.extensionMode,
    messenger
  )

  const examplesIndex = new ExamplesIndex(boardlabContext)
  const examplesFs = new BoardLabExampleFs(examplesIndex)

  context.subscriptions.push(
    examplesIndex,
    vscode.workspace.registerFileSystemProvider(EXAMPLE_SCHEME, examplesFs, {
      isReadonly: true,
    })
  )

  context.subscriptions.push(registerExampleReadmeFs(context))
  registerExampleCommands(context, (id) => examplesIndex.get(id))
  registerExampleReadmeActions(context, (id) => examplesIndex.get(id))

  context.subscriptions.push(
    messenger.onRequest(listExamplesRequest, async ({ fqbn }) => {
      await examplesIndex.ready()
      const metas = examplesIndex
        .list()
        .filter((meta) =>
          fqbn && meta.fqbnFilters && meta.fqbnFilters.length
            ? meta.fqbnFilters.includes(fqbn)
            : true
        )
      const examples = await Promise.all(
        metas.map(async (meta) => ({
          id: meta.id,
          label: meta.label,
          source: meta.source,
          nodes: await examplesIndex.resolveTree(meta),
        }))
      )
      console.log('Listed examples', { count: (await examples).length, fqbn })
      return examples
    }),
    messenger.onRequest(getExampleTreeRequest, async ({ exampleId }) => {
      await examplesIndex.ready()
      const meta = examplesIndex.get(exampleId)
      if (!meta) {
        return []
      }
      return examplesIndex.resolveTree(meta)
    }),
    messenger.onRequest(openExampleReadmeRequest, async ({ exampleId }) => {
      await examplesIndex.ready()
      const meta = examplesIndex.get(exampleId)
      if (!meta) {
        return false
      }
      await showLibraryReadme(meta.label, meta.rootPath)
      return true
    }),
    messenger.onRequest(
      openExampleSketchRequest,
      async ({ exampleId, sketchRelPath }) => {
        await examplesIndex.ready()

        // TODO: this does not belong here
        if (exampleId.startsWith('builtin:')) {
          const meta = examplesIndex.get(exampleId)
          if (!meta) {
            return false
          }
          const sketchFolderPath = path.join(meta.rootPath, sketchRelPath)
          return showBuiltinSketchReadmeFromFolderStrict(
            vscode.Uri.file(sketchFolderPath),
            {
              tag: '1.10.2',
              source: meta.source,
              exampleId,
              exampleRelPath: sketchRelPath,
              // Does not show GH sources in the markdown
              // examplesRoot: vscode.Uri.file(meta.rootPath),
            }
          )
        }
        return openExampleSketch(exampleId, sketchRelPath, examplesIndex)
      }
    ),
    messenger.onRequest(
      openExampleResourceRequest,
      async ({ exampleId, resourceRelPath }) => {
        await examplesIndex.ready()
        try {
          const uri = buildExampleUri(exampleId, resourceRelPath)
          await vscode.commands.executeCommand('vscode.open', uri, {
            preview: true,
          })
          return true
        } catch (error) {
          vscode.window.showWarningMessage(
            `Failed to open example resource: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
          return false
        }
      }
    ),
    boardlabContext.platformsManager,
    vscode.window.registerWebviewViewProvider(
      'boardlab.platformsManager',
      platformsViewProvider
    ),
    boardlabContext.librariesManager,
    vscode.window.registerWebviewViewProvider(
      'boardlab.librariesManager',
      librariesViewProvider
    ),
    vscode.window.registerWebviewViewProvider(
      'boardlab.examples',
      examplesViewProvider
    ),
    vscode.commands.registerCommand('boardlab.examples.refresh', async () => {
      try {
        await examplesIndex.refresh()
      } catch (refreshError) {
        console.error('Failed to refresh examples index', refreshError)
      }
      await examplesViewProvider.sendToolbarAction('refresh')
    })
  )

  const computeSelection = (): MonitorSelectionNotification => {
    const selection: Mutable<MonitorSelectionNotification> = {}

    const sketchWithPort = boardlabContext.currentSketch?.port
      ? boardlabContext.currentSketch
      : boardlabContext.sketchbooks.resolvedSketchFolders.find(
          (sketch) => sketch.port
        )

    const sketchPort = sketchWithPort?.port as PortIdentifier | undefined
    const protocol = sketchPort?.protocol
    const address = sketchPort?.address
    if (protocol && address) {
      const portIdentifier = { protocol, address }
      selection.port = portIdentifier
      try {
        const monitorState = boardlabContext.monitorsRegistry.get(
          createPortKey(portIdentifier)
        )
        if (monitorState?.lastKnownBaud !== undefined) {
          selection.baudrate = String(monitorState.lastKnownBaud)
        }
      } catch (error) {
        console.error('Failed to resolve monitor state for port', error)
      }
    }
    return selection
  }

  const monitorResourceStore = new MonitorResourceStore(
    boardlabContext.monitorManager
  )
  const monitorFsProvider = new MonitorFileSystemProvider()
  context.subscriptions.push(
    monitorFsProvider,
    vscode.workspace.registerFileSystemProvider(
      MONITOR_URI_SCHEME,
      monitorFsProvider,
      {
        isReadonly: true,
        isCaseSensitive: true,
      }
    )
  )
  const monitorSelectionCoordinator = new MonitorSelectionCoordinator(
    messenger,
    () => computeSelection()
  )
  const monitorEditors = new MonitorEditors(
    context.extensionUri,
    context.extensionMode,
    messenger,
    monitorResourceStore,
    monitorSelectionCoordinator
  )
  const plotterEditors = new PlotterEditors(
    context.extensionUri,
    context.extensionMode,
    messenger,
    monitorResourceStore,
    monitorSelectionCoordinator
  )
  const profilesDiagnostics =
    vscode.languages.createDiagnosticCollection('boardlabProfiles')
  context.subscriptions.push(profilesDiagnostics)
  const profilesEditor = new ProfilesEditorProvider(
    context.extensionUri,
    context.extensionMode,
    messenger,
    boardlabContext,
    profilesDiagnostics
  )

  const selectionSignature = (
    selection: MonitorSelectionNotification
  ): string => {
    const portKey = selection.port ? createPortKey(selection.port) : ''
    const baudrate = selection.baudrate ?? ''
    return `${portKey}|${baudrate}`
  }

  let lastSelectionSignature: string | undefined

  const selectionRequestDisposable = messenger.onRequest(
    getMonitorSelection,
    (_params, sender) =>
      monitorSelectionCoordinator.resolveFor(sender) ?? computeSelection()
  )

  boardlabContext.monitorManager.setSelectionResolver(
    (sender) =>
      monitorSelectionCoordinator.resolveFor(sender) ?? computeSelection()
  )

  const pushSelection = async (): Promise<void> => {
    const selection = computeSelection()
    const signature = selectionSignature(selection)
    if (signature === lastSelectionSignature) {
      return
    }
    lastSelectionSignature = signature
    try {
      await monitorSelectionCoordinator.pushAll()
    } catch (error) {
      console.error('Failed to push monitor selection', error)
    }
  }

  const sketchChangeDisposable = boardlabContext.onDidChangeSketch((event) => {
    if (!event.changedProperties || event.changedProperties.includes('port')) {
      pushSelection()
    }
  })

  const currentSketchDisposable = boardlabContext.onDidChangeCurrentSketch(
    () => {
      pushSelection()
    }
  )

  const monitorsRegistryDisposable =
    boardlabContext.monitorsRegistry.onDidChange(() => {
      lastSelectionSignature = undefined
      pushSelection()
    })

  const resolvedSketchesDisposable =
    boardlabContext.sketchbooks.onDidChangeResolvedSketches(() => {
      lastSelectionSignature = undefined
      pushSelection()
    })

  const refreshProfilesDiagnostics = () => {
    // Refresh diagnostics for plain-text sketch.yaml editors
    for (const doc of vscode.workspace.textDocuments) {
      const fsPath = doc.uri.fsPath || doc.fileName
      if (!fsPath || !/(^|\/)sketch\.yaml$/i.test(fsPath)) continue
      // If a custom profiles editor is open for this URI, let it manage diagnostics
      if (profilesEditor.isOpenForUri(doc.uri)) continue
      const text = doc.getText()
      const baseDiagnostics = validateProfilesYAML(text, doc)
      profilesDiagnostics.set(doc.uri, baseDiagnostics)
      collectCliDiagnostics(boardlabContext, doc, text)
        .then((cliDiags: vscode.Diagnostic[]) => {
          if (!cliDiags) return
          profilesDiagnostics.set(doc.uri, [...baseDiagnostics, ...cliDiags])
        })
        .catch((err: unknown) => console.log(err))
    }
    // Refresh diagnostics for any open custom profiles editors
    profilesEditor
      .refreshDiagnosticsForOpenDocuments()
      .catch((err) =>
        console.warn('Failed to refresh profiles diagnostics for webviews', err)
      )
  }

  context.subscriptions.push(
    sketchChangeDisposable,
    currentSketchDisposable,
    monitorsRegistryDisposable,
    resolvedSketchesDisposable,
    selectionRequestDisposable
  )

  context.subscriptions.push(
    monitorResourceStore,
    monitorSelectionCoordinator,
    monitorEditors,
    plotterEditors,
    profilesEditor,
    // Validate sketch.yaml in the plain text editor too
    registerProfilesYamlValidation(
      context,
      profilesEditor,
      profilesDiagnostics,
      boardlabContext
    ),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file', pattern: '**/sketch.yaml' },
      new ProfilesCodeActionProvider(
        boardlabContext.librariesManager,
        boardlabContext.platformsManager
      ),
      {
        providedCodeActionKinds:
          ProfilesCodeActionProvider.providedCodeActionKinds,
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.selectPlatformVersionForProfile',
      async (arg: { uri: string; range: vscode.Range; platform: string }) => {
        const uri = vscode.Uri.parse(arg.uri)
        const quickInfo =
          await boardlabContext.platformsManager.lookupPlatformQuick(
            arg.platform
          )
        const available = quickInfo?.availableVersions ?? []
        const installed = quickInfo?.installedVersion
        if (!available.length) {
          vscode.window.showWarningMessage(
            `No available versions found for platform '${arg.platform}'.`
          )
          return
        }
        const items = available.map((v) => ({
          label: v,
          description: v === installed ? 'Installed' : undefined,
        }))
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: `Select version for platform '${arg.platform}'`,
        })
        if (!picked) return
        const version = picked.label
        const newValue = `${arg.platform} (${version})`
        const edit = new vscode.WorkspaceEdit()
        edit.replace(uri, arg.range, newValue)
        await vscode.workspace.applyEdit(edit)
      }
    ),
    boardlabContext.monitorManager,
    vscode.window.registerCustomEditorProvider(
      'boardlab.monitorEditor',
      monitorEditors,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    ),
    // Refresh profiles diagnostics when platforms/libraries change or indexes update
    boardlabContext.platformsManager.onDidUpdate(() =>
      refreshProfilesDiagnostics()
    ),
    boardlabContext.librariesManager.onDidUpdate(() =>
      refreshProfilesDiagnostics()
    ),
    vscode.window.registerCustomEditorProvider(
      'boardlab.plotterEditor',
      plotterEditors,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }
    ),
    vscode.window.registerCustomEditorProvider(
      'boardlab.profilesEditor',
      profilesEditor,
      {
        webviewOptions: { retainContextWhenHidden: true },
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.installPlatform',
      async (params?: { id: string; version?: string }) => {
        const id: string | undefined = params?.id
        const requestedVersion: string | undefined = params?.version
        if (!id) return

        try {
          let version = requestedVersion
          if (!version) {
            version = (
              await boardlabContext.platformsManager.lookupPlatformQuick(id)
            )?.availableVersions[0]
          }

          if (!version) {
            vscode.window.showWarningMessage(
              `Unable to resolve versions for platform '${id}'.`
            )
            return
          }

          await boardlabContext.platformsManager.install({
            id,
            name: id,
            version,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          vscode.window.showErrorMessage(
            `Failed to install platform '${id}': ${message}`
          )
        }
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.installLibrary',
      async (params?: { id: string; version?: string }) => {
        const id: string | undefined = params?.id
        const requestedVersion: string | undefined = params?.version
        if (!id) return

        try {
          let version = requestedVersion
          if (!version) {
            version = (
              await boardlabContext.librariesManager.lookupLibraryQuick(id)
            )?.availableVersions[0]
          }

          if (!version) {
            vscode.window.showWarningMessage(
              `Unable to resolve versions for library '${id}'.`
            )
            return
          }

          await boardlabContext.librariesManager.install({
            id,
            name: id,
            version,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          vscode.window.showErrorMessage(
            `Failed to install library '${id}': ${message}`
          )
        }
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.selectLibraryVersionForProfile',
      async (arg: { uri: string; range: vscode.Range; library: string }) => {
        const uri = vscode.Uri.parse(arg.uri)
        const quickInfo =
          await boardlabContext.librariesManager.lookupLibraryQuick(arg.library)
        const available = quickInfo?.availableVersions ?? []
        const installed = quickInfo?.installedVersion
        if (!available.length) {
          vscode.window.showWarningMessage(
            `No available versions found for library '${arg.library}'.`
          )
          return
        }
        const items = available.map((v) => ({
          label: v,
          description: v === installed ? 'Installed' : undefined,
        }))
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: `Select version for library '${arg.library}'`,
        })
        if (!picked) return
        const version = picked.label
        const newValue = `${arg.library} (${version})`
        const edit = new vscode.WorkspaceEdit()
        edit.replace(uri, arg.range, newValue)
        await vscode.workspace.applyEdit(edit)
      }
    ),
    // Profiles editor: commands invoked from webview context menus
    vscode.commands.registerCommand(
      'boardlab.profiles.setDefault',
      async (params: VscodeDataContextParams) => {
        const [profileName, uriString] = params.args ?? []
        if (!profileName || !uriString) return
        await profilesEditor.selectProfileByCommand({
          uri: uriString,
          name: profileName,
        })
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.profiles.delete',
      async (params: VscodeDataContextParams) => {
        const [profileName, uriString] = params.args ?? []
        if (!profileName || !uriString) return
        await profilesEditor.deleteProfileByCommand({
          uri: uriString,
          name: profileName,
        })
      }
    ),
    vscode.commands.registerCommand('boardlab.monitor.focus', async () => {
      await openMonitorResource('boardlab.monitorEditor')
    }),
    vscode.commands.registerCommand('boardlab.plotter.focus', async () => {
      await openMonitorResource('boardlab.plotterEditor')
    }),
    vscode.commands.registerCommand('boardlab.monitor.copyAll', async () => {
      const active = monitorEditors.getActiveDocument()
      if (!active) {
        vscode.window.showInformationMessage(
          'Open a monitor editor to copy output.'
        )
        return
      }
      const snapshot = await monitorEditors.requestEditorContent(active)
      if (!snapshot) {
        if (!snapshot) {
          vscode.window.showErrorMessage(
            'Failed to read monitor output from the editor.'
          )
          return
        }
      }
      await vscode.env.clipboard.writeText(snapshot.text)
    }),
    vscode.commands.registerCommand('boardlab.monitor.saveToFile', async () => {
      const active = monitorEditors.getActiveDocument()
      if (!active) {
        vscode.window.showInformationMessage(
          'Open a monitor editor to capture an output snapshot.'
        )
        return
      }
      await openMonitorOutput(active)
    }),
    vscode.commands.registerCommand('boardlab.monitor.clear', async () => {
      const active = monitorEditors.getActiveDocument()
      if (!active) {
        vscode.window.showInformationMessage(
          'Open a monitor editor to clear output.'
        )
        return
      }
      await monitorEditors.sendToolbarAction('clear', active)
    }),
    vscode.commands.registerCommand(
      'boardlab.monitorBridge.listLogs',
      async () => {
        try {
          await showMonitorBridgeLogPicker()
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : String(error ?? 'Unknown error')
          vscode.window.showErrorMessage(
            `Failed to list monitor bridge log files: ${message}`
          )
        }
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.monitorBridge.tailLatestLog',
      async () => {
        try {
          await tailLatestMonitorBridgeLog()
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : String(error ?? 'Unknown error')
          vscode.window.showErrorMessage(
            `Failed to open monitor bridge log: ${message}`
          )
        }
      }
    ),
    vscode.commands.registerCommand('boardlab.plotter.clear', async () => {
      const active = plotterEditors.getActiveDocument()
      if (!active) {
        vscode.window.showInformationMessage(
          'Open a plotter editor to clear the plot.'
        )
        return
      }
      await plotterEditors.sendToolbarAction('clear', active)
    }),
    vscode.commands.registerCommand(
      'boardlab.plotter.resetYScale',
      async () => {
        const active = plotterEditors.getActiveDocument()
        if (!active) {
          vscode.window.showInformationMessage(
            'Open a plotter editor to reset the Y scale.'
          )
          return
        }
        await plotterEditors.sendToolbarAction('resetYScale', active)
      }
    ),
    vscode.commands.registerCommand(
      'boardlab.monitor.developer.logBridgeMetrics',
      () => logMonitorBridgeMetrics(boardlabContext)
    ),
    vscode.commands.registerCommand(
      'boardlab.monitor.developer.logDetectedPorts',
      () => logDetectedPorts(boardlabContext)
    ),
    vscode.commands.registerCommand(
      'boardlab.monitor.configureLineEnding',
      () => configureLineEnding('monitor')
    ),
    vscode.commands.registerCommand(
      'boardlab.monitor.configureBaudrate',
      configureMonitorBaudrate
    ),
    vscode.commands.registerCommand(
      'boardlab.plotter.configureLineEnding',
      () => configureLineEnding('plotter')
    )
  )

  pushSelection()

  async function openMonitorResource(
    viewType: 'boardlab.monitorEditor' | 'boardlab.plotterEditor'
  ): Promise<void> {
    const targetLabel = viewType.includes('plotter')
      ? 'serial plotter'
      : 'serial monitor'
    console.log('[boardlab] openMonitorResource', {
      viewType,
      targetLabel,
    })
    let selection = computeSelection()
    if (!selection.port) {
      await vscode.commands.executeCommand('boardlab.selectPort')
      selection = computeSelection()
      if (!selection.port) {
        vscode.window.showInformationMessage(
          `Select a port to open the ${targetLabel}.`
        )
        return
      }
    }

    const query = new Map<string, string>()
    if (selection.baudrate) {
      query.set('baud', selection.baudrate)
    }
    const uri = formatMonitorUri({ port: selection.port, query })
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType, {
        preview: false,
        viewColumn: vscode.ViewColumn.Active,
      })
      console.log('[boardlab] openWith success', {
        viewType,
        uri: uri.toString(),
      })
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open the ${targetLabel}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  async function openMonitorOutput(
    document: ReturnType<typeof monitorEditors.getActiveDocument>
  ): Promise<void> {
    if (!document) {
      return
    }
    const snapshot = await monitorEditors.requestEditorContent(document)
    if (!snapshot) {
      vscode.window.showErrorMessage(
        'Failed to read monitor output from the editor.'
      )
      return
    }
    const port = document.port
    const trimmedText = trimBlankLines(snapshot.text ?? '')
    const headerLines = [
      'BoardLab Monitor Output',
      `Port: ${port.protocol} ${port.address}`,
    ]
    if (document.baudrate) {
      headerLines.push(`Baudrate: ${document.baudrate}`)
    }
    headerLines.push(`Captured: ${new Date().toISOString()}`)
    const content = `${headerLines.join('\n')}\n\n${trimmedText}`
    const outputDoc = await vscode.workspace.openTextDocument({
      language: 'plaintext',
      content,
    })
    await vscode.window.showTextDocument(outputDoc, { preview: false })
  }

  function trimBlankLines(text: string): string {
    const lines = text.split(/\r?\n/)
    let start = 0
    while (start < lines.length && lines[start].trim() === '') {
      start += 1
    }
    let end = lines.length - 1
    while (end >= start && lines[end].trim() === '') {
      end -= 1
    }
    return lines.slice(start, end + 1).join('\n')
  }

  // --- Libraries filter menu & context wiring ---
  type LibrariesFilterState = {
    type: LibraryFilterType | ''
    topic: LibraryFilterTopic | ''
  }
  const LIBRARIES_FILTER_STORAGE_KEY = 'boardlab.libraries.filter'
  const storedLibrariesFilter = context.globalState.get<LibrariesFilterState>(
    LIBRARIES_FILTER_STORAGE_KEY,
    { type: '', topic: '' }
  ) ?? { type: '', topic: '' }
  const librariesFilter: LibrariesFilterState = {
    type: storedLibrariesFilter.type ?? '',
    topic: storedLibrariesFilter.topic ?? '',
  }

  const setLibrariesFilterContext = async (state: LibrariesFilterState) => {
    librariesFilter.type = state.type ?? ''
    librariesFilter.topic = state.topic ?? ''
    await context.globalState.update(LIBRARIES_FILTER_STORAGE_KEY, {
      type: librariesFilter.type,
      topic: librariesFilter.topic,
    })
    const isActive =
      Boolean(librariesFilter.type) || Boolean(librariesFilter.topic)
    await vscode.commands.executeCommand(
      'setContext',
      'boardlab.librariesFilter:type',
      librariesFilter.type || undefined
    )
    await vscode.commands.executeCommand(
      'setContext',
      'boardlab.librariesFilter:topic',
      librariesFilter.topic || undefined
    )
    await vscode.commands.executeCommand(
      'setContext',
      'boardlab.librariesFilter:isActive',
      isActive
    )
  }

  const pushLibrariesFilter = () => {
    try {
      messenger.sendNotification(
        notifyLibrariesFilterChanged,
        { type: 'webview', webviewType: 'boardlab.librariesManager' },
        { type: librariesFilter.type, topic: librariesFilter.topic }
      )
    } catch (error) {
      console.error('Failed to push libraries filter', error)
    }
  }

  // Keep VS Code context keys in sync when the webview clears/changes filters
  context.subscriptions.push(
    messenger.onRequest(setLibrariesFilterContextReq, async (params) => {
      await setLibrariesFilterContext({
        type: params.type ?? '',
        topic: params.topic ?? '',
      })
    })
  )

  // Register commands for each filter value (Type/Topic)
  const withoutAll = (values: readonly string[]) =>
    values.filter((v) => v !== 'All')
  const typeValues = withoutAll(
    LibraryFilterTypeLiterals as unknown as string[]
  )
  const topicValues = withoutAll(
    LibraryFilterTopicLiterals as unknown as string[]
  )

  const toCommandId = (prefix: string, value: string, checked = false) =>
    `${prefix}.${value.replace(/[^A-Za-z0-9]/g, '')}${checked ? '.checked' : ''}`

  const registerFilterCommand = (
    kind: 'type' | 'topic',
    value: any
  ): vscode.Disposable[] => {
    const prefix = `boardlab.libraries.filter.${kind}`
    const handler = async () => {
      const next: LibrariesFilterState = {
        type: kind === 'type' ? value : librariesFilter.type,
        topic: kind === 'topic' ? value : librariesFilter.topic,
      }
      await setLibrariesFilterContext(next)
      pushLibrariesFilter()
    }
    return [
      vscode.commands.registerCommand(
        toCommandId(prefix, value, false),
        handler
      ),
      vscode.commands.registerCommand(
        toCommandId(prefix, value, true),
        handler
      ),
    ]
  }

  const toDisposables: vscode.Disposable[] = []
  for (const t of typeValues) {
    toDisposables.push(...registerFilterCommand('type', t))
  }
  for (const t of topicValues) {
    toDisposables.push(...registerFilterCommand('topic', t))
  }
  // Clear action lives in-webview (clear-all icon). No menu item here.
  context.subscriptions.push(...toDisposables)

  // Initialize contexts and push state when view resolves
  setLibrariesFilterContext(librariesFilter)
  context.subscriptions.push(
    librariesViewProvider.onDidResolve(() => pushLibrariesFilter())
  )

  // --- Platforms filter menu & context wiring ---
  type PlatformsFilterState = { type: string }
  const PLATFORMS_FILTER_STORAGE_KEY = 'boardlab.platforms.filter'
  const storedPlatformsFilter = context.globalState.get<PlatformsFilterState>(
    PLATFORMS_FILTER_STORAGE_KEY,
    { type: '' }
  ) ?? { type: '' }
  const platformsFilter: PlatformsFilterState = {
    type: storedPlatformsFilter.type ?? '',
  }

  const setPlatformsFilterContext = async (state: PlatformsFilterState) => {
    platformsFilter.type = state.type ?? ''
    await context.globalState.update(PLATFORMS_FILTER_STORAGE_KEY, {
      type: platformsFilter.type,
    })
    const isActive = Boolean(platformsFilter.type)
    await vscode.commands.executeCommand(
      'setContext',
      'boardlab.platformsFilter:type',
      platformsFilter.type || undefined
    )
    await vscode.commands.executeCommand(
      'setContext',
      'boardlab.platformsFilter:isActive',
      isActive
    )
  }

  const pushPlatformsFilter = () => {
    try {
      messenger.sendNotification(
        notifyPlatformsFilterChanged,
        { type: 'webview', webviewType: 'boardlab.platformsManager' },
        // @ts-ignore
        { type: platformsFilter.type }
      )
    } catch (error) {
      console.error('Failed to push platforms filter', error)
    }
  }

  context.subscriptions.push(
    messenger.onRequest(setPlatformsFilterContextReq, async (params) => {
      await setPlatformsFilterContext({ type: params.type ?? '' })
    })
  )

  const platformTypeValues = (
    PlatformFilterTypeLiterals as unknown as string[]
  ).filter((v) => v !== 'All')
  const toPlatformCommandId = (value: string, checked = false) =>
    `boardlab.platforms.filter.type.${value.replace(/[^A-Za-z0-9]/g, '')}${
      checked ? '.checked' : ''
    }`

  const platformDisposables: vscode.Disposable[] = []
  for (const value of platformTypeValues) {
    const handler = async () => {
      await setPlatformsFilterContext({ type: value })
      pushPlatformsFilter()
    }
    platformDisposables.push(
      vscode.commands.registerCommand(
        toPlatformCommandId(value, false),
        handler
      ),
      vscode.commands.registerCommand(toPlatformCommandId(value, true), handler)
    )
  }
  context.subscriptions.push(...platformDisposables)

  setPlatformsFilterContext(platformsFilter)
  context.subscriptions.push(
    platformsViewProvider.onDidResolve(() => pushPlatformsFilter())
  )

  let bridgeModeReloadPrompted = false
  let daemonDebugReloadPrompted = false
  const promptBridgeModeReload = async () => {
    if (bridgeModeReloadPrompted) {
      return
    }
    bridgeModeReloadPrompted = true
    const choice = await vscode.window.showInformationMessage(
      'BoardLab needs to reload the window to apply the monitor bridge mode change.',
      'Reload now',
      'Later'
    )
    if (choice === 'Reload now') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow')
    }
  }
  const promptDaemonDebugReload = async () => {
    if (daemonDebugReloadPrompted) {
      return
    }
    daemonDebugReloadPrompted = true
    const choice = await vscode.window.showInformationMessage(
      'BoardLab needs to reload the window to apply the Arduino CLI daemon debug setting change.',
      'Reload now',
      'Later'
    )
    if (choice === 'Reload now') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow')
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('boardlab.monitor.bridgeMode')) {
        promptBridgeModeReload()
      }
      if (event.affectsConfiguration('boardlab.monitor.bridgeLogHeartbeat')) {
        const config = vscode.workspace.getConfiguration('boardlab.monitor')
        const enabled = config.get<boolean>('bridgeLogHeartbeat', false)
        boardlabContext.monitorManager
          .updateBridgeLogging(Boolean(enabled))
          .catch((error) =>
            console.error('Failed to update monitor bridge logging', error)
          )
      }
      if (event.affectsConfiguration('boardlab.cli.daemonDebug')) {
        promptDaemonDebugReload()
      }
      if (event.affectsConfiguration('boardlab.monitor.lineEnding')) {
        monitorEditors.pushLineEnding()
        plotterEditors.pushLineEnding()
      }
      if (
        TERMINAL_SETTING_KEYS.some((key) => event.affectsConfiguration(key))
      ) {
        monitorEditors.pushTerminalSettings()
      }
    })
  )

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      monitorEditors.pushTheme()
    })
  )

  interface ResourceManagerToolbarParam {
    readonly webviewId: string
    readonly webviewSection: 'toolbar' // TODO: string type?
    readonly args: [Resource, Version]
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'boardlab.moreInfo',
      (params: ResourceManagerToolbarParam) => {
        const [item] = params.args
        if (item.website) {
          vscode.env.openExternal(vscode.Uri.parse(item.website))
        }
      }
    )
  )

  async function configureLineEnding(kind: 'monitor' | 'plotter') {
    const configurationSection = `boardlab.${kind}`
    const config = vscode.workspace.getConfiguration(configurationSection)
    const current = config.get<LineEnding>('lineEnding', 'crlf')

    const items: (vscode.QuickPickItem & { value: string })[] = [
      {
        label: 'No line ending',
        description: 'Send text as-is',
        detail: '',
        value: 'none',
      },
      {
        label: 'LF (␊)',
        description: 'Append Line Feed',
        detail: '\\n',
        value: 'lf',
      },
      {
        label: 'CR (␍)',
        description: 'Append Carriage Return',
        detail: '\\r',
        value: 'cr',
      },
      {
        label: 'CRLF (␍␊)',
        description: 'Append CR followed by LF',
        detail: '\\r\\n',
        value: 'crlf',
      },
    ].map((item) => ({
      ...item,
      picked: item.value === current,
    }))

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select the line ending to append when sending data',
    })
    if (!selection) return

    const next = selection.value as LineEnding

    if (next === current) {
      return
    }

    await config.update('lineEnding', next, vscode.ConfigurationTarget.Global)

    if (kind === 'monitor') {
      monitorEditors.pushLineEnding()
    } else {
      plotterEditors.pushLineEnding()
    }
  }

  async function configureMonitorBaudrate(): Promise<void> {
    const running = boardlabContext.monitorManager.getRunningMonitors()
    if (!running.length) {
      vscode.window.showInformationMessage(
        'No running serial monitors to configure.'
      )
      return
    }

    const monitorQuickPickItems = running.map((entry) => ({
      label: formatMonitorPortLabel(entry.port),
      description: entry.baudrate
        ? `${entry.baudrate} baud`
        : 'Unknown baudrate',
      entry,
    }))

    const monitorPick =
      monitorQuickPickItems.length === 1
        ? monitorQuickPickItems[0]
        : await vscode.window.showQuickPick(monitorQuickPickItems, {
            placeHolder: 'Select a running monitor',
          })
    if (!monitorPick) {
      return
    }

    const baudrateOptions = boardlabContext.monitorManager.getBaudrateOptions(
      monitorPick.entry.port
    )
    if (!baudrateOptions.length) {
      vscode.window.showInformationMessage(
        'The selected monitor does not expose configurable baudrates.'
      )
      return
    }

    const currentBaudrate =
      boardlabContext.monitorManager.getCachedBaudrate(
        monitorPick.entry.port
      ) ?? monitorPick.entry.baudrate

    const baudrateQuickPickEntries = baudrateOptions.map((option) => {
      const isSelected = option.value === currentBaudrate
      return {
        label: `${isSelected ? '$(check) ' : ''}${option.value}`,
        value: option.value,
        picked: isSelected,
        description: option.isDefault ? 'default' : undefined,
      }
    })

    const baudratePick =
      baudrateQuickPickEntries.length === 1
        ? baudrateQuickPickEntries[0]
        : await vscode.window.showQuickPick(baudrateQuickPickEntries, {
            placeHolder: 'Select the baudrate for the running monitor',
          })
    if (!baudratePick) {
      return
    }

    try {
      await boardlabContext.monitorManager.updateBaudrate(
        monitorPick.entry.port,
        baudratePick.value
      )
      vscode.window.showInformationMessage(
        `Serial monitor on ${formatMonitorPortLabel(monitorPick.entry.port)} set to ${baudratePick.value} baud.`
      )
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to update baudrate: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  function formatMonitorPortLabel(port: PortIdentifier): string {
    return `${port.protocol} ${port.address}`
  }

  return boardlabContext
}

async function resolveSketchTaskParams(
  boardlabContext: BoardLabContextImpl,
  params: SketchTaskParamsInput,
  options: SketchTaskParamsOptions
): Promise<
  | { sketchPath: string; fqbn?: string; port?: string; programmer?: string }
  | undefined
> {
  const resolvedOptions: Required<SketchTaskParamsOptions> = {
    needFqbn: false,
    needPort: false,
    needProgrammer: false,
    reuseCurrentBoard: true,
    reuseCurrentPort: true,
    ...options,
  }

  let { sketchPath, fqbn, port, programmer } = params

  if (!sketchPath) {
    sketchPath = boardlabContext.currentSketch?.sketchPath
  }
  if (!sketchPath) {
    const sketchFolder = await boardlabContext.selectSketch()
    sketchPath = sketchFolder?.sketchPath
  }
  if (!sketchPath) {
    return undefined
  }

  const current = boardlabContext.currentSketch
  if (current && current.sketchPath === sketchPath) {
    if (resolvedOptions.reuseCurrentBoard && !fqbn) {
      fqbn = current.board?.fqbn
    }
    if (resolvedOptions.reuseCurrentPort && !port && current.port) {
      port = createPortKey(current.port)
    }
  }

  if (resolvedOptions.needFqbn && !fqbn) {
    const board = current?.board ?? (await boardlabContext.selectBoard(current))
    if (typeof board === 'object' && 'fqbn' in board) {
      fqbn = board.fqbn
    } else if (typeof board === 'object' && 'board' in board) {
      fqbn = board.board.fqbn
    }
  }

  if (resolvedOptions.needPort && !port) {
    const selectedPort = await boardlabContext.selectPort(current)
    if (selectedPort) {
      port = createPortKey(selectedPort)
    }
  }

  if (resolvedOptions.needProgrammer && !programmer) {
    const selectedProgrammer = await boardlabContext.selectProgrammer(current)
    if (selectedProgrammer) {
      programmer = selectedProgrammer.id
    }
  }

  if (resolvedOptions.needFqbn && !fqbn) {
    return undefined
  }
  if (resolvedOptions.needPort && !port) {
    return undefined
  }
  if (resolvedOptions.needProgrammer && !programmer) {
    return undefined
  }

  return { sketchPath, fqbn, port, programmer }
}

async function openExampleSketch(
  exampleId: string,
  sketchRelPath: string,
  index: ExamplesIndex
): Promise<boolean> {
  const meta = index.get(exampleId)
  if (!meta) {
    vscode.window.showWarningMessage(
      `Unknown example: ${exampleId}. Try refreshing the view.`
    )
    return false
  }

  const relSegments = sketchRelPath
    ? sketchRelPath.split('/').filter(Boolean)
    : []
  const folderFsPath = path.join(meta.rootPath, ...relSegments)

  try {
    const dirEntries = await fs.readdir(folderFsPath)
    const folderBase = path.basename(folderFsPath)
    const inoFiles = dirEntries.filter((entry) =>
      entry.toLowerCase().endsWith('.ino')
    )
    if (!inoFiles.length) {
      vscode.window.showWarningMessage(
        `Could not locate an .ino sketch inside ${folderFsPath}.`
      )
      return false
    }
    const preferred =
      inoFiles.find(
        (entry) =>
          path.parse(entry).name.toLowerCase() === folderBase.toLowerCase()
      ) ?? inoFiles[0]
    const relPosix = [...relSegments, preferred].filter(Boolean).join('/')
    const uri = buildExampleUri(exampleId, relPosix)
    await vscode.commands.executeCommand('boardlab.examples.openPreview', uri)
    return true
  } catch (error) {
    vscode.window.showWarningMessage(
      `Failed to open example sketch: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}
