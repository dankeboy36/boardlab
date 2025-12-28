import type { BoardListItem } from 'ardunno-cli/api'
import type { BoardIdentifier } from 'boards-list'
import Fuse from 'fuse.js'

export type BoardNameMatchKind = 'exact' | 'normalized' | 'fuzzy'

export interface BoardNameMatch {
  readonly board: BoardListItem
  readonly kind: BoardNameMatchKind
  readonly score: number
}

export function normalizeBoardName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function compactBoardName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function matchBoardByName(
  targetName: string,
  candidates: BoardListItem[],
  options: { platformId?: string; minScore?: number } = {}
): BoardNameMatch | undefined {
  const normalizedTarget = normalizeBoardName(targetName)
  if (!normalizedTarget) {
    return undefined
  }
  const compactTarget = compactBoardName(targetName)
  const minScore = options.minScore ?? 0.45
  const filtered = options.platformId
    ? candidates.filter(
        (candidate) => candidate.platform?.metadata?.id === options.platformId
      )
    : candidates

  for (const candidate of filtered) {
    const candidateName = candidate.name || ''
    const normalizedCandidate = normalizeBoardName(candidateName)
    if (!normalizedCandidate) {
      continue
    }
    if (normalizedCandidate === normalizedTarget) {
      return { board: candidate, kind: 'exact', score: 1 }
    }

    const compactCandidate = compactBoardName(candidateName)
    if (compactCandidate && compactCandidate === compactTarget) {
      return {
        board: candidate,
        kind: 'normalized',
        score: 0.95,
      }
    }
  }

  if (!filtered.length) {
    return undefined
  }

  const fuse = new Fuse(filtered, {
    keys: ['name'],
    includeScore: true,
    threshold: 0.6,
    ignoreLocation: true,
  })
  const results = fuse.search(targetName)
  if (!results.length) {
    return undefined
  }

  const best = results[0]
  const bestScore = best.score ?? 1
  const normalizedScore = Math.max(0, 1 - bestScore)
  if (normalizedScore < minScore) {
    return undefined
  }

  return {
    board: best.item,
    kind: 'fuzzy',
    score: normalizedScore,
  }
}

export function findBoardHistoryMatches(
  items: BoardIdentifier[],
  name: string
): BoardIdentifier[] {
  const normalized = normalizeBoardName(name)
  if (!normalized) {
    return []
  }
  return items.filter((item) => {
    if (!item?.name || item.fqbn) {
      return false
    }
    return normalizeBoardName(item.name) === normalized
  })
}
