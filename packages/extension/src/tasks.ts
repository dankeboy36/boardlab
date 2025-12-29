import { existsSync } from 'node:fs'
import path, { dirname } from 'node:path'
import { basename } from 'node:path/posix'

import { BoardIdentifier, Port, createPortKey } from 'boards-list'
import { ClientError, Status } from 'nice-grpc-common'
import * as vscode from 'vscode'
import { SketchFolder } from 'vscode-arduino-api'

import { BoardLabContextImpl } from './boardlabContext'
import {
  Arduino,
  CompileProgressUpdate,
  FQBN,
  PortQName,
  red,
  revivePort,
  terminalEOL,
} from './cli/arduino'
import { portProtocolIcon, resolvePort } from './ports'
import { collectCliDiagnostics } from './profile/cliDiagnostics'
import { validateProfilesYAML } from './profile/validation'
import { createProgrammerItemDescription } from './sketch/currentSketchView'
import { Sketch } from './sketch/types'
import { buildStatusText } from './statusText'
import type { TaskKind, TaskStatus } from './taskTracker'
import {
  extractPlatformIdFromError,
  isPlatformNotInstalledError,
  platformIdFromFqbn,
} from './platformUtils'
import { onDidChangeTaskStates, tryStopTask } from './taskTracker'
import { presentTaskStatus } from './taskUiState'
import { disposeAll } from './utils'

