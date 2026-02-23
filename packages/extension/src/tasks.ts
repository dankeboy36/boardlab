import { existsSync } from 'node:fs'
import path, { dirname } from 'node:path'
import { basename } from 'node:path/posix'

import type { CompileRequest } from 'ardunno-cli/api'
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
import {
  extractPlatformIdFromError,
  isPlatformNotInstalledError,
  platformIdFromFqbn,
} from './platformUtils'
import { portProtocolIcon, resolvePort } from './ports'
import { collectCliDiagnostics } from './profile/cliDiagnostics'
import { validateProfilesYAML } from './profile/validation'
import { createProgrammerItemDescription } from './sketch/currentSketchView'
import { Sketch } from './sketch/types'
import { buildStatusText } from './statusText'
import { type TaskKind, taskKindLiterals, type TaskStatus } from './taskTracker'
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

  async compileWithDebugSymbols(params: {
    sketchPath: string
    fqbn: string
  }): Promise<vscode.TaskExecution> {
    return vscode.tasks.executeTask(
      this.compileWithDebugSymbolsTask({
        type: boardlabTaskType,
        command: 'compile-with-debug-symbols',
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
    if (isCompileWithDebugSymbolsTaskDefinition(task.definition)) {
      return this.compileWithDebugSymbolsTask(task.definition)
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
      this.createCompileCustomExecution({ exportBinaries: true }),
      boardlabProblemMatcher
    )
  }

  private compileWithDebugSymbolsTask(
    definition: CompileWithDebugSymbolsTaskDefinition
  ): vscode.Task {
    return new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,
      `${definition.command} ${definition.fqbn}`,
      boardlabTaskType,
      this.createCompileCustomExecution({ optimizeForDebug: true }),
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
          return this.createValidationFailurePty()
        }
        const preUploadHooks = await this.runConfiguredHooks({
          setting: 'preUploadTasks',
          sketchPath: resolvedTask.sketchPath,
          phase: 'pre-upload',
          blockOnFailure: true,
          showCancelPrompt: true,
        })
        if (!preUploadHooks.ok) {
          return this.createValidationFailurePty(
            preUploadHooks.output.join('\n')
          )
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
        const portIdentifier = port
          ? { protocol: port.protocol, address: port.address }
          : undefined

        if (!portIdentifier) {
          const { pty, result } = arduino.uploadUsingProgrammer({
            sketchPath: resolvedTask.sketchPath,
            fqbn: resolvedTask.fqbn,
            port,
            programmer,
            verbose,
          })
          const wrappedPty = this.withPostHooks(pty, result, {
            setting: 'postUploadTasks',
            sketchPath: resolvedTask.sketchPath,
            phase: 'post-upload',
          })
          return this.withPtyPreface(wrappedPty, preUploadHooks.output)
        }

        const { pty, result } = await this.boardlabContext.withMonitorSuspended(
          portIdentifier,
          async (options) =>
            arduino.uploadUsingProgrammer({
              sketchPath: resolvedTask.sketchPath,
              fqbn: resolvedTask.fqbn,
              port,
              programmer,
              verbose,
              retry: options?.retry,
            })
        )
        const wrappedPty = this.withPostHooks(pty, result, {
          setting: 'postUploadTasks',
          sketchPath: resolvedTask.sketchPath,
          phase: 'post-upload',
        })
        return this.withPtyPreface(wrappedPty, preUploadHooks.output)
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
          return this.createValidationFailurePty()
        }
        const preUploadHooks = await this.runConfiguredHooks({
          setting: 'preUploadTasks',
          sketchPath: resolvedTask.sketchPath,
          phase: 'pre-upload',
          blockOnFailure: true,
          showCancelPrompt: true,
        })
        if (!preUploadHooks.ok) {
          return this.createValidationFailurePty(
            preUploadHooks.output.join('\n')
          )
        }
        const detectedPorts =
          this.boardlabContext.boardsListWatcher.detectedPorts
        const port: any =
          resolvePort(resolvedTask.port, arduino, detectedPorts) ??
          revivePort(resolvedTask.port)
        const programmer = (resolvedTask as BurnBootloaderTaskDefinition)
          .programmer
        const portIdentifier = port
          ? { protocol: port.protocol, address: port.address }
          : undefined

        if (!portIdentifier) {
          const { pty, result } = arduino.burnBootloader({
            fqbn: resolvedTask.fqbn,
            port,
            programmer, // https://github.com/arduino/arduino-cli/issues/3043
          })
          const wrappedPty = this.withPostHooks(pty, result, {
            setting: 'postUploadTasks',
            sketchPath: resolvedTask.sketchPath,
            phase: 'post-upload',
          })
          return this.withPtyPreface(wrappedPty, preUploadHooks.output)
        }

        const { pty, result } = await this.boardlabContext.withMonitorSuspended(
          portIdentifier,
          async (options) =>
            arduino.burnBootloader({
              fqbn: resolvedTask.fqbn,
              port,
              programmer, // https://github.com/arduino/arduino-cli/issues/3043
              retry: options?.retry,
            })
        )
        const wrappedPty = this.withPostHooks(pty, result, {
          setting: 'postUploadTasks',
          sketchPath: resolvedTask.sketchPath,
          phase: 'post-upload',
        })
        return this.withPtyPreface(wrappedPty, preUploadHooks.output)
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
    overrides: Partial<Omit<CompileRequest, 'instance'>> = {}
  ): vscode.CustomExecution {
    return new vscode.CustomExecution(async (resolvedTask) => {
      const { arduino } = await this.boardlabContext.client
      // Pre-validate sketch profile (if present)
      const ok = await this.validateSketchProfile(resolvedTask.sketchPath)
      if (!ok) {
        return this.createValidationFailurePty()
      }
      const preCompileHooks = await this.runConfiguredHooks({
        setting: 'preCompileTasks',
        sketchPath: resolvedTask.sketchPath,
        phase: 'pre-compile',
        blockOnFailure: true,
        showCancelPrompt: true,
      })
      if (!preCompileHooks.ok) {
        return this.createValidationFailurePty(
          preCompileHooks.output.join('\n')
        )
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
        verbose,
        warnings,
        ...overrides,
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
      const wrappedPty = this.withPostHooks(pty, result, {
        setting: 'postCompileTasks',
        sketchPath: resolvedTask.sketchPath,
        phase: 'post-compile',
      })
      return this.withPtyPreface(wrappedPty, preCompileHooks.output)
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
          return this.createValidationFailurePty()
        }
        const preUploadHooks = await this.runConfiguredHooks({
          setting: 'preUploadTasks',
          sketchPath: resolvedTask.sketchPath,
          phase: 'pre-upload',
          blockOnFailure: true,
          showCancelPrompt: true,
        })
        if (!preUploadHooks.ok) {
          return this.createValidationFailurePty(
            preUploadHooks.output.join('\n')
          )
        }
        const detectedPorts =
          this.boardlabContext.boardsListWatcher.detectedPorts
        const port: any =
          resolvePort(resolvedTask.port, arduino, detectedPorts) ??
          revivePort(resolvedTask.port) // if cannot resolve the port, try to revive it so that clients see port not found instead port not set

        const compileConfig =
          vscode.workspace.getConfiguration('boardlab.upload')
        const verbose = compileConfig.get<boolean>('verbose') ?? false

        const portIdentifier = port
          ? { protocol: port.protocol, address: port.address }
          : undefined

        if (!portIdentifier) {
          const { pty, result } = arduino.upload({
            sketchPath: resolvedTask.sketchPath,
            fqbn: resolvedTask.fqbn,
            port,
            verbose,
          })
          const wrappedPty = this.withPostHooks(pty, result, {
            setting: 'postUploadTasks',
            sketchPath: resolvedTask.sketchPath,
            phase: 'post-upload',
          })
          return this.withPtyPreface(wrappedPty, preUploadHooks.output)
        }

        const { pty, result } = await this.boardlabContext.withMonitorSuspended(
          portIdentifier,
          async (options) =>
            arduino.upload({
              sketchPath: resolvedTask.sketchPath,
              fqbn: resolvedTask.fqbn,
              port,
              verbose,
              retry: options?.retry,
            })
        )
        const wrappedPty = this.withPostHooks(pty, result, {
          setting: 'postUploadTasks',
          sketchPath: resolvedTask.sketchPath,
          phase: 'post-upload',
        })
        return this.withPtyPreface(wrappedPty, preUploadHooks.output)
      })
    )
  }

  private async runConfiguredHooks(params: {
    setting: HookSettingKey
    sketchPath: string
    phase: HookPhase
    blockOnFailure: boolean
    showCancelPrompt: boolean
  }): Promise<HookRunResult> {
    const output: string[] = []
    const labels = this.getHookTaskLabels(params.setting)
    if (!labels.length) {
      return { ok: true, output }
    }

    let availableTasks: vscode.Task[] = []
    try {
      availableTasks = await vscode.tasks.fetchTasks()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const line = `[hooks] Failed to fetch tasks for ${params.phase} hooks: ${message}`
      console.warn(line)
      output.push(line)
      return { ok: true, output }
    }

    for (const label of labels) {
      const hookTask = this.resolveHookTask(
        availableTasks,
        label,
        params.sketchPath
      )
      if (!hookTask) {
        const line = `[hooks] ${params.phase}: task "${label}" was not found. Skipping.`
        console.warn(line)
        output.push(line)
        continue
      }

      const definition = hookTask.definition as
        | { type?: string; command?: string }
        | undefined
      if (definition && isRecursiveBoardlabHook(params.setting, definition)) {
        const line = `[hooks] ${params.phase}: task "${label}" would recursively trigger BoardLab ${definition.command}. Skipping.`
        console.warn(line)
        output.push(line)
        continue
      }

      const outcome = await this.runHookTask(hookTask, {
        label,
        phase: params.phase,
        showCancelPrompt: params.showCancelPrompt,
      })

      if (outcome.status === 'failed') {
        const message = `Hook task "${label}" failed during ${params.phase} (exit code ${outcome.exitCode ?? 1}).`
        const line = `[hooks] ${message}`
        console.warn(line)
        output.push(line)
        if (params.blockOnFailure) {
          return { ok: false, message, output }
        }
        vscode.window.showWarningMessage(message)
      }
    }

    return { ok: true, output }
  }

  private getHookTaskLabels(setting: HookSettingKey): string[] {
    const raw = vscode.workspace
      .getConfiguration('boardlab.hooks')
      .get<unknown>(setting)
    if (Array.isArray(raw)) {
      return raw
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      return trimmed ? [trimmed] : []
    }
    return []
  }

  private resolveHookTask(
    tasks: readonly vscode.Task[],
    label: string,
    sketchPath: string
  ): vscode.Task | undefined {
    const matches = tasks.filter((task) => task.name === label)
    if (!matches.length) {
      return undefined
    }

    const sketchUri = vscode.Uri.file(sketchPath)
    const sketchWorkspace = vscode.workspace.getWorkspaceFolder(sketchUri)
    if (sketchWorkspace) {
      const workspaceScoped = matches.find(
        (task) =>
          isWorkspaceFolderScope(task.scope) &&
          task.scope.uri.toString() === sketchWorkspace.uri.toString()
      )
      if (workspaceScoped) {
        return workspaceScoped
      }
    }

    const workspaceTask = matches.find(
      (task) => task.scope === vscode.TaskScope.Workspace
    )
    if (workspaceTask) {
      return workspaceTask
    }
    return matches[0]
  }

  private async runHookTask(
    task: vscode.Task,
    options: {
      label: string
      phase: HookPhase
      showCancelPrompt: boolean
    }
  ): Promise<HookTaskOutcome> {
    return new Promise((resolve) => {
      let execution: vscode.TaskExecution | undefined
      let settled = false
      let processStartSeen = false
      let processEndSeen = false
      let cancelRequested = false
      let cancelPromptTimer: NodeJS.Timeout | undefined
      let noProcessFallbackTimer: NodeJS.Timeout | undefined
      const toDispose: vscode.Disposable[] = []

      const finalize = (outcome: HookTaskOutcome) => {
        if (settled) {
          return
        }
        settled = true
        if (cancelPromptTimer) {
          clearTimeout(cancelPromptTimer)
          cancelPromptTimer = undefined
        }
        if (noProcessFallbackTimer) {
          clearTimeout(noProcessFallbackTimer)
          noProcessFallbackTimer = undefined
        }
        disposeAll(...toDispose)
        resolve(outcome)
      }

      toDispose.push(
        vscode.tasks.onDidStartTaskProcess((event) => {
          if (!execution || !isSameExecution(event.execution, execution)) {
            return
          }
          processStartSeen = true
        }),
        vscode.tasks.onDidEndTaskProcess((event) => {
          if (!execution || !isSameExecution(event.execution, execution)) {
            return
          }
          processEndSeen = true
          if (event.exitCode === undefined || cancelRequested) {
            finalize({ status: 'cancelled' })
            return
          }
          if (event.exitCode === 0) {
            finalize({ status: 'success', exitCode: 0 })
            return
          }
          finalize({ status: 'failed', exitCode: event.exitCode })
        }),
        vscode.tasks.onDidEndTask((event) => {
          if (!execution || !isSameExecution(event.execution, execution)) {
            return
          }
          if (processEndSeen) {
            return
          }
          if (processStartSeen) {
            // A process-backed task should report its final status via
            // onDidEndTaskProcess with an exit code.
            return
          }
          if (noProcessFallbackTimer) {
            clearTimeout(noProcessFallbackTimer)
          }
          noProcessFallbackTimer = setTimeout(() => {
            finalize({ status: cancelRequested ? 'cancelled' : 'success' })
          }, hookNoProcessFallbackMs)
        })
      )

      if (options.showCancelPrompt) {
        cancelPromptTimer = setTimeout(() => {
          if (settled || !execution) {
            return
          }
          vscode.window
            .showWarningMessage(
              `Hook task "${options.label}" is still running during ${options.phase}.`,
              hookContinueAnywayLabel,
              hookConfigureTaskActionLabel,
              hookCancelActionLabel
            )
            .then((choice) => {
              if (settled || !execution) {
                return
              }
              if (choice === hookContinueAnywayLabel) {
                finalize({ status: 'success' })
                return
              }
              if (choice === hookConfigureTaskActionLabel) {
                cancelRequested = true
                execution.terminate()
                finalize({ status: 'cancelled' })
                this.openWorkspaceTasksFile().catch((error) => {
                  console.warn('Failed to open tasks configuration', error)
                })
                return
              }
              if (choice === hookCancelActionLabel) {
                // Skip this hook task and continue the BoardLab task flow.
                cancelRequested = true
                execution.terminate()
                finalize({ status: 'cancelled' })
              }
            })
        }, hookCancelPromptDelayMs)
      }

      vscode.tasks.executeTask(task).then(
        (taskExecution) => {
          execution = taskExecution
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(
            `[hooks] Failed to execute task "${options.label}" during ${options.phase}: ${message}`
          )
          finalize({ status: 'skipped' })
        }
      )
    })
  }

  private withPostHooks(
    pty: vscode.Pseudoterminal,
    result: Promise<unknown>,
    params: {
      setting: HookSettingKey
      sketchPath: string
      phase: HookPhase
    }
  ): vscode.Pseudoterminal {
    const onDidWriteEmitter = new vscode.EventEmitter<string>()
    const onDidCloseEmitter = new vscode.EventEmitter<void | number>()
    const toDispose: vscode.Disposable[] = [
      onDidWriteEmitter,
      onDidCloseEmitter,
    ]
    let closed = false
    let innerClosed = false
    let postHooksStarted = false
    let postHooksDone = false
    let terminatedByUser = false
    let exitCode: number | undefined

    const finalize = (code?: number) => {
      if (closed) {
        return
      }
      closed = true
      onDidCloseEmitter.fire(code)
      disposeAll(...toDispose)
    }

    const maybeFinalize = () => {
      if (closed || !innerClosed || !postHooksDone) {
        return
      }
      finalize(exitCode)
    }

    const startPostHooks = () => {
      if (postHooksStarted) {
        return
      }
      postHooksStarted = true

      if (terminatedByUser) {
        postHooksDone = true
        maybeFinalize()
        return
      }

      this.runConfiguredHooks({
        setting: params.setting,
        sketchPath: params.sketchPath,
        phase: params.phase,
        blockOnFailure: false,
        showCancelPrompt: false,
      })
        .then((hookResult) => {
          for (const line of hookResult.output) {
            onDidWriteEmitter.fire(terminalEOL(`${line}\n`))
          }
        })
        .catch((error) => {
          console.warn(`Failed to run ${params.phase} hooks`, error)
        })
        .finally(() => {
          postHooksDone = true
          maybeFinalize()
        })
    }

    const onDidCloseDisposable = pty.onDidClose?.((code) => {
      if (typeof code === 'number') {
        exitCode = code
      }
      innerClosed = true
      startPostHooks()
      maybeFinalize()
    })
    const hasInnerCloseEvent = Boolean(onDidCloseDisposable)
    if (onDidCloseDisposable) {
      toDispose.push(onDidCloseDisposable)
    }
    toDispose.push(pty.onDidWrite((data) => onDidWriteEmitter.fire(data)))

    const settledResult = result.then(
      () => undefined,
      () => undefined
    )
    settledResult.finally(() => {
      if (!hasInnerCloseEvent) {
        innerClosed = true
      }
      startPostHooks()
      maybeFinalize()
    })

    return {
      onDidWrite: onDidWriteEmitter.event,
      onDidClose: onDidCloseEmitter.event,
      open: (dimensions) => {
        pty.open(dimensions)
      },
      close: () => {
        terminatedByUser = true
        postHooksDone = true
        pty.close()
        innerClosed = true
        maybeFinalize()
      },
      handleInput: (data) => pty.handleInput?.(data),
      setDimensions: (dimensions) => pty.setDimensions?.(dimensions),
    }
  }

  private async openWorkspaceTasksFile(): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        'workbench.action.tasks.openWorkspaceFile'
      )
    } catch {
      await vscode.commands.executeCommand(
        'workbench.action.tasks.configureTaskRunner'
      )
    }
  }

  private withPtyPreface(
    pty: vscode.Pseudoterminal,
    lines: readonly string[]
  ): vscode.Pseudoterminal {
    if (!lines.length) {
      return pty
    }

    const onDidWriteEmitter = new vscode.EventEmitter<string>()
    const onDidCloseEmitter = new vscode.EventEmitter<void | number>()
    const toDispose: vscode.Disposable[] = [
      onDidWriteEmitter,
      onDidCloseEmitter,
    ]
    let closed = false
    let prefaceEmitted = false
    let prefaceTimer: NodeJS.Timeout | undefined

    const finalize = (code?: number) => {
      if (closed) {
        return
      }
      closed = true
      if (prefaceTimer) {
        clearTimeout(prefaceTimer)
        prefaceTimer = undefined
      }
      onDidCloseEmitter.fire(code)
      disposeAll(...toDispose)
    }

    const emitPreface = () => {
      if (closed || prefaceEmitted) {
        return
      }
      prefaceEmitted = true
      if (prefaceTimer) {
        clearTimeout(prefaceTimer)
        prefaceTimer = undefined
      }
      for (const line of lines) {
        onDidWriteEmitter.fire(terminalEOL(`${line}\n`))
      }
    }

    const onDidCloseDisposable = pty.onDidClose?.((code) =>
      finalize(typeof code === 'number' ? code : undefined)
    )
    const hasInnerCloseEvent = Boolean(onDidCloseDisposable)
    if (onDidCloseDisposable) {
      toDispose.push(onDidCloseDisposable)
    }
    toDispose.push(
      pty.onDidWrite((data) => {
        emitPreface()
        onDidWriteEmitter.fire(data)
      })
    )

    return {
      onDidWrite: onDidWriteEmitter.event,
      onDidClose: onDidCloseEmitter.event,
      open: (dimensions) => {
        pty.open(dimensions)
        prefaceTimer = setTimeout(() => {
          emitPreface()
        }, hookPtyPrefaceDelayMs)
      },
      close: () => {
        pty.close()
        if (!hasInnerCloseEvent) {
          finalize()
        }
      },
      handleInput: (data) => pty.handleInput?.(data),
      setDimensions: (dimensions) => pty.setDimensions?.(dimensions),
    }
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

  private createValidationFailurePty(
    message = 'Sketch profile has validation errors. Fix issues before running tasks.'
  ): vscode.Pseudoterminal {
    const emitter = new vscode.EventEmitter<string>()
    const closeEmitter = new vscode.EventEmitter<void | number>()
    let closed = false

    const finalize = (code?: number) => {
      if (closed) {
        return
      }
      closed = true
      closeEmitter.fire(code)
      emitter.dispose()
      closeEmitter.dispose()
    }

    return {
      onDidWrite: emitter.event,
      onDidClose: closeEmitter.event,
      open: () => {
        if (closed) {
          return
        }
        emitter.fire(red(terminalEOL(`${message}\n`)))
        finalize(1)
      },
      close: () => finalize(),
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
      } else if (command === 'compile-with-debug-symbols') {
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
      const configureLabel = '$(settings) Configure current sketch'
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
          'compile-with-debug-symbols',
          `${taskCommandIcon('compile-with-debug-symbols')} Compile with Debug Symbols`,
          this.formatContextLine({
            includePort: false,
            includeProgrammer: false,
          }),
          'compile-with-debug-symbols'
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

    if (!line && options.includeSketchPath !== false) {
      return 'No sketch selected'
    }

    return line
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
    const icon = '$(boardlab-icon)'
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
    case 'compile-with-debug-symbols':
      return '$(inspect)'
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
const hookCancelPromptDelayMs = 10_000
const hookNoProcessFallbackMs = 50
const hookPtyPrefaceDelayMs = 25
const hookContinueAnywayLabel = 'Continue Anyway'
const hookConfigureTaskActionLabel = 'Configure Task'
const hookCancelActionLabel = 'Skip Hook Task'
const compileFlowCommands = new Set([
  'compile',
  'compile-with-debug-symbols',
  'export-binary',
])
const uploadFlowCommands = new Set([
  'upload',
  'upload-using-programmer',
  'burn-bootloader',
])

type HookSettingKey =
  | 'preCompileTasks'
  | 'postCompileTasks'
  | 'preUploadTasks'
  | 'postUploadTasks'

type HookPhase = 'pre-compile' | 'post-compile' | 'pre-upload' | 'post-upload'

type HookRunResult =
  | { ok: true; output: string[] }
  | { ok: false; message: string; output: string[] }

type HookTaskOutcome = {
  status: 'success' | 'failed' | 'cancelled' | 'skipped'
  exitCode?: number
}

type TaskCommand = (typeof taskKindLiterals)[number]
function isTaskCommand(arg: unknown): arg is TaskCommand {
  return (
    typeof arg === 'string' && taskKindLiterals.includes(arg as TaskCommand)
  )
}

function isWorkspaceFolderScope(
  scope: vscode.Task['scope']
): scope is vscode.WorkspaceFolder {
  return Boolean(
    scope && typeof (scope as vscode.WorkspaceFolder).uri === 'object'
  )
}

function isSameExecution(
  a: vscode.TaskExecution,
  b: vscode.TaskExecution
): boolean {
  return a === b || a.task === b.task
}

function isRecursiveBoardlabHook(
  setting: HookSettingKey,
  definition: { type?: string; command?: string }
): boolean {
  if (
    definition.type !== boardlabTaskType ||
    typeof definition.command !== 'string'
  ) {
    return false
  }
  if (setting === 'preCompileTasks' || setting === 'postCompileTasks') {
    return compileFlowCommands.has(definition.command)
  }
  if (setting === 'preUploadTasks' || setting === 'postUploadTasks') {
    return uploadFlowCommands.has(definition.command)
  }
  return false
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

interface CompileWithDebugSymbolsTaskDefinition extends CommandTaskDefinition {
  command: 'compile-with-debug-symbols'
  sketchPath: string
  fqbn: FQBN
}
function isCompileWithDebugSymbolsTaskDefinition(
  arg: unknown
): arg is CompileWithDebugSymbolsTaskDefinition {
  return (
    isCommandTaskDefinition(arg, 'compile-with-debug-symbols') &&
    (<CompileWithDebugSymbolsTaskDefinition>arg).sketchPath !== undefined &&
    typeof (<CompileWithDebugSymbolsTaskDefinition>arg).sketchPath ===
      'string' &&
    (<CompileWithDebugSymbolsTaskDefinition>arg).fqbn !== undefined &&
    typeof (<CompileWithDebugSymbolsTaskDefinition>arg).fqbn === 'string'
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
