import * as vscode from 'vscode'

import { terminalEOL } from './cli/arduino'
import { validateSketchProfileCommand } from './profileValidationTask'
import { disposeAll } from './utils'

const hookCancelPromptDelayMs = 10_000
const hookNoProcessFallbackMs = 50
const hookPtyPrefaceDelayMs = 25
const customHookTaskExitCodeTtlMs = 60_000
const hookContinueAnywayLabel = 'Continue Anyway'
const hookConfigureTaskActionLabel = 'Configure Task'
const hookCancelActionLabel = 'Skip Hook Task'
const hookAbortActionLabel = 'Abort'

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

export type HookSettingKey =
  | 'preCompileTasks'
  | 'postCompileTasks'
  | 'preUploadTasks'
  | 'postUploadTasks'

export type HookPhase =
  | 'pre-compile'
  | 'post-compile'
  | 'pre-upload'
  | 'post-upload'

export type HookRunResult =
  | { ok: true; output: string[] }
  | { ok: false; message: string; output: string[] }

type HookTaskOutcome = {
  status: 'success' | 'failed' | 'cancelled' | 'skipped'
  exitCode?: number
}

export type HookTaskResolver = (
  tasks: readonly vscode.Task[],
  label: string,
  sketchPath: string
) => vscode.Task | undefined

export interface TaskHooksManagerOptions {
  boardlabTaskType: string
  defaultPreCompileTaskLabels?: readonly string[]
  resolveHookTask: HookTaskResolver
  openWorkspaceTasksFile: () => Promise<void>
}

export class TaskHooksManager {
  private readonly customHookTaskExitCodes = new Map<string, number>()
  private readonly profileValidationExitCodesBySketch = new Map<
    string,
    number
  >()

  constructor(private readonly options: TaskHooksManagerOptions) {}

  recordCustomHookTaskExitCode(
    taskRunId: string | undefined,
    code: number | undefined
  ): void {
    if (!taskRunId) {
      return
    }
    this.customHookTaskExitCodes.set(
      taskRunId,
      typeof code === 'number' ? code : 0
    )
    setTimeout(() => {
      this.customHookTaskExitCodes.delete(taskRunId)
    }, customHookTaskExitCodeTtlMs)
  }

  recordProfileValidationExitCode(
    sketchPath: string,
    code: number | undefined
  ): void {
    this.profileValidationExitCodesBySketch.set(
      sketchPath,
      typeof code === 'number' ? code : 0
    )
    setTimeout(() => {
      this.profileValidationExitCodesBySketch.delete(sketchPath)
    }, customHookTaskExitCodeTtlMs)
  }

  async runConfiguredHooks(params: {
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
      const hookTask = this.options.resolveHookTask(
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
      if (
        definition &&
        this.isRecursiveBoardlabHook(params.setting, definition)
      ) {
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
          const continueLabel = runMainTaskAnywayLabel(params.phase)
          const choice = await vscode.window.showErrorMessage(
            message,
            continueLabel,
            hookConfigureTaskActionLabel,
            hookAbortActionLabel
          )
          if (choice === continueLabel) {
            output.push(
              `[hooks] ${params.phase}: continuing anyway by user request.`
            )
            continue
          }
          if (choice === hookConfigureTaskActionLabel) {
            await this.options.openWorkspaceTasksFile().catch((error) => {
              console.warn('Failed to open tasks configuration', error)
            })
          }
          return { ok: false, message, output }
        }
        vscode.window.showWarningMessage(message)
      }
    }

    return { ok: true, output }
  }

  withPostHooks(
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

  withPtyPreface(
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

  private getHookTaskLabels(setting: HookSettingKey): string[] {
    const hooksConfig = vscode.workspace.getConfiguration('boardlab.hooks')
    const raw = hooksConfig.get<unknown>(setting)
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
    if (
      setting === 'preCompileTasks' &&
      this.options.defaultPreCompileTaskLabels?.length
    ) {
      return [...this.options.defaultPreCompileTaskLabels]
    }
    return []
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
      const targetTaskIdentity = taskIdentityKey(task)
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

      const isMatchingExecution = (
        candidate: vscode.TaskExecution
      ): boolean => {
        if (execution && isSameExecution(candidate, execution)) {
          return true
        }
        return taskIdentityKey(candidate.task) === targetTaskIdentity
      }

      toDispose.push(
        vscode.tasks.onDidStartTaskProcess((event) => {
          if (!isMatchingExecution(event.execution)) {
            return
          }
          processStartSeen = true
        }),
        vscode.tasks.onDidEndTaskProcess((event) => {
          if (!isMatchingExecution(event.execution)) {
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
          if (!isMatchingExecution(event.execution)) {
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
            const customExitCode =
              this.consumeCustomHookTaskExitCode(
                execution ?? event.execution
              ) ??
              this.consumeProfileValidationHookExitCode(
                execution ?? event.execution
              )
            if (cancelRequested) {
              finalize({ status: 'cancelled' })
              return
            }
            if (typeof customExitCode === 'number' && customExitCode !== 0) {
              finalize({ status: 'failed', exitCode: customExitCode })
              return
            }
            finalize({ status: 'success', exitCode: customExitCode })
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
                this.options.openWorkspaceTasksFile().catch((error) => {
                  console.warn('Failed to open tasks configuration', error)
                })
                return
              }
              if (choice === hookCancelActionLabel) {
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

  private consumeCustomHookTaskExitCode(
    execution: vscode.TaskExecution | undefined
  ): number | undefined {
    const definition = execution?.task.definition as
      | { hookTaskRunId?: string }
      | undefined
    const taskRunId = definition?.hookTaskRunId
    if (!taskRunId) {
      return undefined
    }
    const exitCode = this.customHookTaskExitCodes.get(taskRunId)
    if (exitCode === undefined) {
      return undefined
    }
    this.customHookTaskExitCodes.delete(taskRunId)
    return exitCode
  }

  private consumeProfileValidationHookExitCode(
    execution: vscode.TaskExecution | undefined
  ): number | undefined {
    const definition = execution?.task.definition as
      | { command?: string; sketchPath?: unknown }
      | undefined
    if (definition?.command !== validateSketchProfileCommand) {
      return undefined
    }
    const sketchPath =
      typeof definition.sketchPath === 'string'
        ? definition.sketchPath
        : undefined
    if (!sketchPath) {
      return undefined
    }
    const exitCode = this.profileValidationExitCodesBySketch.get(sketchPath)
    if (exitCode === undefined) {
      return undefined
    }
    this.profileValidationExitCodesBySketch.delete(sketchPath)
    return exitCode
  }

  private isRecursiveBoardlabHook(
    setting: HookSettingKey,
    definition: { type?: string; command?: string }
  ): boolean {
    if (
      definition.type !== this.options.boardlabTaskType ||
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
}

export function createHookTaskRunId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function runMainTaskAnywayLabel(phase: HookPhase): string {
  if (phase === 'pre-upload') {
    return 'Upload Anyway'
  }
  return 'Compile Anyway'
}

function isSameExecution(
  a: vscode.TaskExecution,
  b: vscode.TaskExecution
): boolean {
  return a === b || a.task === b.task
}

function taskIdentityKey(task: vscode.Task): string {
  const definition = task.definition as Record<string, unknown> | undefined
  return [
    task.source ?? '',
    task.name ?? '',
    identityField(definition?.type),
    identityField(definition?.command),
  ].join('|')
}

function identityField(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value)
  }
  if (value === null) {
    return 'null'
  }
  return ''
}