export class BoardLabTasks implements vscode.TaskProvider, vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem
  private readonly didChangeStatusBarEmitter: vscode.EventEmitter<void>

  private _tasks: vscode.Task[] | undefined
  private _disposables: vscode.Disposable[]

  private previousDefinition: CommandTaskDefinition | undefined = undefined
  private resolvedSketch: Sketch | undefined
  private resolvedBoard: BoardIdentifier | undefined
  private resolvedPort: Port | undefined
  private compileTaskProgress:
    | (CompileProgressUpdate & { sketchPath: string })
    | undefined

  constructor(private readonly boardlabContext: BoardLabContextImpl) {
    this._disposables = []
    this.statusBarItem = vscode.window.createStatusBarItem(
      'boardlab.contextStatusBar',
      vscode.StatusBarAlignment.Left,
      100
    )
    this.didChangeStatusBarEmitter = new vscode.EventEmitter<void>()
    this._disposables.push(
      this.statusBarItem,
      this.didChangeStatusBarEmitter,
      boardlabContext.onDidChangeSketch(() => this.updateStatusBarItem()),
      boardlabContext.onDidChangeCurrentSketch(() =>
        this.updateStatusBarItem()
      ),
      boardlabContext.sketchbooks.onDidChangeResolvedSketches(() =>
        this.updateStatusBarItem()
      ),
      vscode.commands.registerCommand('boardlab.openCommandCenter', () =>
        this.openCommandCenter()
      ),
      boardlabContext.sketchbooks.onDidChangeSketchFolders(
        () => (this._tasks = undefined)
      ),
      vscode.tasks.registerTaskProvider(boardlabTaskType, this),
      boardlabContext.boardsListWatcher.onDidChangeDetectedPorts(() =>
        this.updateStatusBarItem()
      ),
      boardlabContext.monitorManager.onDidChangeRunningMonitors(() =>
        this.updateStatusBarItem()
      ),
      boardlabContext.onDidChangeActiveProfile(() => this.updateStatusBarItem())
    )
    this.statusBarItem.command = 'boardlab.openCommandCenter'
    this.statusBarItem.show()
    this.updateStatusBarItem()
  }

  dispose() {
    vscode.Disposable.from(...this._disposables).dispose()
    this._disposables = []
  }

  private async openCommandCenter(): Promise<void> {
    const definition = await this.taskDefinition()
    if (!definition) {
      return
    }

    let task: vscode.Task | undefined
    if (isCompileTaskDefinition(definition)) {
      // TODO: use non-API groups to reuse terminal? (task.presentationOptions as any) = { ...presentationOptions, group: 'foo' };
      task = this.compileTask(definition)
    } else if (isUploadTaskDefinition(definition)) {
      task = this.uploadTask(definition)
    } else if (isUploadUsingProgrammerTaskDefinition(definition)) {
      task = this.uploadUsingProgrammerTask(definition)
    } else if (isExportBinaryTaskDefinition(definition)) {
      task = this.exportBinariesTask(definition)
    }
    if (task) {
      vscode.tasks.executeTask(task)
      this.previousDefinition = definition
      this.updateStatusBarItem()
    }
  }

  provideTasks(): vscode.Task[] {
    return []
  }

  async compile(params: {
    sketchPath: string
    fqbn: string
  }): Promise<vscode.TaskExecution> {
    return vscode.tasks.executeTask(
      this.compileTask({
        type: boardlabTaskType,
        command: 'compile',
        sketchPath: params.sketchPath,
        fqbn: params.fqbn,
      })
    )
  }

  async upload(params: {
    sketchPath: string
    fqbn: string
    port: PortQName
  }): Promise<vscode.TaskExecution> {
    return vscode.tasks.executeTask(
      this.uploadTask({
        type: boardlabTaskType,
        command: 'upload',
        sketchPath: params.sketchPath,
        fqbn: params.fqbn,
        port: params.port,
      })
    )
  }

  async exportBinary(params: {
    sketchPath: string
    fqbn: string
  }): Promise<vscode.TaskExecution> {
    return vscode.tasks.executeTask(
      this.exportBinariesTask({
        type: boardlabTaskType,
        command: 'export-binary',
        sketchPath: params.sketchPath,
        fqbn: params.fqbn,
      })
    )
  }

  async uploadUsingProgrammer(params: {
    sketchPath: string
    fqbn: string
    port: PortQName
    programmer: string
  }): Promise<vscode.TaskExecution> {
    return vscode.tasks.executeTask(
      this.uploadUsingProgrammerTask({
        type: boardlabTaskType,
        command: 'upload-using-programmer',
        sketchPath: params.sketchPath,
        fqbn: params.fqbn,
        port: params.port,
        programmer: params.programmer,
      })
    )
  }

  async burnBootloader(params: {
    sketchPath: string
    fqbn: string
    port: PortQName
    programmer: string
  }): Promise<vscode.TaskExecution> {
    return vscode.tasks.executeTask(
      this.burnBootloaderTask({
        type: boardlabTaskType,
        command: 'burn-bootloader',
        sketchPath: params.sketchPath,
        fqbn: params.fqbn,
        port: params.port,
        programmer: params.programmer,
      })
    )
  }

  async getBoardInfo(params: {
    sketchPath: string
    port: PortQName
  }): Promise<vscode.TaskExecution> {
    return vscode.tasks.executeTask(
      this.getBoardInfoTask({
        type: boardlabTaskType,
        command: 'get-board-info',
        sketchPath: params.sketchPath,
        port: params.port,
      })
    )
  }

  async archiveSketch(params: {
    sketchPath: string
    archivePath: string
    overwrite?: boolean
  }): Promise<vscode.TaskExecution> {
    return vscode.tasks.executeTask(
      this.archiveSketchTask({
        type: boardlabTaskType,
        command: 'archive-sketch',
        sketchPath: params.sketchPath,
        archivePath: params.archivePath,
        overwrite: params.overwrite ?? false,
      })
    )
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    if (isCompileTaskDefinition(task.definition)) {
      return this.compileTask(task.definition)
    }
    if (isExportBinaryTaskDefinition(task.definition)) {
      return this.exportBinariesTask(task.definition)
    }
    if (isArchiveSketchTaskDefinition(task.definition)) {
      return this.archiveSketchTask(task.definition)
    }
    if (isUploadTaskDefinition(task.definition)) {
      return this.uploadTask(task.definition)
    }
    if (isUploadUsingProgrammerTaskDefinition(task.definition)) {
      return this.uploadUsingProgrammerTask(task.definition)
    }
    if (isBurnBootloaderTaskDefinition(task.definition)) {
      return this.burnBootloaderTask(task.definition)
    }
    if (isGetBoardInfoTaskDefinition(task.definition)) {
      return this.getBoardInfoTask(task.definition)
    }
    return undefined
  }

  /**
   * Clears any compile progress for the given sketch path from the status bar.
   * Useful as a safety net when a task is terminated externally and the
   * underlying CLI progress stream might not have had a chance to flush.
   */
  clearCompileProgress(sketchPath: string): void {
    if (
      this.compileTaskProgress &&
      this.compileTaskProgress.sketchPath === sketchPath
    ) {
      this.compileTaskProgress = undefined
      this.updateStatusBarItem()
    }
  }

  private archiveSketchTask(
    definition: ArchiveSketchTaskDefinition
  ): vscode.Task {
    return new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,
      `${definition.command} ${path.basename(definition.sketchPath)}`,
      boardlabTaskType,
      new vscode.CustomExecution(async (resolvedTask) => {
        const emitter = new vscode.EventEmitter<string>()
        const closeEmitter = new vscode.EventEmitter<void | number>()
        const controller = new AbortController()
        const tasks = this

        let closed = false
        const doClose = () => {
          if (closed) {
            return
          }
          closed = true
          closeEmitter.fire(0)
        }

        async function runArchive(): Promise<void> {
          const { arduino } = await tasks.boardlabContext.client
          const { sketchPath, archivePath, overwrite } = definition

          try {
            await arduino.archiveSketch(
              {
                archivePath,
                sketchPath,
                overwrite,
              },
              controller.signal
            )
            emitter.fire(terminalEOL(`Exported sketch to ${archivePath}\n`))
          } catch (err) {
            emitter.fire(
              red(terminalEOL(err instanceof Error ? err.message : String(err)))
            )
          } finally {
            doClose()
          }
        }

        const pty: vscode.Pseudoterminal = {
          close() {
            controller.abort()
            doClose()
          },
          onDidWrite: emitter.event,
          onDidClose: closeEmitter.event,
          open() {
            runArchive()
          },
        }

        return pty
      }),
      boardlabProblemMatcher
    )
  }

  private getBoardInfoTask(
    definition: GetBoardInfoTaskDefinition
  ): vscode.Task {
    return new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,
      `${definition.command} ${definition.port}`,
      boardlabTaskType,
      new vscode.CustomExecution(async () => {
        const emitter = new vscode.EventEmitter<string>()
        const closeEmitter = new vscode.EventEmitter<void | number>()
        let closed = false
        const doClose = () => {
          if (closed) return
          closed = true
          closeEmitter.fire(0)
        }

        const writeLine = (line: string) => {
          emitter.fire(terminalEOL(`${line}\n`))
        }

        const tasks = this

        async function detectBoard(): Promise<void> {
          try {
            const detectedPorts =
              tasks.boardlabContext.boardsListWatcher.detectedPorts
            const detectedPort = detectedPorts[definition.port]

            if (!detectedPort) {
              writeLine('Board info is not available for this port.')
              writeLine(
                'Make sure the board is connected and the port is detected.'
              )
              doClose()
              return
            }

            const { port, boards } = detectedPort

            if (port.protocol !== 'serial') {
              writeLine(
                'Board info is only available for boards connected to a serial port.'
              )
              doClose()
              return
            }

            const vid = port.properties?.vid
            const pid = port.properties?.pid

            if (!vid || !pid) {
              writeLine(
                'Board info is only available for non-native serial ports with VID/PID.'
              )
              doClose()
              return
            }

            const board = boards && boards[0]
            if (boards && boards.length > 1) {
              console.warn(
                '[getBoardInfo] Multiple boards detected on port; using the first one.',
                { port, boards }
              )
            }

            const BN = board?.name ?? 'Unknown board'
            const VID = vid || '(null)'
            const PID = pid || '(null)'
            const SN = port.properties?.serialNumber || '(null)'

            writeLine(`BN: ${BN}`)
            writeLine(`VID: ${VID}`)
            writeLine(`PID: ${PID}`)
            writeLine(`SN: ${SN}`)
          } catch (error) {
            writeLine(
              red(error instanceof Error ? error.message : String(error))
            )
          } finally {
            doClose()
          }
        }

        const pty: vscode.Pseudoterminal = {
          onDidWrite: emitter.event,
          onDidClose: closeEmitter.event,
          open() {
            detectBoard()
          },
          close() {
            doClose()
          },
        }

        return pty
      })
    )
  }

  private exportBinariesTask(
    definition: ExportBinaryTaskDefinition
  ): vscode.Task {
    return new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,
      `${definition.command} ${definition.fqbn}`,
      boardlabTaskType,
      this.createCompileCustomExecution(true),
      boardlabProblemMatcher
    )
  }

  private uploadUsingProgrammerTask(
    definition: UploadUsingProgrammerTaskDefinition
  ): vscode.Task {
    return new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,
      `${definition.command} ${definition.port}`,
      boardlabTaskType,
      new vscode.CustomExecution(async (resolvedTask) => {
        const { arduino } = await this.boardlabContext.client
        const ok = await this.validateSketchProfile(resolvedTask.sketchPath)
        if (!ok) {
          throw new Error('Profile validation failed')
        }
        const detectedPorts =
          this.boardlabContext.boardsListWatcher.detectedPorts
        const port: any =
          resolvePort(resolvedTask.port, arduino, detectedPorts) ??
          revivePort(resolvedTask.port)
        const programmer = (resolvedTask as UploadUsingProgrammerTaskDefinition)
          .programmer
        const compileConfig = vscode.workspace.getConfiguration('upload')
        const verbose = compileConfig.get<boolean>('verbose') ?? false
        return this.withMonitorSuspended(port, async () =>
          arduino.uploadUsingProgrammer({
            sketchPath: resolvedTask.sketchPath,
            fqbn: resolvedTask.fqbn,
            port,
            programmer,
            verbose,
          })
        )
      })
    )
  }

  private burnBootloaderTask(
    definition: BurnBootloaderTaskDefinition
  ): vscode.Task {
    return new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,
      `${definition.command} ${definition.port}`,
      boardlabTaskType,
      new vscode.CustomExecution(async (resolvedTask) => {
        const { arduino } = await this.boardlabContext.client
        const ok = await this.validateSketchProfile(resolvedTask.sketchPath)
        if (!ok) {
          throw new Error('Profile validation failed')
        }
        const detectedPorts =
          this.boardlabContext.boardsListWatcher.detectedPorts
        const port: any =
          resolvePort(resolvedTask.port, arduino, detectedPorts) ??
          revivePort(resolvedTask.port)
        const programmer = (resolvedTask as BurnBootloaderTaskDefinition)
          .programmer
        return this.withMonitorSuspended(port, async () =>
          arduino.burnBootloader({
            fqbn: resolvedTask.fqbn,
            port,
            programmer, // https://github.com/arduino/arduino-cli/issues/3043
          })
        )
      })
    )
  }

  private compileTask(definition: CompileTaskDefinition): vscode.Task {
    return new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,
      `${definition.command} ${definition.fqbn}`,
      boardlabTaskType,
      this.createCompileCustomExecution(),
      boardlabProblemMatcher
    )
  }

  private createCompileCustomExecution(
    exportBinaries = false
  ): vscode.CustomExecution {
    return new vscode.CustomExecution(async (resolvedTask) => {
      const { arduino } = await this.boardlabContext.client
      // Pre-validate sketch profile (if present)
      const ok = await this.validateSketchProfile(resolvedTask.sketchPath)
      if (!ok) {
        throw new Error('Profile validation failed')
      }
      const compileConfig =
        vscode.workspace.getConfiguration('boardlab.compile')
      const verbose = compileConfig.get<boolean>('verbose') ?? false
      const warnings = (
        compileConfig.get<string>('warnings') ?? 'none'
      ).toLowerCase()

      const { pty, result, progress } = arduino.compile({
        sketchPath: resolvedTask.sketchPath,
        fqbn: resolvedTask.fqbn,
        exportBinaries,
        verbose,
        warnings,
      })
      const progressDisposable = progress((update) =>
        this.setCompileProgress(resolvedTask.sketchPath, update)
      )

      result
        .then((compileResult) => {
          // do not unset compile summary
          if (compileResult) {
            this.boardlabContext.updateCompileSummary(
              resolvedTask.sketchPath,
              compileResult
            )
          }
        })
        .catch((error) => {
          if (error instanceof ClientError && error.code === Status.NOT_FOUND) {
            // https://github.com/arduino/arduino-cli/issues/3037
          }
          this.handleMissingPlatformError(error, resolvedTask.fqbn).catch(
            (handleError) =>
              console.warn('Failed to handle missing platform', handleError)
          )
          console.warn(
            `Failed to update compile summary for ${resolvedTask.sketchPath}`,
            error
          )
        })
        .finally(() => {
          progressDisposable.dispose()
          this.setCompileProgress(resolvedTask.sketchPath, undefined)
        })
      return pty
    })
  }

  private async handleMissingPlatformError(
    error: unknown,
    fqbn: string
  ): Promise<void> {
    if (!isPlatformNotInstalledError(error)) {
      return
    }
    const platformId =
      extractPlatformIdFromError(error) ?? platformIdFromFqbn(fqbn)
    if (!platformId) {
      return
    }

    const quick = await this.boardlabContext.platformsManager
      .lookupPlatformQuick(platformId)
      .catch(() => undefined)
    const platformName = quick?.label ?? platformId
    const version = quick?.availableVersions?.[0] || quick?.installedVersion
    if (!version) {
      return
    }

    const action = await vscode.window.showInformationMessage(
      `Platform '${platformName}' (${platformId}) is not installed. Install now?`,
      'Install',
      'Cancel'
    )
    if (action === 'Install') {
      await this.boardlabContext.platformsManager.install({
        id: platformId,
        name: platformName,
        version,
      })
    }
  }

  private uploadTask(definition: UploadTaskDefinition): vscode.Task {
    return new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,
      `${definition.command} ${definition.port}`,
      boardlabTaskType,
      new vscode.CustomExecution(async (resolvedTask) => {
        const { arduino } = await this.boardlabContext.client
        const ok = await this.validateSketchProfile(resolvedTask.sketchPath)
        if (!ok) {
          throw new Error('Profile validation failed')
        }
        const detectedPorts =
          this.boardlabContext.boardsListWatcher.detectedPorts
        const port: any =
          resolvePort(resolvedTask.port, arduino, detectedPorts) ??
          revivePort(resolvedTask.port) // if cannot resolve the port, try to revive it so that clients see port not found instead port not set

        const compileConfig =
          vscode.workspace.getConfiguration('boardlab.upload')
        const verbose = compileConfig.get<boolean>('verbose') ?? false

        return this.withMonitorSuspended(port, async () =>
          arduino.upload({
            sketchPath: resolvedTask.sketchPath,
            fqbn: resolvedTask.fqbn,
            port,
            verbose,
          })
        )
      })
    )
  }

  private async validateSketchProfile(sketchPath: string): Promise<boolean> {
    try {
      const uri = vscode.Uri.file(
        require('node:path').join(sketchPath, 'sketch.yaml')
      )
      let doc: vscode.TextDocument
      try {
        doc = await vscode.workspace.openTextDocument(uri)
      } catch {
        return true // no profiles file; fine
      }
      const text = doc.getText()
      const ast = validateProfilesYAML(text, doc)
      let cli: vscode.Diagnostic[] = []
      try {
        cli = await collectCliDiagnostics(
          this.boardlabContext as any,
          doc,
          text
        )
      } catch {}
      const all = [...ast, ...cli]
      const hasError = all.some(
        (d) => d.severity === vscode.DiagnosticSeverity.Error
      )
      if (hasError) {
        vscode.window.showErrorMessage(
          'Sketch profile has validation errors. Fix issues before running tasks.'
        )
        return false
      }
      return true
    } catch {
      return true
    }
  }

  private async taskDefinition(): Promise<CommandTaskDefinition | undefined> {
    const toDispose: vscode.Disposable[] = []
    try {
      const input = vscode.window.createQuickPick()
      // https://github.com/microsoft/vscode/issues/73904#issuecomment-680298036

      ;(input as any).sortByLabel = false
      input.matchOnDescription = true
      input.matchOnDetail = true
      input.placeholder =
        'Pick what you want to do with your sketch, board, or port'
      const setInput = (): unknown =>
        (input.items = this.taskDefinitionQuickPickItems())
      setInput()
      input.show()
      const command = await new Promise<TaskCommand | undefined>((resolve) => {
        toDispose.push(
          input.onDidHide(() => {
            resolve(undefined)
            input.dispose()
          }),
          input.onDidTriggerItemButton(async (event) => {
            const item = event.item
            if (
              item instanceof TaskCommandQuickPickItem &&
              item.meta?.stopEnabled
            ) {
              await tryStopTask(
                item.meta.kind,
                item.meta.sketchPath,
                item.meta.port
              )
            }
          }),
          input.onDidChangeSelection((items) => {
            const item = items[0]
            if (item instanceof CommandQuickPickItem) {
              input.hide()
              vscode.commands
                .executeCommand(item.command)
                .then((result: unknown) => {
                  if (result) {
                    this.openCommandCenter()
                  }
                })
            }
            if (item instanceof TaskCommandQuickPickItem) {
              resolve(item.command)
              input.hide()
            }
          }),
          this.didChangeStatusBarEmitter.event(setInput),
          onDidChangeTaskStates(() => setInput())
        )
      })

      const currentSketch =
        this.boardlabContext.currentSketch ??
        (await this.boardlabContext.selectSketch())
      if (!currentSketch) {
        return
      }

      const { board, port, sketchPath } = currentSketch
      const fqbn = board?.fqbn
      const portKey = port ? createPortKey(port) : pickPort
      const type = boardlabTaskType
      if (command === 'compile') {
        return {
          type,
          command,
          sketchPath,
          fqbn,
        }
      } else if (command === 'upload') {
        return { type, command, sketchPath, fqbn, port: portKey }
      } else if (command === 'upload-using-programmer') {
        const programmer = await this.getProgrammerId(currentSketch)
        if (!programmer) {
          return
        }
        return {
          type,
          command,
          sketchPath,
          fqbn,
          port: portKey,
          programmer,
        }
      } else if (command === 'export-binary') {
        return { type, command, sketchPath, fqbn }
      }
    } finally {
      disposeAll(...toDispose)
    }
  }

  private async getProgrammerId(
    currentSketch: any
  ): Promise<string | undefined> {
    if (!currentSketch) {
      return undefined
    }
    const selected = currentSketch.selectedProgrammer as
      | { id?: string }
      | string
      | undefined
    if (typeof selected === 'string') {
      return selected
    }
    if (selected?.id) {
      return selected.id
    }
    const programmer =
      await this.boardlabContext.selectProgrammer(currentSketch)
    if (!programmer) {
      return undefined
    }
    return programmer.id
  }

  private taskDefinitionQuickPickItems(): vscode.QuickPickItem[] {
    const items: vscode.QuickPickItem[] = []
    const currentSketch = this.boardlabContext.currentSketch
    const sketchLabel = this.sketchLabel(false)
    const sketchDescription =
      sketchLabel || this.sketchLabel() || 'No sketch selected'
    const boardLabel = this.boardLabel(false)
    const boardDescription =
      boardLabel || this.boardLabel() || 'No board selected'
    const portLabel = this.portLabel(false)
    const portDescription = portLabel || this.portLabel() || 'No port selected'
    const programmerLabel = this.programmerLabel(currentSketch)
    const sketchPath = currentSketch?.sketchPath
    const portKey = currentSketch?.port
      ? createPortKey(currentSketch.port)
      : undefined

    if (currentSketch) {
      const configureLabel = sketchLabel
        ? `$(settings) Configure '${sketchLabel}'`
        : '$(settings) Configure current sketch'
      const configureDescription = this.formatContextLine({
        includePort: false,
        includeProgrammer: false,
      })

      const buildTaskItem = (
        kind: TaskKind,
        label: string,
        baseDescription: string,
        command: TaskCommand,
        port?: string
      ): TaskCommandQuickPickItem => {
        const ui = presentTaskStatus(kind, sketchPath, port, baseDescription)
        const labelText = label.replace(/^\$\([^)]+\)\s*/, '')
        const decoratedLabel =
          ui.statusIconId && ui.status !== 'idle'
            ? `$(${ui.statusIconId}) ${labelText}`
            : label
        return new TaskCommandQuickPickItem(
          decoratedLabel,
          ui.description,
          command,
          {
            kind,
            sketchPath,
            port,
            status: ui.status,
            stopEnabled: ui.stopEnabled,
          }
        )
      }

      items.push({
        label: 'current sketch',
        kind: vscode.QuickPickItemKind.Separator,
      })
      items.push(
        new CommandQuickPickItem(
          configureLabel,
          'boardlab.configureCurrentSketch',
          configureDescription
        )
      )

      items.push({
        label: 'build & upload',
        kind: vscode.QuickPickItemKind.Separator,
      })
      items.push(
        buildTaskItem(
          'compile',
          `${taskCommandIcon('compile')} Compile`,
          this.formatContextLine({
            includePort: false,
            includeProgrammer: false,
          }),
          'compile'
        ),
        buildTaskItem(
          'upload',
          `${taskCommandIcon('upload')} Upload`,
          this.formatContextLine(),
          'upload',
          portKey
        ),
        buildTaskItem(
          'upload-using-programmer',
          `${taskCommandIcon('upload-using-programmer')} Upload Using Programmer`,
          this.formatContextLine({
            programmer: programmerLabel,
            includeProgrammer: true,
          }),
          'upload-using-programmer',
          portKey
        ),
        buildTaskItem(
          'export-binary',
          `${taskCommandIcon('export-binary')} Export Compiled Binary`,
          this.formatContextLine({
            includePort: false,
            includeProgrammer: false,
          }),
          'export-binary'
        )
      )

      items.push({ label: 'tools', kind: vscode.QuickPickItemKind.Separator })
      items.push(
        new CommandQuickPickItem(
          '$(terminal) Open Monitor',
          'boardlab.openMonitor',
          this.formatContextLine({
            includeSketchPath: false,
            includeBoard: false,
          })
        ),
        new CommandQuickPickItem(
          '$(graph-line) Open Plotter',
          'boardlab.plotter.focus',
          this.formatContextLine({
            includeSketchPath: false,
            includeBoard: false,
          })
        )
      )

      const profileItem = this.profileQuickPickItem(currentSketch)
      if (profileItem) {
        items.push(profileItem)
      }

      items.push({
        label: 'maintenance',
        kind: vscode.QuickPickItemKind.Separator,
      })
      items.push(
        new CommandQuickPickItem(
          `${taskCommandIcon('burn-bootloader')} Burn Bootloader`,
          'boardlab.burnBootloader',
          this.formatContextLine({
            includeSketchPath: false,
          })
        ),
        new CommandQuickPickItem(
          '$(info) Get Board Info',
          'boardlab.getBoardInfo',
          this.formatContextLine({
            includeSketchPath: false,
            includeBoard: false,
          })
        ),
        new CommandQuickPickItem(
          '$(file-zip) Archive Sketch',
          'boardlab.archiveSketch',
          this.formatContextLine({
            includeBoard: false,
            includePort: false,
            includeProgrammer: false,
          })
        )
      )
    }

    items.push({ label: 'context', kind: vscode.QuickPickItemKind.Separator })
    items.push(
      new CommandQuickPickItem(
        '$(file-submodule) Select Sketch',
        'boardlab.selectSketch',
        sketchDescription
      ),
      new CommandQuickPickItem(
        '$(circuit-board) Select Board',
        'boardlab.selectBoard',
        boardDescription
      ),
      new CommandQuickPickItem(
        '$(plug) Select Port',
        'boardlab.selectPort',
        portDescription
      )
    )

    return items
  }

  private profileQuickPickItem(
    sketch: { sketchPath: string } | undefined
  ): vscode.QuickPickItem | undefined {
    if (!sketch) {
      return undefined
    }
    const hasProfile = this.hasSketchProfile(sketch.sketchPath)
    const activeProfile = this.boardlabContext.getActiveProfileForUri(sketch)
    const label = hasProfile
      ? '$(account) Open Profiles'
      : '$(account) Create Profile'
    const description = hasProfile ? activeProfile : undefined
    const command = hasProfile
      ? 'boardlab.profiles.openSketchProfile'
      : 'boardlab.profiles.createSketchProfile'
    return new CommandQuickPickItem(label, command, description)
  }

  private hasSketchProfile(sketchPath: string): boolean {
    try {
      return existsSync(path.join(sketchPath, 'sketch.yaml'))
    } catch {
      return false
    }
  }

  private formatContextLine(
    options: {
      sketch?: string
      board?: string
      port?: string
      programmer?: string
      includeBoard?: boolean
      includePort?: boolean
      includeProgrammer?: boolean
      includeSketchPath?: boolean
    } = {}
  ): string {
    const sketch =
      options.includeSketchPath === false
        ? ''
        : options.sketch ||
          this.sketchLabel(false) ||
          this.sketchLabel() ||
          'No sketch selected'
    const board =
      options.includeBoard === false
        ? ''
        : options.board || this.boardLabel(false) || ''
    const port =
      options.includePort === false
        ? ''
        : options.port || this.portLabel(false) || ''
    const programmer = options.includeProgrammer
      ? options.programmer ||
        this.programmerLabel(this.boardlabContext.currentSketch) ||
        ''
      : ''

    // Hide the board for upload using programmer + burn bootloader.
    // Otherwise, the description is way too long
    const headlineParts = [sketch, board].filter(Boolean)
    if (programmer) {
      headlineParts.splice(1, 1, programmer)
    }

    let line =
      headlineParts.length === 2
        ? `${headlineParts[0]} · ${headlineParts[1]}`
        : (headlineParts[0] ?? '')

    if (port) {
      line = line ? `${line} on ${port}` : `On ${port}`
    }

    return line || 'No sketch selected'
  }

  private programmerLabel(
    sketch: SketchFolder | undefined = this.boardlabContext.currentSketch
  ): string | undefined {
    return (
      sketch?.selectedProgrammer &&
      createProgrammerItemDescription(sketch?.selectedProgrammer, sketch?.board)
        ?.description
    )
  }

  private async updateStatusBarItem(): Promise<void> {
    const oldText = this.statusBarItem.text
    const newText = await this.statusText()
    if (oldText !== newText) {
      this.statusBarItem.text = newText
      this.didChangeStatusBarEmitter.fire()
    }
  }

  private setCompileProgress(
    sketchPath: string,
    update: CompileProgressUpdate | undefined
  ): void {
    if (!update || typeof update.percent !== 'number') {
      if (
        this.compileTaskProgress &&
        this.compileTaskProgress.sketchPath === sketchPath
      ) {
        this.compileTaskProgress = undefined
        this.updateStatusBarItem()
      }
      return
    }

    const bounded = Math.max(0, Math.min(100, update.percent))
    const message = update.message?.trim() || undefined
    this.compileTaskProgress = {
      sketchPath,
      percent: bounded,
      message,
    }
    this.updateStatusBarItem()
  }

  private async statusText(): Promise<string> {
    const icon = '$(dashboard)'
    const currentSketch = this.boardlabContext.currentSketch
    if (!currentSketch) {
      return `${icon} BoardLab`
    }
    const { sketchPath, board, port } = currentSketch
    const { arduino } = await this.boardlabContext.client
    const detectedPorts = this.boardlabContext.boardsListWatcher.detectedPorts
    const [resolvedSketch, resolvedBoard, resolvedPort, activeProfile] =
      await Promise.all([
        this.resolveSketch(vscode.Uri.file(sketchPath)),
        this.resolveBoard(board?.fqbn, arduino),
        resolvePort(
          port ? createPortKey(port) : undefined,
          arduino,
          detectedPorts
        ),
        // Active profile, if set for this sketch
        this.boardlabContext.getValidatedActiveProfileForSketch(sketchPath),
      ])

    this.resolvedSketch = resolvedSketch
    this.resolvedBoard = resolvedBoard
    this.resolvedPort = resolvedPort

    return buildStatusText({
      icon,
      board: this.boardLabel(false),
      port: this.portLabel(false),
      sketch: this.sketchLabel(false),
      profile: activeProfile,
      progress: this.compileTaskProgress
        ? typeof this.compileTaskProgress.percent === 'number'
          ? {
              percent: this.compileTaskProgress.percent,
              message: this.compileTaskProgress.message,
            }
          : { spinning: true, message: this.compileTaskProgress?.message }
        : undefined,
      maxVisible: 64,
    })
  }

  private resolveSketch(sketch: vscode.Uri | undefined): Sketch | undefined {
    if (sketch) {
      return this.boardlabContext.sketchbooks.find(sketch.toString())
    }
    return undefined
  }

  private sketchLabel(long = true): string {
    if (this.resolvedSketch) {
      if (long) {
        const sketchbook = this.boardlabContext.sketchbooks.findSketchbook(
          this.resolvedSketch
        )
        if (sketchbook) {
          let sketchbookName = sketchbook.label
          // if there is a matching workspace folder use its name
          if (vscode.workspace.workspaceFolders) {
            const workspaceFolder = vscode.workspace.workspaceFolders.find(
              (workspaceFolder) =>
                workspaceFolder.uri.toString() === sketchbook.uri.toString()
            )
            if (workspaceFolder) {
              sketchbookName = workspaceFolder.name
            }
          }
          const mainSketchFileUri =
            this.resolvedSketch.mainSketchFileUri.toString()
          const relativePath = mainSketchFileUri.substring(
            sketchbook.uri.toString().length,
            mainSketchFileUri.length
          )
          return `${sketchbookName}${relativePath}`
        }
        return `(Unknown sketchbook) ${this.resolvedSketch.label}`
      }
      return this.resolvedSketch.label
    }
    const label = this.boardlabContext.currentSketch
      ? `${dirname(this.boardlabContext.currentSketch.sketchPath)}/${basename(
          this.boardlabContext.currentSketch.sketchPath
        )}`
      : ''
    if (long) {
      return `${label ?? 'No sketch selected'}`
    }
    return label
  }

  private async resolveBoard(
    fqbn: FQBN | undefined,
    arduino: Arduino
  ): Promise<BoardIdentifier | undefined> {
    if (fqbn) {
      try {
        const resp = await arduino.boardDetails({ fqbn })
        return { fqbn: resp.fqbn, name: resp.name }
      } catch {
        // Platform is not installed. Fallback to search.
      }
      // Need to filter manually by FQBN. Example:
      // 'searchArgs': 'arduino:avr:uno' could result in multiple matches:
      // 'arduino:avr:uno'
      // 'arduino:avr:unomini'
      // 'arduino:avr:unowifi'
      const matchingBoards = await arduino.searchBoard({ searchArgs: fqbn })
      const board = matchingBoards.find(
        (candidate) => candidate.fqbn === fqbn && Boolean(candidate.name)
      )
      if (board?.name && board.fqbn) {
        return board
      }
    }
    return undefined
  }

  private boardLabel(long = true): string {
    if (this.resolvedBoard) {
      if (long) {
        return `${this.resolvedBoard.name} (${this.resolvedBoard.fqbn})`
      }
      return this.resolvedBoard.name
    }
    const label = this.boardlabContext.currentSketch?.board?.name ?? ''
    if (!label && long) {
      return 'No board selected'
    }
    return label
  }

  private portLabel(long = true): string {
    if (this.resolvedPort) {
      const resolvePort = this.resolvedPort
      const resolveLabel = portProtocolIcon(resolvePort) + resolvePort.label
      return resolveLabel
    }
    const label = this.boardlabContext.currentSketch?.port?.address ?? ''
    if (!label && long) {
      return 'No port selected'
    }
    return label
  }

  private async withMonitorSuspended(
    port: Port | undefined,
    run: () => Promise<{
      pty: vscode.Pseudoterminal
      result: Promise<void>
    }>
  ): Promise<vscode.Pseudoterminal> {
    if (!port) {
      const { pty, result } = await run()
      result.catch((error) => {
        console.error('Upload error', error)
      })
      return pty
    }

    const portIdentifier = { protocol: port.protocol, address: port.address }
    const paused =
      await this.boardlabContext.monitorManager.pauseMonitor(portIdentifier)

    const resume = async () => {
      if (!paused) {
        return
      }
      console.log('[tasks] resume monitor after suspension', {
        port: portIdentifier,
        paused,
      })

      const attemptResume = async (remaining: number): Promise<void> => {
        try {
          await this.boardlabContext.monitorManager.resumeMonitor(
            portIdentifier
          )
        } catch (error) {
          if (remaining <= 0) {
            console.error('Failed to resume monitor', error)
            return
          }
        }

        const state =
          this.boardlabContext.monitorManager.getMonitorState(portIdentifier)
        if (state === 'running' || remaining <= 0) {
          return
        }

        await new Promise((resolve) => setTimeout(resolve, 500))
        return attemptResume(remaining - 1)
      }

      await attemptResume(5)
    }

    try {
      const { pty, result } = await run()
      result
        .catch((error) => {
          console.error('Upload error', error)
        })
        .finally(() => {
          resume()
        })
      return pty
    } catch (error) {
      await resume().catch((resumeError) =>
        console.error('Failed to resume monitor', resumeError)
      )
      throw error
    }
  }
}

