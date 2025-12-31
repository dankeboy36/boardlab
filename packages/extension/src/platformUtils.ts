import { FQBN } from 'fqbn'
import type { BoardIdentifier } from 'boards-list'
import type { BoardDetails } from 'vscode-arduino-api'

import type { PlatformInfo } from './platformMissing'

// TODO: use CLI error codes if possible instead of parsing the error message
const PLATFORM_NOT_FOUND_RE = /Platform '([^']+)' not found/i
const PLATFORM_NOT_INSTALLED_RE = /platform not installed/i

export function platformIdFromFqbn(fqbn?: string): string | undefined {
  if (!fqbn) {
    return undefined
  }
  try {
    const parsed = new FQBN(fqbn)
    if (!parsed.vendor || !parsed.arch) {
      return undefined
    }
    return `${parsed.vendor}:${parsed.arch}`
  } catch {
    return undefined
  }
}

export function matchesPlatformId(
  fqbn: string | undefined,
  platformId: string
): boolean {
  return platformIdFromFqbn(fqbn) === platformId
}

export function extractPlatformIdFromError(error: unknown): string | undefined {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : ''
  const match = message.match(PLATFORM_NOT_FOUND_RE)
  return match?.[1]
}

export function isPlatformNotInstalledError(error: unknown): boolean {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : ''
  return (
    PLATFORM_NOT_FOUND_RE.test(message) ||
    PLATFORM_NOT_INSTALLED_RE.test(message)
  )
}

export function toUnresolvedBoard(
  board: BoardIdentifier | BoardDetails,
  platform?: PlatformInfo
): BoardIdentifier {
  const unresolved: BoardIdentifier = {
    name: board.name,
    fqbn: undefined,
  }
  if (platform?.id || platform?.name || platform?.version) {
    ;(unresolved as any).platform = {
      metadata: platform?.id ? { id: platform.id } : undefined,
      release:
        platform?.name || platform?.version
          ? { name: platform?.name, version: platform?.version }
          : undefined,
    }
  }
  return unresolved
}

export function collectHistoryUpdates(
  items: BoardIdentifier[],
  platformId: string
): { remove: BoardIdentifier[]; add: BoardIdentifier[] } {
  const remove: BoardIdentifier[] = []
  const addByName = new Map<string, BoardIdentifier>()

  for (const item of items) {
    if (!item?.fqbn) {
      continue
    }
    if (!matchesPlatformId(item.fqbn, platformId)) {
      continue
    }
    remove.push(item)
    if (item.name && !addByName.has(item.name)) {
      addByName.set(item.name, { name: item.name, fqbn: undefined })
    }
  }

  return { remove, add: Array.from(addByName.values()) }
}
