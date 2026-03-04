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

function isDeprecatedCandidate(candidate: BoardListItem): boolean {
  return (
    candidate.platform?.metadata?.deprecated === true ||
    candidate.platform?.release?.deprecated === true
  )
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

  let exactMatch: BoardNameMatch | undefined
  let normalizedMatch: BoardNameMatch | undefined

  for (const candidate of filtered) {
    const candidateName = candidate.name || ''
    const normalizedCandidate = normalizeBoardName(candidateName)
    if (!normalizedCandidate) {
      continue
    }
    const deprecated = isDeprecatedCandidate(candidate)
    if (normalizedCandidate === normalizedTarget) {
      if (!exactMatch || (!deprecated && exactMatch.score === 0)) {
        exactMatch = {
          board: candidate,
          kind: 'exact',
          score: deprecated ? 0 : 1,
        }
      }
      continue
    }

    const compactCandidate = compactBoardName(candidateName)
    if (compactCandidate && compactCandidate === compactTarget) {
      if (!normalizedMatch || (!deprecated && normalizedMatch.score === 0)) {
        normalizedMatch = {
          board: candidate,
          kind: 'normalized',
          score: deprecated ? 0 : 0.95,
        }
      }
      continue
    }
  }

  if (exactMatch) {
    return exactMatch
  }
  if (normalizedMatch) {
    return normalizedMatch
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

  for (const best of results) {
    const bestScore = best.score ?? 1
    let normalizedScore = Math.max(0, 1 - bestScore)
    if (isDeprecatedCandidate(best.item)) {
      normalizedScore = 0
    }
    if (normalizedScore < minScore) {
      continue
    }

    return {
      board: best.item,
      kind: 'fuzzy',
      score: normalizedScore,
    }
  }

  return undefined
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