class CommandQuickPickItem implements vscode.QuickPickItem {
  constructor(
    readonly label: string,
    readonly command: string,
    readonly description?: string
  ) {}
}

class TaskCommandQuickPickItem implements vscode.QuickPickItem {
  readonly buttons: vscode.QuickInputButton[] | undefined

  constructor(
    readonly label: string,
    readonly description: string,
    readonly command: TaskCommand,
    readonly meta?: {
      kind: TaskKind
      sketchPath?: string
      port?: string
      status?: TaskStatus
      stopEnabled?: boolean
    }
  ) {
    this.buttons =
      meta?.stopEnabled && meta.kind
        ? [
            {
              iconPath: new vscode.ThemeIcon('debug-stop'),
              tooltip: 'Stop task',
            },
          ]
        : undefined
  }
}

function taskCommandIcon(taskCommand: string | undefined): string {
  switch (taskCommand) {
    case 'compile':
      return '$(check)'
    case 'upload':
      return '$(arrow-right)'
    case 'upload-using-programmer':
      return '$(server-process)'
    case 'export-binary':
      return '$(file-binary)'
    case 'monitor':
      return '$(search)'
    case 'burn-bootloader':
      return '$(flame)'
    default:
      return ''
  }
}

const boardlabTaskType = 'boardlab' as const
const boardlabProblemMatcher = `$${boardlabTaskType}` as const
const pickPort = '${' + 'command:boardlab.pickPort' + '}'

