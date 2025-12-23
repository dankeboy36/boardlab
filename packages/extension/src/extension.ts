import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import type {
  LibraryFilterTopic,
  LibraryFilterType,
  LineEnding,
  MonitorSelectionNotification,
  Resource,
  Version,
  VscodeDataContextParams,
} from '@vscode-ardunno/protocol'
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
} from '@vscode-ardunno/protocol'
import type { Mutable, PortIdentifier } from 'boards-list'
import { createPortKey } from 'boards-list'
import { FQBN, valid as isValidFQBN } from 'fqbn'
import * as vscode from 'vscode'
import { Messenger } from 'vscode-messenger'

import { ArdunnoContextImpl, createArdunnoContext } from './ardunnoContext'
import { AddAdditionalPackageIndexUrlParams } from './cli/config'
import { MonitorEditors, PlotterEditors } from './editors/monitorEditors'
import { ProfilesEditorProvider } from './editors/profilesEditor'
import {
  ArdunnoExampleFs,
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
import { formatMonitorUri, MONITOR_URI_SCHEME } from './monitor/monitorUri'
import { collectCliDiagnostics } from './profile/cliDiagnostics'
import { ProfilesCodeActionProvider } from './profile/codeActions'
import { validateProfilesYAML } from './profile/validation'
import { registerProfilesYamlValidation } from './profile/validationHost'
import { CurrentSketchView } from './sketch/currentSketcheView'
import { registerSketchbookReadonlyFs } from './sketch/sketchbookFs'
import { SketchbookView } from './sketch/sketchbookView'
import type { Resource as SketchResource } from './sketch/types'
import {
  isFolder as isSketchbookFolder,
  isSketch as isSketchbookSketch,
} from './sketch/types'
import { ArdunnoTasks } from './tasks'
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

interface AddSketchFolderArgs {
  folderUri: vscode.Uri
  mainFileUri?: vscode.Uri
  openOnly?: boolean
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

  const ardunnoContext = createArdunnoContext(context, messenger)
  console.log('Central services ready', {
    boardsListWatcher: ardunnoContext.boardsListWatcher.constructor.name,
    monitorsRegistry: ardunnoContext.monitorsRegistry.constructor.name,
  })

  const tasks = new ArdunnoTasks(ardunnoContext)
  console.log('Registered tasks provider')
  const currentSketchView = new CurrentSketchView(ardunnoContext)
  console.log('Registered sketches view')
  const sketchbook = new SketchbookView(context, ardunnoContext.sketchbooks)
  console.log('Registered sketchbook view', sketchbook)
  registerSketchbookReadonlyFs(context)

  context.subscriptions.push(
    vscode.tasks.onDidStartTask((event) => {
      const def = event.execution.task.definition as any
      if (!def || def.type !== 'ardunno' || typeof def.command !== 'string') {
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
      if (!def || def.type !== 'ardunno' || typeof def.command !== 'string') {
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
    vscode.commands.registerCommand('ardunno.extensions.searchBoardlab', () =>
      vscode.commands.executeCommand(
        'workbench.extensions.search',
        '@tag:boardlab'
      )
    ),
    vscode.commands.registerCommand('ardunno.configureCurrentSketch', () =>
      currentSketchView.revealCurrentSketch()
    ),
    vscode.commands.registerCommand(
      'ardunno.compile',
      async (params: { sketchPath?: string; fqbn?: string } = {}) => {
        const resolved = await resolveSketchTaskParams(ardunnoContext, params, {
          needFqbn: true,
          reuseCurrentBoard: false,
        })
        if (!resolved || !resolved.fqbn) {
          return
        }
        const { sketchPath, fqbn } = resolved
        await tasks.compile({ sketchPath, fqbn })
      }
    ),
    vscode.commands.registerCommand(
      'ardunno.task.runFromTree',
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
      'ardunno.tool.runFromTree',
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
      'ardunno.task.stopFromTree',
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
      'ardunno.upload',
      async (
        params: { sketchPath?: string; fqbn?: string; port?: string } = {}
      ) => {
        const resolved = await resolveSketchTaskParams(ardunnoContext, params, {
          needFqbn: true,
          needPort: true,
        })
        if (!resolved || !resolved.fqbn || !resolved.port) {
          return
        }
        const { sketchPath, fqbn, port } = resolved
        await tasks.upload({ sketchPath, fqbn, port })
      }
    ),
    vscode.commands.registerCommand('ardunno.openMonitor', async () => {
      await vscode.commands.executeCommand('ardunno.monitor.focus')
    }),
    vscode.commands.registerCommand(
      'ardunno.exportBinary',
      async (params: { sketchPath?: string; fqbn?: string } = {}) => {
        const resolved = await resolveSketchTaskParams(ardunnoContext, params, {
          needFqbn: true,
        })
        if (!resolved || !resolved.fqbn) {
          return
        }
        const { sketchPath, fqbn } = resolved
        await tasks.exportBinary({ sketchPath, fqbn })
      }
    ),
    vscode.commands.registerCommand(
      'ardunno.uploadUsingProgrammer',
      async (
        params: {
          sketchPath?: string
          fqbn?: string
          port?: string
          programmer?: string
        } = {}
      ) => {
        const resolved = await resolveSketchTaskParams(ardunnoContext, params, {
          needFqbn: true,
          needPort: true,
          needProgrammer: true,
        })
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
      'ardunno.burnBootloader',
      async (
        params: {
          sketchPath?: string
          fqbn?: string
          port?: string
          programmer?: string
        } = {}
      ) => {
        const resolved = await resolveSketchTaskParams(ardunnoContext, params, {
          needFqbn: true,
          needPort: true,
          needProgrammer: true,
        })
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
      'ardunno.getBoardInfo',
      async (params: { sketchPath?: string; port?: string } = {}) => {
        const resolved = await resolveSketchTaskParams(ardunnoContext, params, {
          needPort: true,
        })
        if (!resolved || !resolved.port) {
          return
        }
        const { sketchPath, port } = resolved
        await tasks.getBoardInfo({ sketchPath, port })
      }
    ),
    vscode.commands.registerCommand(
      'ardunno.archiveSketch',
      async (params: { sketchPath?: string } = {}) => {
        const resolved = await resolveSketchTaskParams(
          ardunnoContext,
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
          ardunnoContext.cliContext.cliConfig.data?.userDirPath ?? sketchPath
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
      'ardunno.addSketchFolderToWorkspace',
      async (input?: SketchResource | AddSketchFolderArgs) => {
        await addSketchFolderToWorkspace(input)
      }
    ),
    vscode.commands.registerCommand(
      'ardunno.profiles.openTextEditor',
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
      'ardunno.profiles.setActive',
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
      'ardunno.profiles.openSketchProfile',
      async (params?: { sketchPath?: string }) => {
        let sketchPath = params?.sketchPath
        if (!sketchPath) {
          const sketch =
            ardunnoContext.currentSketch ??
            (await ardunnoContext.selectSketch())
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
          'ardunno.profilesEditor'
        )
      }
    ),
    vscode.commands.registerCommand(
      'ardunno.profiles.createSketchProfile',
      async (params?: { sketchPath?: string }) => {
        let sketchPath = params?.sketchPath
        let currentSketch = ardunnoContext.currentSketch
        if (!sketchPath) {
          const sketch = currentSketch ?? (await ardunnoContext.selectSketch())
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
            'ardunno.profilesEditor'
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
    messenger.onRequest(requestConfigureLineEnding, async ({ kind }) => {
      await configureLineEnding(kind)
    })
  )

  const { cliContext } = ardunnoContext
  context.subscriptions.push(
    tasks,
    currentSketchView,
    sketchbook,
    vscode.commands.registerCommand(
      'ardunno.openArduinoCliConfig',
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
      'ardunno.addAdditionalPackageIndexUrlToArduinoCliConfig',
      async (params: Partial<AddAdditionalPackageIndexUrlParams>) => {
        let { url } = params
        if (!url) {
          url = await vscode.window.showInputBox({
            title:
              'Platform package index URL to add to the Arduino CLI configuration',
            prompt:
              'Enter an additional platform package index URL (http/https).',
            placeHolder: 'https://example.com/package_index.json',
            validateInput: (value) => {
              const trimmed = value.trim()
              if (!trimmed) return 'URL is required'
              try {
                const url = new URL(trimmed)
                if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                  return 'Only http/https URLs are supported'
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
    messenger
  )
  const platformsViewProvider = new PlatformsManagerViewProvider(
    context.extensionUri,
    messenger
  )
  const examplesViewProvider = new ExamplesViewProvider(
    context.extensionUri,
    messenger
  )

  const examplesIndex = new ExamplesIndex(ardunnoContext)
  const examplesFs = new ArdunnoExampleFs(examplesIndex)

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
    ardunnoContext.platformsManager,
    vscode.window.registerWebviewViewProvider(
      'ardunno.platformsManager',
      platformsViewProvider
    ),
    ardunnoContext.librariesManager,
    vscode.window.registerWebviewViewProvider(
      'ardunno.librariesManager',
      librariesViewProvider
    ),
    vscode.window.registerWebviewViewProvider(
      'arduinoExamples',
      examplesViewProvider
    ),
    vscode.commands.registerCommand('arduino.examples.refresh', async () => {
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

    const sketchWithPort = ardunnoContext.currentSketch?.port
      ? ardunnoContext.currentSketch
      : ardunnoContext.sketchbooks.resolvedSketchFolders.find(
          (sketch) => sketch.port
        )

    const sketchPort = sketchWithPort?.port as PortIdentifier | undefined
    const protocol = sketchPort?.protocol
    const address = sketchPort?.address
    if (protocol && address) {
      const portIdentifier = { protocol, address }
      selection.port = portIdentifier
      try {
        const monitorState = ardunnoContext.monitorsRegistry.get(
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
    ardunnoContext.monitorManager
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
    messenger,
    monitorResourceStore,
    monitorSelectionCoordinator
  )
  const plotterEditors = new PlotterEditors(
    context.extensionUri,
    messenger,
    monitorResourceStore,
    monitorSelectionCoordinator
  )
  const profilesDiagnostics =
    vscode.languages.createDiagnosticCollection('ardunnoProfiles')
  context.subscriptions.push(profilesDiagnostics)
  const profilesEditor = new ProfilesEditorProvider(
    context.extensionUri,
    messenger,
    ardunnoContext,
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

  ardunnoContext.monitorManager.setSelectionResolver(
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

  const sketchChangeDisposable = ardunnoContext.onDidChangeSketch((event) => {
    if (!event.changedProperties || event.changedProperties.includes('port')) {
      pushSelection()
    }
  })

  const currentSketchDisposable = ardunnoContext.onDidChangeCurrentSketch(
    () => {
      pushSelection()
    }
  )

  const monitorsRegistryDisposable =
    ardunnoContext.monitorsRegistry.onDidChange(() => {
      lastSelectionSignature = undefined
      pushSelection()
    })

  const resolvedSketchesDisposable =
    ardunnoContext.sketchbooks.onDidChangeResolvedSketches(() => {
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
      collectCliDiagnostics(ardunnoContext, doc, text)
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
      ardunnoContext
    ),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file', pattern: '**/sketch.yaml' },
      new ProfilesCodeActionProvider(
        ardunnoContext.librariesManager,
        ardunnoContext.platformsManager
      ),
      {
        providedCodeActionKinds:
          ProfilesCodeActionProvider.providedCodeActionKinds,
      }
    ),
    vscode.commands.registerCommand(
      'ardunno.profiles.selectPlatformVersionForProfile',
      async (arg: { uri: string; range: vscode.Range; platform: string }) => {
        const uri = vscode.Uri.parse(arg.uri)
        const quickInfo =
          await ardunnoContext.platformsManager.lookupPlatformQuick(
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
    ardunnoContext.monitorManager,
    vscode.window.registerCustomEditorProvider(
      'ardunno.monitorEditor',
      monitorEditors,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    ),
    // Refresh profiles diagnostics when platforms/libraries change or indexes update
    ardunnoContext.platformsManager.onDidUpdate(() =>
      refreshProfilesDiagnostics()
    ),
    ardunnoContext.librariesManager.onDidUpdate(() =>
      refreshProfilesDiagnostics()
    ),
    vscode.window.registerCustomEditorProvider(
      'ardunno.plotterEditor',
      plotterEditors,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }
    ),
    vscode.window.registerCustomEditorProvider(
      'ardunno.profilesEditor',
      profilesEditor,
      {
        webviewOptions: { retainContextWhenHidden: true },
      }
    ),
    vscode.commands.registerCommand(
      'ardunno.profiles.installPlatform',
      async (params?: { id: string; version?: string }) => {
        const id: string | undefined = params?.id
        const requestedVersion: string | undefined = params?.version
        if (!id) return

        try {
          let version = requestedVersion
          if (!version) {
            version = (
              await ardunnoContext.platformsManager.lookupPlatformQuick(id)
            )?.availableVersions[0]
          }

          if (!version) {
            vscode.window.showWarningMessage(
              `Unable to resolve versions for platform '${id}'.`
            )
            return
          }

          await ardunnoContext.platformsManager.install({
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
      'ardunno.profiles.installLibrary',
      async (params?: { id: string; version?: string }) => {
        const id: string | undefined = params?.id
        const requestedVersion: string | undefined = params?.version
        if (!id) return

        try {
          let version = requestedVersion
          if (!version) {
            version = (
              await ardunnoContext.librariesManager.lookupLibraryQuick(id)
            )?.availableVersions[0]
          }

          if (!version) {
            vscode.window.showWarningMessage(
              `Unable to resolve versions for library '${id}'.`
            )
            return
          }

          await ardunnoContext.librariesManager.install({
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
      'ardunno.profiles.selectLibraryVersionForProfile',
      async (arg: { uri: string; range: vscode.Range; library: string }) => {
        const uri = vscode.Uri.parse(arg.uri)
        const quickInfo =
          await ardunnoContext.librariesManager.lookupLibraryQuick(arg.library)
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
      'ardunno.profiles.setDefault',
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
      'ardunno.profiles.delete',
      async (params: VscodeDataContextParams) => {
        const [profileName, uriString] = params.args ?? []
        if (!profileName || !uriString) return
        await profilesEditor.deleteProfileByCommand({
          uri: uriString,
          name: profileName,
        })
      }
    ),
    vscode.commands.registerCommand('ardunno.monitor.focus', async () => {
      await openMonitorResource('ardunno.monitorEditor')
    }),
    vscode.commands.registerCommand('ardunno.plotter.focus', async () => {
      await openMonitorResource('ardunno.plotterEditor')
    }),
    vscode.commands.registerCommand('ardunno.monitor.copyAll', async () => {
      const active = monitorEditors.getActiveDocument()
      if (!active) {
        vscode.window.showInformationMessage(
          'Open a monitor editor to copy output.'
        )
        return
      }
      await monitorEditors.sendToolbarAction('copyAll', active)
    }),
    vscode.commands.registerCommand('ardunno.monitor.saveToFile', async () => {
      const active = monitorEditors.getActiveDocument()
      if (!active) {
        vscode.window.showInformationMessage(
          'Open a monitor editor to save output.'
        )
        return
      }
      await monitorEditors.sendToolbarAction('saveToFile', active)
    }),
    vscode.commands.registerCommand('ardunno.monitor.clear', async () => {
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
      'ardunno.monitor.toggleScrollLock',
      async () => {
        const active = monitorEditors.getActiveDocument()
        if (!active) {
          vscode.window.showInformationMessage(
            'Open a monitor editor to toggle scroll lock.'
          )
          return
        }
        await monitorEditors.sendToolbarAction('toggleScrollLock', active)
      }
    ),
    vscode.commands.registerCommand('ardunno.plotter.clear', async () => {
      const active = plotterEditors.getActiveDocument()
      if (!active) {
        vscode.window.showInformationMessage(
          'Open a plotter editor to clear the plot.'
        )
        return
      }
      await plotterEditors.sendToolbarAction('clear', active)
    }),
    vscode.commands.registerCommand('ardunno.plotter.resetYScale', async () => {
      const active = plotterEditors.getActiveDocument()
      if (!active) {
        vscode.window.showInformationMessage(
          'Open a plotter editor to reset the Y scale.'
        )
        return
      }
      await plotterEditors.sendToolbarAction('resetYScale', active)
    }),
    vscode.commands.registerCommand('ardunno.monitor.configureLineEnding', () =>
      configureLineEnding('monitor')
    ),
    vscode.commands.registerCommand(
      'ardunno.monitor.configureBaudrate',
      configureMonitorBaudrate
    ),
    vscode.commands.registerCommand('ardunno.plotter.configureLineEnding', () =>
      configureLineEnding('plotter')
    )
  )

  pushSelection()

  async function openMonitorResource(
    viewType: 'ardunno.monitorEditor' | 'ardunno.plotterEditor'
  ): Promise<void> {
    const targetLabel = viewType.includes('plotter')
      ? 'serial plotter'
      : 'serial monitor'
    console.log('[ardunno] openMonitorResource', {
      viewType,
      targetLabel,
    })
    let selection = computeSelection()
    if (!selection.port) {
      await vscode.commands.executeCommand('ardunno.selectPort')
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
      console.log('[ardunno] openWith success', {
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

  // --- Libraries filter menu & context wiring ---
  type LibrariesFilterState = {
    type: LibraryFilterType | ''
    topic: LibraryFilterTopic | ''
  }
  const LIBRARIES_FILTER_STORAGE_KEY = 'ardunno.libraries.filter'
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
      'ardunno.librariesFilter:type',
      librariesFilter.type || undefined
    )
    await vscode.commands.executeCommand(
      'setContext',
      'ardunno.librariesFilter:topic',
      librariesFilter.topic || undefined
    )
    await vscode.commands.executeCommand(
      'setContext',
      'ardunno.librariesFilter:isActive',
      isActive
    )
  }

  const pushLibrariesFilter = () => {
    try {
      messenger.sendNotification(
        notifyLibrariesFilterChanged,
        { type: 'webview', webviewType: 'ardunno.librariesManager' },
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
    const prefix = `ardunno.libraries.filter.${kind}`
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
  const PLATFORMS_FILTER_STORAGE_KEY = 'ardunno.platforms.filter'
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
      'ardunno.platformsFilter:type',
      platformsFilter.type || undefined
    )
    await vscode.commands.executeCommand(
      'setContext',
      'ardunno.platformsFilter:isActive',
      isActive
    )
  }

  const pushPlatformsFilter = () => {
    try {
      messenger.sendNotification(
        notifyPlatformsFilterChanged,
        { type: 'webview', webviewType: 'ardunno.platformsManager' },
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
    `ardunno.platforms.filter.type.${value.replace(/[^A-Za-z0-9]/g, '')}${
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

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('ardunno.monitor.lineEnding')) {
        monitorEditors.pushLineEnding()
        plotterEditors.pushLineEnding()
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
      'ardunno.moreInfo',
      (params: ResourceManagerToolbarParam) => {
        const [item] = params.args
        if (item.website) {
          vscode.env.openExternal(vscode.Uri.parse(item.website))
        }
      }
    )
  )

  async function configureLineEnding(kind: 'monitor' | 'plotter') {
    const configurationSection = `ardunno.${kind}`
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
    const running = ardunnoContext.monitorManager.getRunningMonitors()
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

    const baudrateOptions = ardunnoContext.monitorManager.getBaudrateOptions(
      monitorPick.entry.port
    )
    if (!baudrateOptions.length) {
      vscode.window.showInformationMessage(
        'The selected monitor does not expose configurable baudrates.'
      )
      return
    }

    const currentBaudrate =
      ardunnoContext.monitorManager.getCachedBaudrate(monitorPick.entry.port) ??
      monitorPick.entry.baudrate

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
      await ardunnoContext.monitorManager.updateBaudrate(
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

  return ardunnoContext
}

async function resolveSketchTaskParams(
  ardunnoContext: ArdunnoContextImpl,
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
    sketchPath = ardunnoContext.currentSketch?.sketchPath
  }
  if (!sketchPath) {
    const sketchFolder = await ardunnoContext.selectSketch()
    sketchPath = sketchFolder?.sketchPath
  }
  if (!sketchPath) {
    return undefined
  }

  const current = ardunnoContext.currentSketch
  if (current && current.sketchPath === sketchPath) {
    if (resolvedOptions.reuseCurrentBoard && !fqbn) {
      fqbn = current.board?.fqbn
    }
    if (resolvedOptions.reuseCurrentPort && !port && current.port) {
      port = createPortKey(current.port)
    }
  }

  if (resolvedOptions.needFqbn && !fqbn) {
    const board = await ardunnoContext.selectBoard(current)
    if (typeof board === 'object' && 'fqbn' in board) {
      fqbn = board.fqbn
    } else if (typeof board === 'object' && 'board' in board) {
      fqbn = board.board.fqbn
    }
  }

  if (resolvedOptions.needPort && !port) {
    const selectedPort = await ardunnoContext.selectPort(current)
    if (selectedPort) {
      port = createPortKey(selectedPort)
    }
  }

  if (resolvedOptions.needProgrammer && !programmer) {
    const selectedProgrammer = await ardunnoContext.selectProgrammer(current)
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

async function addSketchFolderToWorkspace(
  input: SketchResource | AddSketchFolderArgs | undefined
): Promise<void> {
  const args = await normalizeAddSketchArgs(input)
  if (!args) {
    vscode.window.showWarningMessage('Unable to determine sketch folder.')
    return
  }

  const { folderUri, mainFileUri, openOnly } = args
  const existing = getWorkspaceFolderByUri(folderUri)
  const targetFile = mainFileUri ?? guessMainSketchUri(folderUri)

  if (existing || openOnly) {
    await openSketchDocument(targetFile)
    return
  }

  const startIndex = vscode.workspace.workspaceFolders?.length ?? 0
  const added = vscode.workspace.updateWorkspaceFolders(startIndex, null, {
    uri: folderUri,
  })

  if (!added) {
    vscode.window.showErrorMessage(
      `Failed to add "${path.basename(folderUri.fsPath)}" to the workspace.`
    )
    return
  }

  await openSketchDocument(targetFile)
}

async function normalizeAddSketchArgs(
  input: SketchResource | AddSketchFolderArgs | undefined
): Promise<AddSketchFolderArgs | undefined> {
  if (!input) {
    return undefined
  }

  if ('folderUri' in input) {
    const folderUri = input.folderUri.with({ scheme: 'file' })
    const mainFileUri = input.mainFileUri?.with({ scheme: 'file' })
    return {
      folderUri,
      mainFileUri,
      openOnly: input.openOnly ?? false,
    }
  }

  if (isSketchbookSketch(input)) {
    const folderUri = input.uri.with({ scheme: 'file' })
    return {
      folderUri,
      mainFileUri:
        input.mainSketchFileUri?.with({ scheme: 'file' }) ??
        guessMainSketchUri(folderUri),
    }
  }

  if (isSketchbookFolder(input)) {
    const folderUri = input.uri.with({ scheme: 'file' })
    return {
      folderUri,
      mainFileUri: guessMainSketchUri(folderUri),
    }
  }

  return undefined
}

function guessMainSketchUri(folderUri: vscode.Uri): vscode.Uri {
  const name = path.basename(folderUri.fsPath)
  return vscode.Uri.joinPath(folderUri, `${name}.ino`)
}

async function openSketchDocument(uri: vscode.Uri): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(document, { preview: false })
  } catch (error) {
    console.warn('Failed to open sketch document', error)
    vscode.window.showWarningMessage(
      `Sketch folder added, but failed to open "${uri.fsPath}".`
    )
  }
}

function getWorkspaceFolderByUri(
  folderUri: vscode.Uri
): vscode.WorkspaceFolder | undefined {
  const targetPath = folderUri.with({ scheme: 'file' }).fsPath
  return (vscode.workspace.workspaceFolders ?? []).find(
    (folder) => folder.uri.fsPath === targetPath
  )
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
    await vscode.commands.executeCommand('arduino.examples.openPreview', uri)
    return true
  } catch (error) {
    vscode.window.showWarningMessage(
      `Failed to open example sketch: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}
