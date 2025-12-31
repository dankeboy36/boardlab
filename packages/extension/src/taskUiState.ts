import type { TaskKind, TaskStatus } from './taskTracker'
import { getTaskStatus } from './taskTracker'

export interface TaskUiState {
  status: TaskStatus
  description: string
  statusIconId?: string
  stopEnabled: boolean
}

export function presentTaskStatus(
  kind: TaskKind,
  sketchPath: string | undefined,
  port: string | undefined,
  baseDescription: string | undefined
): TaskUiState {
  const status = getTaskStatus(kind, sketchPath, port)
  let description = baseDescription ?? ''
  let statusIconId: string | undefined

  switch (status) {
    case 'running':
      statusIconId = 'sync~spin'
      description = description ? `${description} — running…` : 'running…'
      break
    case 'blocked':
      statusIconId = 'circle-slash'
      description = description ? `${description} — unavailable` : 'unavailable'
      break
    case 'idle':
    default:
      description = description ?? ''
      break
  }

  return {
    status,
    description,
    statusIconId,
    stopEnabled: status === 'running',
  }
}