const taskCommandLiterals = [
  'compile',
  'upload',
  'burn-bootloader',
  'export-binary',
  'archive-sketch',
  'upload-using-programmer',
  'get-board-info',
  'reload-board-data',
] as const
type TaskCommand = (typeof taskCommandLiterals)[number]
function isTaskCommand(arg: unknown): arg is TaskCommand {
  return (
    typeof arg === 'string' && taskCommandLiterals.includes(arg as TaskCommand)
  )
}

interface CommandTaskDefinition extends vscode.TaskDefinition {
  type: typeof boardlabTaskType
  command: TaskCommand
}
function isCommandTaskDefinition(arg: unknown): arg is CommandTaskDefinition
function isCommandTaskDefinition<T extends TaskCommand>(
  arg: unknown,
  command: T
): arg is CommandTaskDefinition & { command: T }
function isCommandTaskDefinition<T extends TaskCommand>(
  arg: unknown,
  command?: T
): arg is CommandTaskDefinition {
  if (
    (<CommandTaskDefinition>arg).type !== undefined &&
    (<CommandTaskDefinition>arg).type === 'boardlab' &&
    (<CommandTaskDefinition>arg).command !== undefined &&
    typeof (<CommandTaskDefinition>arg).command === 'string'
  ) {
    return command
      ? (<CommandTaskDefinition>arg).command === command
      : isTaskCommand((<CommandTaskDefinition>arg).command)
  }
  return false
}

