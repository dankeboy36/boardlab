import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type {
  BoardListItem,
  Platform,
  Board as PlatformBoard,
  PlatformMetadata,
  PlatformRelease,
} from 'ardunno-cli/api'
import { compareLoose } from 'semver'

import { normalizeBoardName } from './boardNameMatch'

interface ThirdPartyIndexItemRecord {
  readonly url?: string
  readonly normalizedUrl?: string
  readonly validationStatus?: 'accepted' | 'rejected'
}

interface ThirdPartyCatalogPlatformRecord {
  readonly url?: string
  readonly platformId?: string
  readonly name?: string
  readonly version?: string
  readonly maintainer?: string
  readonly website?: string
  readonly types?: readonly string[]
  readonly boards?: readonly string[]
  readonly deprecated?: boolean
}

interface ThirdPartyCatalogBoardRecord {
  readonly name?: string
  readonly url?: string
  readonly platformId?: string
  readonly deprecated?: boolean
}

interface ThirdPartyBoardsCatalogRecord {
  readonly platforms?: readonly ThirdPartyCatalogPlatformRecord[]
  readonly boards?: readonly ThirdPartyCatalogBoardRecord[]
}

export interface ThirdPartyIndexesResourceRecord {
  readonly items?: readonly ThirdPartyIndexItemRecord[]
  readonly platforms?: readonly ThirdPartyCatalogPlatformRecord[]
  readonly boards?: readonly ThirdPartyCatalogBoardRecord[]
  readonly catalog?: ThirdPartyBoardsCatalogRecord
}

export interface OfflineBoardCatalogPlatform {
  readonly platformId: string
  readonly packageIndexUrl: string
  readonly packageIndexUrls: readonly string[]
  readonly name: string
  readonly version: string
  readonly maintainer?: string
  readonly website?: string
  readonly types: readonly string[]
}

export interface OfflineBoardListItem extends BoardListItem {
  readonly packageIndexUrl: string
  readonly packageIndexUrls: readonly string[]
  readonly source: 'offline-catalog'
}

export interface OfflineBoardCatalog {
  readonly platforms: ReadonlyMap<string, OfflineBoardCatalogPlatform>
  readonly boards: readonly OfflineBoardListItem[]
}

export interface NormalizeOfflineBoardCatalogOptions {
  readonly includeOfficialArduinoPackageIndexes?: boolean
}

let bundledOfflineBoardCatalog: OfflineBoardCatalog | undefined
let attemptedToLoadBundledOfflineBoardCatalog = false

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const result: string[] = []
  for (const entry of value) {
    const normalized = toNonEmptyString(entry)
    if (normalized && !result.includes(normalized)) {
      result.push(normalized)
    }
  }
  return result
}

function boardsFromPlatforms(
  platforms: readonly ThirdPartyCatalogPlatformRecord[]
): ThirdPartyCatalogBoardRecord[] {
  const boards: ThirdPartyCatalogBoardRecord[] = []
  for (const platform of platforms) {
    const url = toNonEmptyString(platform.url)
    const platformId = toNonEmptyString(platform.platformId)
    if (!url || !platformId) {
      continue
    }

    for (const boardName of toStringArray(platform.boards)) {
      boards.push({
        name: boardName,
        url,
        platformId,
        deprecated: platform.deprecated === true ? true : undefined,
      })
    }
  }
  return boards
}

function isOfficialArduinoPackageIndexUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname.toLowerCase() === 'downloads.arduino.cc'
  } catch {
    return false
  }
}

function safeCompareVersions(left: string, right: string): number {
  try {
    return compareLoose(left, right)
  } catch {
    return left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  }
}

function packageIndexPreferenceScore(url: string): number {
  try {
    const parsed = new URL(url)
    let score = 0
    if (parsed.protocol === 'https:') {
      score += 100
    }
    const host = parsed.hostname.toLowerCase()
    if (host === 'raw.githubusercontent.com') {
      score -= 15
    }
    if (host === 'github.com') {
      score -= 5
    }
    if (host === 'web.archive.org') {
      score -= 30
    }
    score -= parsed.pathname.length / 1000
    return score
  } catch {
    return -100
  }
}

function comparePreferredUrls(left: string, right: string): number {
  const byScore =
    packageIndexPreferenceScore(right) - packageIndexPreferenceScore(left)
  if (byScore !== 0) {
    return byScore
  }
  return left.localeCompare(right)
}

function platformIdOf(
  board: Pick<BoardListItem, 'platform'>
): string | undefined {
  const platformId = board.platform?.metadata?.id
  return typeof platformId === 'string' && platformId.trim()
    ? platformId.trim()
    : undefined
}

