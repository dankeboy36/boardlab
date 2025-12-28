import type { BoardIdentifier } from 'boards-list'
import type { BoardDetails } from 'vscode-arduino-api'

import { PlatformNotInstalledError } from './boards'

export type PlatformMissingReason = 'platform' | 'fqbn' | 'unresolved'

export interface PlatformInfo {
  readonly id?: string
  readonly name?: string
  readonly version?: string
}

export type PlatformRequirement = Required<PlatformInfo>

export function isPlatformRequirement(
  platform?: PlatformInfo
): platform is PlatformRequirement {
  return Boolean(platform?.id && platform?.name && platform?.version)
}

export interface PlatformMissingState {
  readonly reason: PlatformMissingReason
  readonly boardName?: string
  readonly fqbn?: string
  readonly platform?: PlatformInfo
}

export function isBoardDetailsLike(
  board: BoardIdentifier | BoardDetails
): board is BoardDetails {
  return (board as BoardDetails).configOptions !== undefined
}

export function extractPlatformInfo(
  board: BoardIdentifier | BoardDetails
): PlatformInfo | undefined {
  const platform = (board as any)?.platform
  const metadataId = platform?.metadata?.id
  const release = platform?.release
  const name = release?.name ?? platform?.name
  const version = release?.version
  if (!metadataId && !name && !version) {
    return undefined
  }
  return { id: metadataId, name, version }
}

export function getPlatformRequirement(
  board: BoardIdentifier | BoardDetails
): PlatformRequirement | undefined {
  const platform = extractPlatformInfo(board)
  if (!isPlatformRequirement(platform)) {
    return undefined
  }
  return platform
}

export async function resolvePlatformMissingState(
  board: BoardIdentifier | BoardDetails | undefined,
  resolveBoardDetails: (fqbn: string) => Promise<unknown>
): Promise<PlatformMissingState | undefined> {
  if (!board) {
    return undefined
  }
  if (isBoardDetailsLike(board)) {
    return undefined
  }

  const boardName = (board as any)?.name
  const fqbn = (board as any)?.fqbn
  const platform = extractPlatformInfo(board)

  if (!fqbn) {
    return { reason: 'fqbn', boardName, platform }
  }

  try {
    await resolveBoardDetails(fqbn)
    return undefined
  } catch (err) {
    if (err instanceof PlatformNotInstalledError) {
      return { reason: 'platform', boardName, fqbn, platform }
    }
    return { reason: 'unresolved', boardName, fqbn, platform }
  }
}

export function formatPlatformMissingTooltip(
  state: PlatformMissingState
): string {
  const label = formatPlatformLabel(state.platform)
  if (label) {
    return `The selected board requires platform '${label}'. Click to install or change board.`
  }
  if (state.reason === 'fqbn') {
    return 'The selected board does not provide an FQBN. Click to change board.'
  }
  return 'The selected board platform could not be resolved. Click to install or change board.'
}

function formatPlatformLabel(platform?: PlatformInfo): string | undefined {
  if (!platform) {
    return undefined
  }
  const name = platform.name?.trim()
  const id = platform.id?.trim()
  if (name && id) {
    return `${name} (${id})`
  }
  return name || id
}