interface CompileTaskDefinition extends CommandTaskDefinition {
  command: 'compile'
  sketchPath: string
  fqbn: FQBN
}
function isCompileTaskDefinition(arg: unknown): arg is CompileTaskDefinition {
  return (
    isCommandTaskDefinition(arg, 'compile') &&
    (<CompileTaskDefinition>arg).sketchPath !== undefined &&
    typeof (<CompileTaskDefinition>arg).sketchPath === 'string' &&
    (<CompileTaskDefinition>arg).fqbn !== undefined &&
    typeof (<CompileTaskDefinition>arg).fqbn === 'string'
  )
}

interface ExportBinaryTaskDefinition extends CommandTaskDefinition {
  command: 'export-binary'
  sketchPath: string
  fqbn: FQBN
}
function isExportBinaryTaskDefinition(
  arg: unknown
): arg is ExportBinaryTaskDefinition {
  return (
    isCommandTaskDefinition(arg, 'export-binary') &&
    (<ExportBinaryTaskDefinition>arg).sketchPath !== undefined &&
    typeof (<ExportBinaryTaskDefinition>arg).sketchPath === 'string' &&
    (<ExportBinaryTaskDefinition>arg).fqbn !== undefined &&
    typeof (<ExportBinaryTaskDefinition>arg).fqbn === 'string'
  )
}