function compareBoardSearchItems(
  left: BoardListItem,
  right: BoardListItem
): number {
  if (left.name !== right.name) {
    return left.name.localeCompare(right.name)
  }
  return (platformIdOf(left) || '').localeCompare(platformIdOf(right) || '')
}

function searchCandidates(
  board: Pick<BoardListItem, 'name' | 'fqbn'>
): string[] {
  const candidates = new Set<string>()
  const name = board.name?.trim() || ''
  if (name) {
    candidates.add(name.toLowerCase())
    const normalized = normalizeBoardName(name)
    if (normalized) {
      candidates.add(normalized)
    }
    for (const token of name.split(/\s+/)) {
      if (token.trim()) {
        candidates.add(token.toLowerCase())
      }
    }
  }
  const fqbn = board.fqbn?.trim() || ''
  if (fqbn) {
    candidates.add(fqbn.toLowerCase())
  }
  return Array.from(candidates)
}

function matchesSearchArgs(
  searchArgs: string,
  board: Pick<BoardListItem, 'name' | 'fqbn'>
): boolean {
  const trimmed = searchArgs.trim()
  if (!trimmed) {
    return true
  }

  const rawTokens = trimmed
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
  const normalizedTokens = normalizeBoardName(trimmed)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)

  const candidates = searchCandidates(board)
  const allTokens = Array.from(new Set([...rawTokens, ...normalizedTokens]))
  if (!allTokens.length) {
    return true
  }

  return allTokens.every((token) =>
    candidates.some((candidate) => candidate.includes(token))
  )
}

function createSyntheticPlatform(
  platform: OfflineBoardCatalogPlatform,
  boardName: string
): Platform {
  const metadata: PlatformMetadata = {
    id: platform.platformId,
    maintainer: platform.maintainer || '',
    website: platform.website || '',
    email: '',
    manuallyInstalled: false,
    deprecated: false,
    indexed: true,
  }

  const boards: PlatformBoard[] = [{ name: boardName, fqbn: '' }]
  const release: PlatformRelease = {
    name: platform.name,
    version: platform.version,
    types: [...platform.types],
    installed: false,
    boards,
    help: undefined,
    missingMetadata: false,
    deprecated: false,
    compatible: true,
  }

  return {
    metadata,
    release,
  }
}

function createOfflineBoardListItem(
  platform: OfflineBoardCatalogPlatform,
  boardName: string
): OfflineBoardListItem {
  return {
    name: boardName,
    fqbn: '',
    isHidden: false,
    platform: createSyntheticPlatform(platform, boardName),
    packageIndexUrl: platform.packageIndexUrl,
    packageIndexUrls: [...platform.packageIndexUrls],
    source: 'offline-catalog',
  }
}

function boardIdentityKey(board: BoardListItem): string {
  return `${normalizeBoardName(board.name)}\u0000${platformIdOf(board) || ''}`
}

export function isOfflineBoardListItem(
  board: unknown
): board is OfflineBoardListItem {
  return (
    typeof (board as Partial<OfflineBoardListItem>).packageIndexUrl === 'string'
  )
}

export function getOfflinePackageIndexUrl(board: unknown): string | undefined {
  return isOfflineBoardListItem(board) ? board.packageIndexUrl : undefined
}

