import * as vscode from 'vscode'

import type { PortQName } from './cli/arduino'

export const taskKindLiterals = [
  'compile',
  'upload',
  'burn-bootloader',
  'export-binary',
  'archive-sketch',
  'upload-using-programmer',
  'compile-with-debug-symbols',
  'get-board-info',
] as const
export type TaskKind = (typeof taskKindLiterals)[number]
export type TaskStatus = 'idle' | 'running' | 'blocked'

type TaskKey = string

interface TaskState {
  kind: TaskKind
  execution?: vscode.TaskExecution
}

const states = new Map<TaskKey, TaskState>()
const didChangeStates = new vscode.EventEmitter<TaskStateChange>()

export type TaskStateChange = {
  kind: TaskKind
  sketchPath?: string
  port?: PortQName
  status: TaskStatus
}

export const onDidChangeTaskStates: vscode.Event<TaskStateChange> =
  didChangeStates.event

export function computeTaskKey(
  kind: TaskKind,
  sketchPath?: string,
  port?: PortQName
): TaskKey | undefined {
  switch (kind) {
    case 'compile':
    case 'export-binary':
      return sketchPath ? `build:${sketchPath}` : undefined
    case 'archive-sketch':
      return sketchPath ? `archive:${sketchPath}` : undefined
    case 'upload':
    case 'upload-using-programmer':
    case 'burn-bootloader':
      return port ? `upload:${port}` : undefined
    case 'get-board-info':
      return sketchPath ? `${kind}:${sketchPath}` : undefined
    default:
      return undefined
  }
}

export function getTaskStatus(
  kind: TaskKind,
  sketchPath?: string,
  port?: PortQName
): TaskStatus {
  const key = computeTaskKey(kind, sketchPath, port)
  if (!key) return 'idle'
  const state = states.get(key)
  if (!state) return 'idle'
  // Only the task kind that owns this key is considered "running".
  // Other kinds that share the same key (e.g. export-binary vs compile)
  // are reported as "blocked".
  return state.kind === kind ? 'running' : 'blocked'
}

export function markTaskRunning(
  kind: TaskKind,
  sketchPath: string | undefined,
  port: PortQName | undefined,
  execution: vscode.TaskExecution
): void {
  const key = computeTaskKey(kind, sketchPath, port)
  if (!key) return
  states.set(key, { kind, execution })
  didChangeStates.fire({ kind, sketchPath, port, status: 'running' })
}

export function markTaskFinished(
  kind: TaskKind,
  sketchPath: string | undefined,
  port: PortQName | undefined,
  succeeded: boolean
): void {
  const key = computeTaskKey(kind, sketchPath, port)
  if (!key) return
  // Once a task finishes (successfully or not), we consider the key idle
  // and remove it from the tracking map.
  states.delete(key)
  didChangeStates.fire({ kind, sketchPath, port, status: 'idle' })
}

export async function tryStopTask(
  kind: TaskKind,
  sketchPath?: string,
  port?: PortQName
): Promise<void> {
  const key = computeTaskKey(kind, sketchPath, port)
  if (!key) return
  const state = states.get(key)
  state?.execution?.terminate()
}