interface ArchiveSketchTaskDefinition extends CommandTaskDefinition {
  command: 'archive-sketch'
  sketchPath: string
  archivePath: string
  overwrite?: boolean
}
function isArchiveSketchTaskDefinition(
  arg: unknown
): arg is ArchiveSketchTaskDefinition {
  return (
    isCommandTaskDefinition(arg, 'archive-sketch') &&
    (<ArchiveSketchTaskDefinition>arg).sketchPath !== undefined &&
    typeof (<ArchiveSketchTaskDefinition>arg).sketchPath === 'string' &&
    (<ArchiveSketchTaskDefinition>arg).archivePath !== undefined &&
    typeof (<ArchiveSketchTaskDefinition>arg).archivePath === 'string'
  )
}

interface GetBoardInfoTaskDefinition extends CommandTaskDefinition {
  command: 'get-board-info'
  port: PortQName
}
function isGetBoardInfoTaskDefinition(
  arg: unknown
): arg is GetBoardInfoTaskDefinition {
  return (
    isCommandTaskDefinition(arg, 'get-board-info') &&
    (<GetBoardInfoTaskDefinition>arg).port !== undefined &&
    typeof (<GetBoardInfoTaskDefinition>arg).port === 'string'
  )
}

interface UploadUsingProgrammerTaskDefinition extends CommandTaskDefinition {
  command: 'upload-using-programmer'
  sketchPath: string
  fqbn: FQBN
  port: PortQName
  programmer: string
}
function isUploadUsingProgrammerTaskDefinition(
  arg: unknown
): arg is UploadUsingProgrammerTaskDefinition {
  return (
    isCommandTaskDefinition(arg, 'upload-using-programmer') &&
    (arg as UploadUsingProgrammerTaskDefinition).sketchPath !== undefined &&
    typeof (arg as UploadUsingProgrammerTaskDefinition).sketchPath ===
      'string' &&
    (arg as UploadUsingProgrammerTaskDefinition).fqbn !== undefined &&
    typeof (arg as UploadUsingProgrammerTaskDefinition).fqbn === 'string' &&
    (arg as UploadUsingProgrammerTaskDefinition).port !== undefined &&
    typeof (arg as UploadUsingProgrammerTaskDefinition).port === 'string' &&
    (arg as UploadUsingProgrammerTaskDefinition).programmer !== undefined &&
    typeof (arg as UploadUsingProgrammerTaskDefinition).programmer === 'string'
  )
}