export function normalizeOfflineBoardCatalog(
  resource: ThirdPartyIndexesResourceRecord,
  options: NormalizeOfflineBoardCatalogOptions = {}
): OfflineBoardCatalog {
  const includeOfficial = options.includeOfficialArduinoPackageIndexes === true
  const platformsSource =
    resource.platforms ?? resource.catalog?.platforms ?? []
  const boardsSource =
    resource.boards ??
    resource.catalog?.boards ??
    boardsFromPlatforms(platformsSource)

  const acceptedUrls = new Set(
    (resource.items ?? [])
      .filter((item) => item.validationStatus === 'accepted')
      .map((item) => item.normalizedUrl || item.url)
      .filter((value): value is string => typeof value === 'string' && !!value)
  )
  const enforceAcceptedUrls = acceptedUrls.size > 0

  const candidatePlatforms = new Map<string, OfflineBoardCatalogPlatform[]>()

  for (const entry of platformsSource) {
    const platformId = toNonEmptyString(entry.platformId)
    const url = toNonEmptyString(entry.url)
    const name = toNonEmptyString(entry.name)
    const version = toNonEmptyString(entry.version)

    if (!platformId || !url || !name || !version) {
      continue
    }
    if (entry.deprecated === true) {
      continue
    }
    if (!includeOfficial && isOfficialArduinoPackageIndexUrl(url)) {
      continue
    }
    if (enforceAcceptedUrls && !acceptedUrls.has(url)) {
      continue
    }

    const normalized: OfflineBoardCatalogPlatform = {
      platformId,
      packageIndexUrl: url,
      packageIndexUrls: [url],
      name,
      version,
      maintainer: toNonEmptyString(entry.maintainer),
      website: toNonEmptyString(entry.website),
      types: toStringArray(entry.types),
    }

    if (!candidatePlatforms.has(platformId)) {
      candidatePlatforms.set(platformId, [])
    }
    candidatePlatforms.get(platformId)?.push(normalized)
  }

  const platforms = new Map<string, OfflineBoardCatalogPlatform>()
  for (const [platformId, candidates] of candidatePlatforms) {
    const preferred = candidates.slice().sort((left, right) => {
      const byVersion = safeCompareVersions(right.version, left.version)
      if (byVersion !== 0) {
        return byVersion
      }
      return comparePreferredUrls(left.packageIndexUrl, right.packageIndexUrl)
    })[0]

    if (!preferred) {
      continue
    }

    const remainingUrls: string[] = Array.from(
      new Set(
        candidates
          .map((candidate) => candidate.packageIndexUrl)
          .filter((url) => url !== preferred.packageIndexUrl)
      )
    ).sort(comparePreferredUrls)
    const urls = [preferred.packageIndexUrl, ...remainingUrls]

    platforms.set(platformId, {
      ...preferred,
      packageIndexUrl: preferred.packageIndexUrl,
      packageIndexUrls: urls,
    })
  }

  const boards: OfflineBoardListItem[] = []
  const seenBoards = new Set<string>()
  for (const entry of boardsSource) {
    const name = toNonEmptyString(entry.name)
    const platformId = toNonEmptyString(entry.platformId)
    if (!name || !platformId) {
      continue
    }
    if (entry.deprecated === true) {
      continue
    }

    const platform = platforms.get(platformId)
    if (!platform) {
      continue
    }

    const key = `${normalizeBoardName(name)}\u0000${platformId}`
    if (seenBoards.has(key)) {
      continue
    }
    seenBoards.add(key)
    boards.push(createOfflineBoardListItem(platform, name))
  }

  boards.sort(compareBoardSearchItems)

  return {
    platforms,
    boards,
  }
}

export function searchOfflineBoardCatalog(
  catalog: OfflineBoardCatalog,
  searchArgs: string
): OfflineBoardListItem[] {
  const results = catalog.boards.filter((board) =>
    matchesSearchArgs(searchArgs, board)
  )
  return results.slice().sort(compareBoardSearchItems)
}

export function mergeBoardSearchResults(
  liveBoards: ReadonlyArray<BoardListItem>,
  offlineBoards: ReadonlyArray<OfflineBoardListItem>
): BoardListItem[] {
  const merged: BoardListItem[] = []
  const seen = new Set<string>()

  for (const board of liveBoards) {
    const key = boardIdentityKey(board)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    merged.push(board)
  }

  for (const board of offlineBoards) {
    const key = boardIdentityKey(board)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    merged.push(board)
  }

  merged.sort(compareBoardSearchItems)
  return merged
}

export function loadBundledOfflineBoardCatalog():
  | OfflineBoardCatalog
  | undefined {
  if (attemptedToLoadBundledOfflineBoardCatalog) {
    return bundledOfflineBoardCatalog
  }
  attemptedToLoadBundledOfflineBoardCatalog = true

  try {
    const catalogPath = [
      'third-party-platforms.json',
      'third-party-indexes.json',
    ]
      .flatMap((filename) => [
        path.resolve(__dirname, '..', 'resources', filename),
        path.resolve(__dirname, '..', '..', '..', 'resources', filename),
        path.resolve(__dirname, '..', '..', '..', '..', 'resources', filename),
      ])
      .find((candidate) => existsSync(candidate))
    if (!catalogPath) {
      throw new Error('Bundled offline boards catalog was not found')
    }
    const raw = readFileSync(catalogPath, 'utf8')
    const parsed = JSON.parse(raw) as ThirdPartyIndexesResourceRecord
    const normalized = normalizeOfflineBoardCatalog(parsed)
    bundledOfflineBoardCatalog =
      normalized.boards.length || normalized.platforms.size
        ? normalized
        : undefined
  } catch (error) {
    console.warn('Failed to load bundled offline boards catalog', error)
    bundledOfflineBoardCatalog = undefined
  }

  return bundledOfflineBoardCatalog
}
