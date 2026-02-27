import { createPortKey } from 'boards-list'
import * as vscode from 'vscode'

import type { BoardLabContext } from '../boardlabContext'
import type { BoardLabTasks } from '../tasks'
import {
  getTaskStatus,
  onDidChangeTaskStates,
  type TaskKind,
} from '../taskTracker'
import {
  defaultRuntimeState,
  type RuntimeState,
  type UploadRuntimeState,
} from './model'

function cloneRuntimeState(state: RuntimeState): RuntimeState {
  return {
    compile: {
      state: state.compile.state,
      percent: state.compile.percent,
      message: state.compile.message,
    },
    monitor: { state: state.monitor.state },
    upload: { state: state.upload.state },
  }
}

function areRuntimeStatesEqual(
  left: RuntimeState,
  right: RuntimeState
): boolean {
  return (
    left.compile.state === right.compile.state &&
    left.compile.percent === right.compile.percent &&
    left.compile.message === right.compile.message &&
    left.monitor.state === right.monitor.state &&
    left.upload.state === right.upload.state
  )
}

function toMonitorRuntimeState(
  state: string | undefined
): RuntimeState['monitor']['state'] {
  if (state === 'running') {
    return 'running'
  }
  if (state === 'suspended') {
    return 'suspended'
  }
  return 'stopped'
}

function toUploadRuntimeState(running: boolean): UploadRuntimeState {
  return running ? 'running' : 'idle'
}

export class RuntimeStateService implements vscode.Disposable {
  private readonly onDidChangeRuntimeStateEmitter =
    new vscode.EventEmitter<RuntimeState>()

  private readonly disposables: vscode.Disposable[]
  private runtimeStateValue: RuntimeState =
    cloneRuntimeState(defaultRuntimeState)

  readonly onDidChangeRuntimeState = this.onDidChangeRuntimeStateEmitter.event

  constructor(
    private readonly boardlabContext: BoardLabContext,
    private readonly tasks: BoardLabTasks
  ) {
    this.disposables = [
      this.onDidChangeRuntimeStateEmitter,
      boardlabContext.onDidChangeCurrentSketch(() => this.refresh()),
      boardlabContext.onDidChangeSketch(() => this.refresh()),
      boardlabContext.monitorManager.onDidChangeRunningMonitors(() =>
        this.refresh()
      ),
      boardlabContext.monitorManager.onDidChangeMonitorState(() =>
        this.refresh()
      ),
      onDidChangeTaskStates(() => this.refresh()),
      tasks.onDidChangeCompileProgress(() => this.refresh()),
    ]

    this.refresh()
  }

  get runtimeState(): RuntimeState {
    return this.runtimeStateValue
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose()
  }

  private refresh(): void {
    const next = this.computeState()
    if (areRuntimeStatesEqual(this.runtimeStateValue, next)) {
      return
    }
    this.runtimeStateValue = next
    this.onDidChangeRuntimeStateEmitter.fire(next)
  }

  private computeState(): RuntimeState {
    const sketch = this.boardlabContext.currentSketch
    const sketchPort = sketch?.port
    const selectedPort =
      sketchPort?.protocol && sketchPort.address
        ? {
            protocol: sketchPort.protocol,
            address: sketchPort.address,
          }
        : undefined

    const monitorState = selectedPort
      ? toMonitorRuntimeState(
          this.boardlabContext.monitorManager.getMonitorState(selectedPort)
        )
      : 'stopped'

    const sketchPath = sketch?.sketchPath
    const portKey = selectedPort ? createPortKey(selectedPort) : undefined
    const uploadKinds: TaskKind[] = [
      'upload',
      'upload-using-programmer',
      'burn-bootloader',
    ]
    const uploadRunning = uploadKinds.some(
      (kind) => getTaskStatus(kind, sketchPath, portKey) === 'running'
    )
    const compileKinds: TaskKind[] = ['compile', 'compile-with-debug-symbols']
    const compileRunning = compileKinds.some(
      (kind) => getTaskStatus(kind, sketchPath) === 'running'
    )
    const compileProgress = this.tasks.currentCompileProgress
    const currentCompileProgress =
      compileProgress && compileProgress.sketchPath === sketchPath
        ? compileProgress
        : undefined

    return {
      compile: {
        state:
          compileRunning || Boolean(currentCompileProgress)
            ? 'running'
            : 'idle',
        percent: currentCompileProgress?.percent,
        message: currentCompileProgress?.message,
      },
      monitor: { state: monitorState },
      upload: { state: toUploadRuntimeState(uploadRunning) },
    }
  }
}