interface BurnBootloaderTaskDefinition extends CommandTaskDefinition {
  command: 'burn-bootloader'
  sketchPath: string
  fqbn: FQBN
  port: PortQName
  programmer: string
}
function isBurnBootloaderTaskDefinition(
  arg: unknown
): arg is BurnBootloaderTaskDefinition {
  return (
    isCommandTaskDefinition(arg, 'burn-bootloader') &&
    (arg as BurnBootloaderTaskDefinition).sketchPath !== undefined &&
    typeof (arg as BurnBootloaderTaskDefinition).sketchPath === 'string' &&
    (arg as BurnBootloaderTaskDefinition).fqbn !== undefined &&
    typeof (arg as BurnBootloaderTaskDefinition).fqbn === 'string' &&
    (arg as BurnBootloaderTaskDefinition).port !== undefined &&
    typeof (arg as BurnBootloaderTaskDefinition).port === 'string' &&
    (arg as BurnBootloaderTaskDefinition).programmer !== undefined &&
    typeof (arg as BurnBootloaderTaskDefinition).programmer === 'string'
  )
}

interface UploadTaskDefinition extends CommandTaskDefinition {
  command: 'upload'
  sketchPath: string
  fqbn?: FQBN
  port?: PortQName
}
function isUploadTaskDefinition(arg: unknown): arg is UploadTaskDefinition {
  return (
    isCommandTaskDefinition(arg, 'upload') &&
    (<UploadTaskDefinition>arg).sketchPath !== undefined &&
    typeof (<UploadTaskDefinition>arg).sketchPath === 'string' &&
    (<UploadTaskDefinition>arg).fqbn !== undefined &&
    typeof (<UploadTaskDefinition>arg).fqbn === 'string' &&
    (<UploadTaskDefinition>arg).port !== undefined &&
    typeof (<UploadTaskDefinition>arg).port === 'string'
  )
}
