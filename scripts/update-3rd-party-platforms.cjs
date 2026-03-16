// @ts-check
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, execFileSync, execFile } = require('node:child_process')
const { promisify } = require('node:util')

const semver = require('semver')
const { getTool } = require('get-arduino-tools')
const prettier = require('prettier')

const DEFAULT_USER_AGENT = 'boardlab/update-3rd-party-platforms'
const DEFAULT_CLI_VERSION = process.env.BOARDLAB_ARDUINO_CLI_VERSION || '1.4.1'
const CLI_CACHE_ROOT = path.resolve(
  __dirname,
  '..',
  '.cache',
  'arduino-tools',
  'arduino-cli'
)
const CLI_OUTPUT_LIMIT = 32 * 1024 * 1024
const execFileAsync = promisify(execFile)

/**
 * @param {readonly string[]} args
 * @param {import('child_process').ExecFileSyncOptionsWithStringEncoding
 *   | undefined} [options]
 */
function runGit(args, options) {
  return execFileSync('git', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...options,
  })
}

/**
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ text: string; contentType?: string; finalUrl: string }>}
 */
async function fetchTextResponse(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': DEFAULT_USER_AGENT,
        accept: 'application/json, text/plain, text/tsv, text/markdown, */*',
      },
      redirect: 'follow',
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(
        `HTTP ${res.status} fetching ${url}\n${String(body).slice(0, 500)}`
      )
    }

    return {
      text: await res.text(),
      contentType: res.headers.get('content-type') || undefined,
      finalUrl: res.url || url,
    }
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'name' in err &&
      err.name === 'AbortError'
    ) {
      throw new Error(`Timeout after ${timeoutMs}ms fetching ${url}`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
async function fetchText(url, opts = {}) {
  const { text } = await fetchTextResponse(url, opts)
  return text
}

/**
 * Extract candidate package index URLs from arbitrary text.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractPackageIndexUrls(text) {
  const re = /https?:\/\/[^\s)\]}>"']*package[^\s)\]}>"']*\.json/gi
  const matches = text.match(re)
  return matches || []
}

/**
 * Normalize URL for dedupe.
 *
 * @param {string} raw
 * @returns {string | undefined}
 */
function normalizeUrl(raw) {
  if (!raw) return undefined
  let s = String(raw).trim()
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1)
  s = s.replace(/[)\],.;>]+$/g, '')
  if (!/^https?:\/\//i.test(s)) return undefined
  if (!/\.json$/i.test(s)) return undefined
  if (!/package/i.test(s)) return undefined

  try {
    const u = new URL(s)
    u.protocol = u.protocol.toLowerCase()
    u.hostname = u.hostname.toLowerCase()
    return u.toString()
  } catch {
    return undefined
  }
}

/**
 * Best-effort derive a human-friendly label from a package index URL.
 *
 * @param {string} normalizedUrl
 * @returns {string | undefined}
 */
function deriveLabel(normalizedUrl) {
  try {
    const u = new URL(normalizedUrl)
    const file = path.basename(u.pathname)
    const m = /^package[_-]?(.+?)[_-]?index\.json$/i.exec(file)
    if (m && m[1]) {
      return m[1]
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
    }

    let host = u.hostname.replace(/^www\./i, '')
    const parts = host.split('.')
    if (parts.length >= 2) {
      host = parts[parts.length - 2]
    }
    return host.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  } catch {
    return undefined
  }
}

/**
 * Parse the Arduino wiki markdown list. Captures entries like:
 *
 * - **Espressif ESP32**: https://.../package_esp32_index.json
 * - **AirMCU** [https://...](https://...) or [https://...](https://...)
 *
 * Also captures a best-effort note from the first indented sub-bullet.
 *
 * @param {string} markdown
 * @returns {{ label: string; url: string; note?: string }[]}
 */
function parseArduinoWikiEntries(markdown) {
  /** @type {{ label: string; url: string; note?: string }[]} */
  const entries = []
  const lines = markdown.split(/\r?\n/)

  const isTop = (/** @type {string} */ line) => /^\*\s+\*\*[^*]+\*\*/.test(line)

  const extractUrlsFromLine = (/** @type {string} */ line) => {
    /** @type {string[]} */
    const urls = []

    for (const m of line.matchAll(/<\s*(https?:\/\/[^\s>]+)\s*>/g)) {
      urls.push(m[1])
    }

    for (const m of line.matchAll(/\bhttps?:\/\/[^\s)\]]+/g)) {
      urls.push(m[0])
    }

    return Array.from(new Set(urls))
  }

  const cleanNote = (/** @type {string} */ line) =>
    line
      .replace(/^\s*\*\s*/, '')
      .replace(/^\s*-\s*/, '')
      .trim()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!isTop(line)) continue

    const bold = /\*\*([^*]+)\*\*/.exec(line)
    const label = (bold && bold[1] ? bold[1].trim() : '').trim()
    if (!label) continue

    const urls = extractUrlsFromLine(line)
    if (!urls.length) continue

    /** @type {string | undefined} */
    let note
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      if (isTop(next)) break
      if (!next.trim()) break

      if (/^\s{2,}\*\s+/.test(next)) {
        const candidate = cleanNote(next)
        if (candidate) {
          note = candidate
          break
        }
      }
    }

    for (const url of urls) {
      entries.push(note ? { label, url, note } : { label, url })
    }
  }

  return entries
}

/**
 * @typedef {{
 *   url: string
 *   normalizedUrl: string
 *   provenance: string[]
 *   label?: string
 *   note?: string
 *   validationStatus?: 'accepted' | 'rejected'
 *   validationMessage?: string
 *   platformCount?: number
 *   boardCount?: number
 * }} ThirdPartyIndexItem
 */

/**
 * @typedef {{
 *   normalizedUrl: string
 *   payload: Record<string, unknown>
 * }} PackageIndexDocument
 */

/**
 * @typedef {{
 *   url: string
 *   platformId: string
 *   packageName: string
 *   architecture: string
 *   name: string
 *   version: string
 *   maintainer?: string
 *   website?: string
 *   deprecated: boolean
 *   types: string[]
 *   boards: string[]
 * }} CatalogPlatform
 */

/**
 * @typedef {{
 *   name: string
 *   fqbn?: string
 *   boardId?: string
 *   url: string
 *   platformId: string
 *   platformName: string
 *   platformVersion: string
 *   deprecated: boolean
 * }} CatalogBoard
 */

/**
 * @typedef {{
 *   name: string
 *   platformId: string
 *   url: string
 * }} CatalogPlatformRef
 */

/**
 * @typedef {{
 *   name: string
 *   platformId: string
 *   url: string
 *   platformName?: string
 * }} CatalogBoardRef
 */

/**
 * @typedef {{
 *   platforms: CatalogPlatform[]
 *   boards: CatalogBoard[]
 * }} CatalogData
 */

/**
 * @typedef {{
 *   catalog: CatalogData
 *   dropped: {
 *     deprecatedPlatforms: CatalogPlatformRef[]
 *     deprecatedBoards: CatalogBoardRef[]
 *     noisyBoards: CatalogBoardRef[]
 *     platformsDroppedBecauseNoBoards: CatalogPlatformRef[]
 *   }
 * }} CatalogPruneResult
 */

/**
 * @typedef {{
 *   metadata?: {
 *     id?: string
 *   }
 * }} CliBoardPlatform
 */

/**
 * @typedef {{
 *   name?: string
 *   fqbn?: string
 *   platform?: CliBoardPlatform
 * }} CliBoardEntry
 */

/**
 * @typedef {{
 *   cliPath: string
 *   cliConfigPath: string
 *   dataDirPath: string
 *   userDirPath: string
 * }} CliEnv
 */

/**
 * @param {string | undefined} text
 * @returns {any}
 */
function tryParseJson(text) {
  if (!text || !text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeBoardName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * @param {string} value
 * @returns {string}
 */
function compactBoardName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isOfficialArduinoIndexUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.hostname.toLowerCase() === 'downloads.arduino.cc'
  } catch {
    return false
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasDeprecatedCatalogMarker(value) {
  return (
    typeof value === 'string' &&
    /(?:\bdeprecated\b|\buse\b[\s\S]{0,120}?\binstead\b|\bknown\s+issues?\b|\b(?:bugfix|critical|bugs|broken)\b|\bno\s+good\b|\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b|<\s*\/?\s*[a-z][^>]*>|&(?:[a-z][a-z0-9]+|#\d+|#x[0-9a-f]+);)/i.test(
      value
    )
  )
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNoisyBoardName(value) {
  if (typeof value !== 'string') {
    return false
  }

  const noisyPatterns = [
    /\bprogram\s+via\b/i,
    /\bwindows\s+users?\b/i,
    /\bif\s+win(?:dows)?\b/i,
    /\bpost_install\.bat\b/i,
    /\brelease\s+notes?\b/i,
    /\bsupported\s+updi\b/i,
    /\busb\s*\(micronucleus\)\s*(?:support|boards?)\b/i,
    /\bserial\s+bootloader\b.*\bsupported\s+only\b/i,
    /\bnot\s+supported\b.*\btoolchain\b/i,
    /\btoolchain\b.*\bnot\s+supported\b/i,
    /\bdoes(?:\s+not|n't)\s+(?:install|work)\b/i,
    /\bfor\s+reasons?\s+i\s+don't\s+understand\b/i,
    /\battention!?[\s:]/i,
    /^\s*if\s+.*\bdrivers?\b.*\binstall\b/i,
    /^(?:\s*(?:ATtiny|AVR)[A-Za-z0-9/]+(?:\s*,\s*(?:ATtiny|AVR)[A-Za-z0-9/]+){2,}\s*)$/i,
    /\([tT]\d+[a-z]?(?:\s*,\s*[tT]\d+[a-z]?)+\)/,
  ]
  return noisyPatterns.some((pattern) => pattern.test(value))
}

/**
 * @param {string} name
 * @param {boolean} deprecatedFlag
 * @returns {boolean}
 */
function isDeprecatedPlatform(name, deprecatedFlag) {
  return deprecatedFlag || hasDeprecatedCatalogMarker(name)
}

/**
 * @param {string} name
 * @param {boolean} deprecatedFlag
 * @param {boolean} platformDeprecated
 * @returns {boolean}
 */
function isDeprecatedBoard(name, deprecatedFlag, platformDeprecated) {
  return (
    platformDeprecated || deprecatedFlag || hasDeprecatedCatalogMarker(name)
  )
}

/**
 * @param {string | undefined} left
 * @param {string | undefined} right
 * @returns {number}
 */
function compareVersionStrings(left, right) {
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1

  try {
    return semver.compareLoose(left, right)
  } catch {
    return left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  }
}

/**
 * @param {string | undefined} fqbn
 * @returns {string | undefined}
 */
function boardIdFromFqbn(fqbn) {
  if (!fqbn) return undefined
  const parts = fqbn.split(':')
  return parts[2]
}

/**
 * @param {string} text
 * @param {number} [maxLength]
 * @returns {string}
 */
function summarizeTextSnippet(text, maxLength = 96) {
  const compact = String(text).replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) {
    return compact
  }
  return `${compact.slice(0, maxLength)}...`
}

/**
 * @param {string | undefined} contentType
 * @returns {'json' | 'non-json' | 'unknown'}
 */
function classifyContentType(contentType) {
  if (!contentType) return 'unknown'
  const normalized = contentType.toLowerCase()
  if (
    normalized.includes('/json') ||
    normalized.includes('+json') ||
    normalized.includes('javascript')
  ) {
    return 'json'
  }
  if (
    normalized.includes('html') ||
    normalized.includes('xml') ||
    normalized.includes('image/')
  ) {
    return 'non-json'
  }
  return 'unknown'
}

/**
 * @param {string} url
 * @returns {string}
 */
function packageIndexBasename(url) {
  try {
    return path.basename(new URL(url).pathname)
  } catch {
    return path.basename(url)
  }
}

/**
 * @param {CatalogPlatform} left
 * @param {CatalogPlatform} right
 * @returns {number}
 */
function compareCatalogPlatforms(left, right) {
  const byUrl = left.url.localeCompare(right.url)
  if (byUrl !== 0) return byUrl
  return left.platformId.localeCompare(right.platformId)
}

/**
 * @param {CatalogBoard} left
 * @param {CatalogBoard} right
 * @returns {number}
 */
function compareCatalogBoards(left, right) {
  const byUrl = left.url.localeCompare(right.url)
  if (byUrl !== 0) return byUrl
  const byPlatform = left.platformId.localeCompare(right.platformId)
  if (byPlatform !== 0) return byPlatform
  return left.name.localeCompare(right.name)
}

/**
 * @param {CatalogData} catalog
 * @returns {CatalogPruneResult}
 */
function pruneCatalogForOutput(catalog) {
  /** @type {CatalogPruneResult['dropped']} */
  const dropped = {
    deprecatedPlatforms: [],
    deprecatedBoards: [],
    noisyBoards: [],
    platformsDroppedBecauseNoBoards: [],
  }

  /**
   * @param {string} url
   * @param {string} platformId
   * @returns {string}
   */
  const platformKeyOf = (url, platformId) => `${url}\u0000${platformId}`

  /** @type {Map<string, CatalogPlatform>} */
  const keptPlatformsByKey = new Map()
  for (const platform of catalog.platforms) {
    const platformDeprecated = isDeprecatedPlatform(
      platform.name,
      platform.deprecated === true
    )
    const key = platformKeyOf(platform.url, platform.platformId)
    if (platformDeprecated) {
      dropped.deprecatedPlatforms.push({
        name: platform.name,
        platformId: platform.platformId,
        url: platform.url,
      })
      continue
    }
    keptPlatformsByKey.set(key, {
      ...platform,
      deprecated: false,
      boards: [],
    })
  }

  /** @type {Map<string, string[]>} */
  const boardNamesByPlatformKey = new Map()
  /** @type {CatalogBoard[]} */
  const keptBoards = []
  const seenBoardKeys = new Set()
  for (const board of catalog.boards) {
    const platformKey = platformKeyOf(board.url, board.platformId)
    if (!keptPlatformsByKey.has(platformKey)) {
      continue
    }

    if (isNoisyBoardName(board.name)) {
      dropped.noisyBoards.push({
        name: board.name,
        platformId: board.platformId,
        url: board.url,
        platformName: board.platformName,
      })
      continue
    }

    if (isDeprecatedBoard(board.name, board.deprecated === true, false)) {
      dropped.deprecatedBoards.push({
        name: board.name,
        platformId: board.platformId,
        url: board.url,
        platformName: board.platformName,
      })
      continue
    }

    const boardKey = `${platformKey}\u0000${compactBoardName(board.name)}`
    if (seenBoardKeys.has(boardKey)) {
      continue
    }
    seenBoardKeys.add(boardKey)

    keptBoards.push({
      ...board,
      deprecated: false,
    })
    if (!boardNamesByPlatformKey.has(platformKey)) {
      boardNamesByPlatformKey.set(platformKey, [])
    }
    const names = boardNamesByPlatformKey.get(platformKey) || []
    if (!names.includes(board.name)) {
      names.push(board.name)
    }
  }

  /** @type {CatalogPlatform[]} */
  const finalPlatforms = []
  for (const platform of keptPlatformsByKey.values()) {
    const key = platformKeyOf(platform.url, platform.platformId)
    const boardNames = boardNamesByPlatformKey.get(key) || []
    if (!boardNames.length) {
      dropped.platformsDroppedBecauseNoBoards.push({
        name: platform.name,
        platformId: platform.platformId,
        url: platform.url,
      })
      continue
    }
    finalPlatforms.push({
      ...platform,
      boards: boardNames,
    })
  }

  const finalPlatformKeys = new Set(
    finalPlatforms.map((platform) =>
      platformKeyOf(platform.url, platform.platformId)
    )
  )
  const finalBoards = keptBoards.filter((board) =>
    finalPlatformKeys.has(platformKeyOf(board.url, board.platformId))
  )

  const comparePlatformRefs = (
    /** @type {{ url: string; platformId: string; name: string }} */ left,
    /** @type {{ url: string; platformId: string; name: string }} */ right
  ) => {
    const byUrl = left.url.localeCompare(right.url)
    if (byUrl !== 0) return byUrl
    const byId = left.platformId.localeCompare(right.platformId)
    if (byId !== 0) return byId
    return left.name.localeCompare(right.name)
  }
  const compareBoardRefs = (
    /** @type {{ url: string; platformId: string; name: string }} */ left,
    /** @type {{ url: string; platformId: string; name: string }} */ right
  ) => {
    const byUrl = left.url.localeCompare(right.url)
    if (byUrl !== 0) return byUrl
    const byId = left.platformId.localeCompare(right.platformId)
    if (byId !== 0) return byId
    return left.name.localeCompare(right.name)
  }

  dropped.deprecatedPlatforms.sort(comparePlatformRefs)
  dropped.deprecatedBoards.sort(compareBoardRefs)
  dropped.noisyBoards.sort(compareBoardRefs)
  dropped.platformsDroppedBecauseNoBoards.sort(comparePlatformRefs)

  return {
    catalog: {
      platforms: finalPlatforms.sort(compareCatalogPlatforms),
      boards: finalBoards.sort(compareCatalogBoards),
    },
    dropped,
  }
}

/**
 * @param {CatalogData} catalog
 * @returns {{ platforms: CatalogPlatform[] }}
 */
function toPlatformOnlyCatalogPayload(catalog) {
  return {
    platforms: catalog.platforms,
  }
}

/**
 * @param {string} cliPath
 * @param {string[]} args
 * @param {{ allowFailure?: boolean }} [options]
 * @returns {{
 *   status: number
 *   stdout: string
 *   stderr: string
 *   args: string[]
 * }}
 */
function runCli(cliPath, args, options = {}) {
  const result = spawnSync(cliPath, args, {
    encoding: 'utf8',
    maxBuffer: CLI_OUTPUT_LIMIT,
  })

  if (result.error) {
    throw result.error
  }

  const stdout = result.stdout || ''
  const stderr = result.stderr || ''
  const status = typeof result.status === 'number' ? result.status : 0
  if (!options.allowFailure && status !== 0) {
    const lines = [
      `arduino-cli failed with exit code ${status}`,
      `Command: ${cliPath} ${args.join(' ')}`,
    ]
    if (stdout.trim()) {
      lines.push(`stdout:\n${stdout.trim()}`)
    }
    if (stderr.trim()) {
      lines.push(`stderr:\n${stderr.trim()}`)
    }
    throw new Error(lines.join('\n'))
  }

  return { status, stdout, stderr, args: args.slice() }
}

/**
 * @param {string} cliPath
 * @param {string} cliConfigPath
 * @param {string} configKey
 * @param {string[]} values
 * @returns {void}
 */
function setCliConfig(cliPath, cliConfigPath, configKey, values) {
  if (!values.length) return
  runCli(cliPath, [
    'config',
    'set',
    configKey,
    ...values,
    '--config-file',
    cliConfigPath,
  ])
}

/**
 * @param {string} cliPath
 * @param {string} rootDir
 * @param {string} name
 * @returns {CliEnv}
 */
function createCliEnv(cliPath, rootDir, name) {
  const envDir = path.join(rootDir, name)
  const cliConfigPath = path.join(envDir, 'arduino-cli.yaml')
  const dataDirPath = path.join(envDir, 'Arduino15')
  const userDirPath = path.join(envDir, 'Arduino')

  fs.mkdirSync(envDir, { recursive: true })
  fs.mkdirSync(dataDirPath, { recursive: true })
  fs.mkdirSync(userDirPath, { recursive: true })

  runCli(cliPath, ['config', 'init', '--dest-file', cliConfigPath])
  setCliConfig(cliPath, cliConfigPath, 'directories.data', [dataDirPath])
  setCliConfig(cliPath, cliConfigPath, 'directories.user', [userDirPath])

  return {
    cliPath,
    cliConfigPath,
    dataDirPath,
    userDirPath,
  }
}

/**
 * @param {string} cliPath
 * @param {string | undefined} version
 * @returns {Promise<string>}
 */
async function resolveArduinoCliPath(cliPath, version) {
  if (cliPath) {
    return path.resolve(cliPath)
  }

  const basename = `arduino-cli${process.platform === 'win32' ? '.exe' : ''}`
  const localPath = path.join(CLI_CACHE_ROOT, version || 'latest', basename)
  if (fs.existsSync(localPath)) {
    return localPath
  }

  fs.mkdirSync(path.dirname(localPath), { recursive: true })

  const { toolPath } = await getTool({
    tool: 'arduino-cli',
    version,
    destinationFolderPath: path.dirname(localPath),
    okIfExists: true,
  })
  return toolPath
}

/**
 * @param {string} cliPath
 * @returns {{ version?: string; raw?: unknown }}
 */
function getCliVersionInfo(cliPath) {
  const result = runCli(cliPath, ['version', '--format', 'json'], {
    allowFailure: true,
  })
  const parsed = tryParseJson(result.stdout)
  if (!parsed || typeof parsed !== 'object') {
    return {}
  }
  const version =
    typeof parsed.VersionString === 'string'
      ? parsed.VersionString
      : typeof parsed.version === 'string'
        ? parsed.version
        : undefined
  return { version, raw: parsed }
}

/**
 * @param {{
 *   stdout: string
 *   stderr: string
 * }} runResult
 * @param {readonly ThirdPartyIndexItem[]} knownItems
 * @returns {Map<string, string>}
 */
function collectRejectedUrls(runResult, knownItems) {
  const known = new Set(knownItems.map((item) => item.normalizedUrl))
  /** @type {Map<string, string[]>} */
  const urlsByBasename = new Map()
  for (const item of knownItems) {
    const basename = packageIndexBasename(item.normalizedUrl)
    if (!urlsByBasename.has(basename)) {
      urlsByBasename.set(basename, [])
    }
    urlsByBasename.get(basename)?.push(item.normalizedUrl)
  }

  /** @type {Map<string, string>} */
  const rejected = new Map()
  const lines = `${runResult.stdout || ''}\n${runResult.stderr || ''}`.split(
    /\r?\n/
  )

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    const lower = line.toLowerCase()
    const looksLikeIssue =
      /warn|error|fail|invalid|timeout|timed out|skip|ignore|unreachable|404|not found/.test(
        lower
      )
    if (!looksLikeIssue) {
      continue
    }

    const extracted = extractPackageIndexUrls(line)
    for (const maybeUrl of extracted) {
      const normalized = normalizeUrl(maybeUrl)
      if (!normalized || !known.has(normalized) || rejected.has(normalized)) {
        continue
      }
      rejected.set(normalized, line)
    }

    for (const match of line.matchAll(/package[^\\/'":\s]*\.json/gi)) {
      const basename = match[0]
      const candidates = urlsByBasename.get(basename)
      if (!candidates || candidates.length !== 1) {
        continue
      }
      const normalized = candidates[0]
      if (!rejected.has(normalized)) {
        rejected.set(normalized, line)
      }
    }
  }

  return rejected
}

/**
 * @param {string} cliPath
 * @param {string} cliConfigPath
 * @returns {{
 *   command?: string
 *   boards: Record<string, unknown>[]
 * }}
 */
function loadCliBoardList(cliPath, cliConfigPath) {
  /** @type {string[][]} */
  const commands = [
    ['board', 'listall', '--format', 'json', '--config-file', cliConfigPath],
    ['board', 'search', '--format', 'json', '--config-file', cliConfigPath],
  ]

  for (const args of commands) {
    const result = runCli(cliPath, args, { allowFailure: true })
    if (result.status !== 0) {
      continue
    }

    const parsed = tryParseJson(result.stdout)
    if (Array.isArray(parsed)) {
      return { command: `${args[0]} ${args[1]}`, boards: parsed }
    }
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.boards)) {
        return { command: `${args[0]} ${args[1]}`, boards: parsed.boards }
      }
      if (Array.isArray(parsed.items)) {
        return { command: `${args[0]} ${args[1]}`, boards: parsed.items }
      }
    }
  }

  return { boards: [] }
}

/**
 * @param {ThirdPartyIndexItem[]} items
 * @returns {Promise<{
 *   documents: PackageIndexDocument[]
 *   rejectedByUrl: Map<string, string>
 * }>}
 */
async function loadPackageIndexDocuments(items) {
  /** @type {PackageIndexDocument[]} */
  const documents = []
  /** @type {Map<string, string>} */
  const rejectedByUrl = new Map()

  for (const item of items) {
    try {
      const response = await fetchTextResponse(item.normalizedUrl, {
        timeoutMs: 45_000,
      })
      const contentTypeKind = classifyContentType(response.contentType)
      if (contentTypeKind === 'non-json') {
        rejectedByUrl.set(
          item.normalizedUrl,
          `Non-JSON response (${response.contentType || 'unknown content-type'}) while fetching ${item.normalizedUrl}: ${summarizeTextSnippet(response.text)}`
        )
        continue
      }

      const parsed = tryParseJson(response.text)
      if (!parsed || typeof parsed !== 'object') {
        rejectedByUrl.set(
          item.normalizedUrl,
          `Invalid JSON payload while fetching ${item.normalizedUrl}: ${summarizeTextSnippet(response.text)}`
        )
        continue
      }
      if (!Array.isArray(parsed.packages)) {
        rejectedByUrl.set(
          item.normalizedUrl,
          `JSON payload is not an Arduino package index (missing top-level 'packages' array) at ${item.normalizedUrl}`
        )
        continue
      }

      documents.push({
        normalizedUrl: item.normalizedUrl,
        payload: /** @type {Record<string, unknown>} */ (parsed),
      })
    } catch (error) {
      rejectedByUrl.set(
        item.normalizedUrl,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  return { documents, rejectedByUrl }
}

/**
 * @param {PackageIndexDocument[]} documents
 * @returns {{
 *   platforms: CatalogPlatform[]
 *   boards: CatalogBoard[]
 * }}
 */
function buildCatalogFromPackageIndexes(documents) {
  /** @type {Map<string, CatalogPlatform>} */
  const platforms = new Map()
  /** @type {Map<string, CatalogBoard>} */
  const boards = new Map()

  for (const document of documents) {
    const packages = Array.isArray(document.payload.packages)
      ? document.payload.packages
      : []

    for (const maybePackage of packages) {
      if (!maybePackage || typeof maybePackage !== 'object') continue

      const packageName =
        typeof maybePackage.name === 'string' ? maybePackage.name.trim() : ''
      if (!packageName) continue

      const maintainer =
        typeof maybePackage.maintainer === 'string'
          ? maybePackage.maintainer.trim()
          : undefined
      const website =
        typeof maybePackage.websiteURL === 'string'
          ? maybePackage.websiteURL.trim()
          : typeof maybePackage.website === 'string'
            ? maybePackage.website.trim()
            : undefined
      const packagePlatforms = Array.isArray(maybePackage.platforms)
        ? maybePackage.platforms
        : []

      for (const maybePlatform of packagePlatforms) {
        if (!maybePlatform || typeof maybePlatform !== 'object') continue

        const architecture =
          typeof maybePlatform.architecture === 'string'
            ? maybePlatform.architecture.trim()
            : ''
        const name =
          typeof maybePlatform.name === 'string'
            ? maybePlatform.name.trim()
            : ''
        const version =
          typeof maybePlatform.version === 'string'
            ? maybePlatform.version.trim()
            : ''
        if (!architecture || !name || !version) continue
        const deprecated =
          maybePlatform.deprecated === true || hasDeprecatedCatalogMarker(name)

        const platformId = `${packageName}:${architecture}`
        const key = `${document.normalizedUrl}#${platformId}`
        const types = []
        if (
          typeof maybePlatform.category === 'string' &&
          maybePlatform.category.trim()
        ) {
          types.push(maybePlatform.category.trim())
        }

        /** @type {string[]} */
        const boardNames = []
        const platformBoards = Array.isArray(maybePlatform.boards)
          ? maybePlatform.boards
          : []
        for (const maybeBoard of platformBoards) {
          if (!maybeBoard || typeof maybeBoard !== 'object') continue
          const boardName =
            typeof maybeBoard.name === 'string' ? maybeBoard.name.trim() : ''
          if (!boardName) continue
          const boardDeprecated =
            deprecated ||
            maybeBoard.deprecated === true ||
            hasDeprecatedCatalogMarker(boardName)
          if (!boardNames.includes(boardName)) {
            boardNames.push(boardName)
          }

          const boardKey = `${key}#${compactBoardName(boardName)}`
          const existingBoard = boards.get(boardKey)
          if (!existingBoard) {
            boards.set(boardKey, {
              name: boardName,
              url: document.normalizedUrl,
              platformId,
              platformName: name,
              platformVersion: version,
              deprecated: boardDeprecated,
            })
          } else if (boardDeprecated && !existingBoard.deprecated) {
            existingBoard.deprecated = true
          }
        }

        if (!boardNames.length) continue

        const existing = platforms.get(key)
        if (!existing) {
          platforms.set(key, {
            url: document.normalizedUrl,
            platformId,
            packageName,
            architecture,
            name,
            version,
            maintainer,
            website,
            deprecated,
            types,
            boards: boardNames,
          })
          continue
        }

        if (compareVersionStrings(version, existing.version) > 0) {
          existing.version = version
          existing.name = name
          existing.deprecated = deprecated
          existing.types = types
        }
        if (deprecated && !existing.deprecated) {
          existing.deprecated = true
        }
        if (!existing.maintainer && maintainer) {
          existing.maintainer = maintainer
        }
        if (!existing.website && website) {
          existing.website = website
        }
        for (const boardName of boardNames) {
          if (!existing.boards.includes(boardName)) {
            existing.boards.push(boardName)
          }
        }
      }
    }
  }

  return {
    platforms: Array.from(platforms.values()).sort(compareCatalogPlatforms),
    boards: Array.from(boards.values()).sort(compareCatalogBoards),
  }
}

/**
 * @param {CatalogBoard[]} boards
 * @param {CliBoardEntry[]} cliBoards
 * @returns {{ matchedCount: number }}
 */
function applyCliBoardResolution(boards, cliBoards) {
  /** @type {Map<string, CliBoardEntry>} */
  const byPlatformAndName = new Map()
  /** @type {Map<string, CliBoardEntry[]>} */
  const byName = new Map()

  for (const maybeBoard of cliBoards) {
    if (!maybeBoard || typeof maybeBoard !== 'object') continue
    const name =
      typeof maybeBoard.name === 'string' ? maybeBoard.name.trim() : ''
    const fqbn =
      typeof maybeBoard.fqbn === 'string' ? maybeBoard.fqbn.trim() : ''
    if (!name || !fqbn) continue

    const platformId =
      typeof maybeBoard.platform?.metadata?.id === 'string'
        ? maybeBoard.platform.metadata.id.trim()
        : undefined
    if (!platformId) continue

    const key = `${platformId}#${normalizeBoardName(name)}`
    if (!byPlatformAndName.has(key)) {
      byPlatformAndName.set(key, maybeBoard)
    }

    const compact = compactBoardName(name)
    if (!byName.has(compact)) {
      byName.set(compact, [])
    }
    byName.get(compact)?.push(maybeBoard)
  }

  let matchedCount = 0
  for (const board of boards) {
    const exactKey = `${board.platformId}#${normalizeBoardName(board.name)}`
    const exact = byPlatformAndName.get(exactKey)
    if (exact && typeof exact.fqbn === 'string' && exact.fqbn.trim()) {
      board.fqbn = exact.fqbn.trim()
      board.boardId = boardIdFromFqbn(board.fqbn)
      matchedCount++
      continue
    }

    const matches = byName.get(compactBoardName(board.name)) || []
    if (matches.length !== 1) {
      continue
    }

    const only = matches[0]
    if (typeof only.fqbn === 'string' && only.fqbn.trim()) {
      board.fqbn = only.fqbn.trim()
      board.boardId = boardIdFromFqbn(board.fqbn)
      matchedCount++
    }
  }

  return { matchedCount }
}

/**
 * @param {string[] | undefined} [argv]
 * @returns {{
 *   cliPath?: string
 *   cliVersion?: string
 *   outFile: string
 *   reportFile?: string
 *   includeOfficial: boolean
 *   fullOutput: boolean
 * }}
 */
function parseArgs(argv) {
  const args = argv ?? process.argv.slice(2)
  /**
   * @type {{
   *   cliPath?: string
   *   cliVersion?: string
   *   outFile: string
   *   reportFile?: string
   *   includeOfficial: boolean
   *   fullOutput: boolean
   * }}
   */
  const result = {
    outFile: path.resolve(
      __dirname,
      '..',
      'resources',
      'third-party-platforms.json'
    ),
    includeOfficial: false,
    fullOutput: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--cli-path':
        result.cliPath = args[++i]
        break
      case '--cli-version':
        result.cliVersion = args[++i]
        break
      case '--target':
      case '--out':
        result.outFile = path.resolve(args[++i])
        break
      case '--report':
      case '--report-out':
        result.reportFile = path.resolve(args[++i])
        break
      case '--full':
        result.fullOutput = true
        break
      case '--include-official':
        result.includeOfficial = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return result
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @param {string | undefined} value
 * @param {string[]} transientPaths
 * @returns {string | undefined}
 */
function sanitizeTransientPaths(value, transientPaths) {
  if (!value) {
    return value
  }

  let result = String(value)
  for (const transientPath of transientPaths) {
    if (!transientPath) {
      continue
    }
    result = result.replace(
      new RegExp(escapeRegExp(transientPath), 'g'),
      '<tmp>'
    )
  }

  return result.replace(
    /\/var\/folders\/[^\s'"]+|\/tmp\/[^\s'"]+|\\Temp\\[^\s'"]+/g,
    '<tmp>'
  )
}

/**
 * @param {string} title
 * @param {string[]} values
 * @param {number} [limit]
 */
function printReportList(title, values, limit = 20) {
  console.log(`[report] ${title}: ${values.length}`)
  if (!values.length) {
    return
  }

  const sorted = Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right)
  )
  const shown = sorted.slice(0, limit)
  for (const value of shown) {
    console.log(`  - ${value}`)
  }
  if (sorted.length > shown.length) {
    console.log(`  ... and ${sorted.length - shown.length} more`)
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function formatJsonWithPrettier(filePath) {
  let config = {}
  try {
    config = (await prettier.resolveConfig(filePath)) || {}
  } catch {
    config = {}
  }

  const source = fs.readFileSync(filePath, 'utf8')
  const formatted = await prettier.format(source, {
    ...config,
    filepath: filePath,
    parser: 'json',
  })

  if (formatted !== source) {
    fs.writeFileSync(filePath, formatted, 'utf8')
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function runPrettierCliFallback(filePath) {
  try {
    await execFileAsync('npx', ['prettier', '--write', filePath], {
      encoding: 'utf8',
    })
    return true
  } catch {
    return false
  }
}

async function main() {
  const options = parseArgs()
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boardlab-3rd-party-'))
  const wikiDir = path.join(tmpRoot, 'Arduino.wiki')

  try {
    const tsvUrl =
      'https://raw.githubusercontent.com/per1234/inoplatforms/HEAD/ino-hardware-package-list.tsv'
    console.log(`-> Fetching inoplatforms TSV: ${tsvUrl}`)
    const tsv = await fetchText(tsvUrl, { timeoutMs: 30_000 })
    const tsvUrls = extractPackageIndexUrls(tsv)
    console.log(`[ok] Extracted ${tsvUrls.length} URL candidates from TSV`)

    const tsvNormalized = tsvUrls
      .map((u) => normalizeUrl(u))
      .filter((u) => typeof u === 'string')
    const tsvUnique = new Set(tsvNormalized)
    console.log(
      `[stats] TSV: ${tsvUrls.length} raw candidates, ${tsvNormalized.length} normalized, ${tsvUnique.size} unique, ${tsvNormalized.length - tsvUnique.size} duplicates after normalization`
    )

    console.log('-> Cloning arduino/Arduino.wiki (depth=1)...')
    runGit([
      'clone',
      '--quiet',
      '--depth',
      '1',
      'https://github.com/arduino/Arduino.wiki.git',
      wikiDir,
    ])

    const wikiPage = path.join(
      wikiDir,
      'Unofficial-list-of-3rd-party-boards-support-urls.md'
    )
    if (!fs.existsSync(wikiPage)) {
      throw new Error(`Wiki page missing: ${wikiPage}`)
    }

    const wikiMd = fs.readFileSync(wikiPage, 'utf8')
    const wikiEntries = parseArduinoWikiEntries(wikiMd)
    const wikiUrls = wikiEntries.map((entry) => entry.url)
    console.log(
      `[ok] Extracted ${wikiEntries.length} named entries (${wikiUrls.length} URL refs) from wiki`
    )

    const wikiNormalized = wikiUrls
      .map((u) => normalizeUrl(u))
      .filter((u) => typeof u === 'string')
    const wikiUnique = new Set(wikiNormalized)
    console.log(
      `[stats] Wiki: ${wikiUrls.length} raw URL refs, ${wikiNormalized.length} normalized, ${wikiUnique.size} unique, ${wikiNormalized.length - wikiUnique.size} duplicates after normalization`
    )

    let overlap = 0
    for (const url of wikiUnique) {
      if (tsvUnique.has(url)) overlap++
    }
    console.log(
      `[stats] Overlap: ${overlap} URLs appear in both sources; TSV-only: ${tsvUnique.size - overlap}; Wiki-only: ${wikiUnique.size - overlap}`
    )

    /** @type {Map<string, { label: string; note?: string }>} */
    const wikiMeta = new Map()
    for (const entry of wikiEntries) {
      const normalized = normalizeUrl(entry.url)
      if (!normalized || wikiMeta.has(normalized)) continue
      wikiMeta.set(normalized, { label: entry.label, note: entry.note })
    }

    /** @type {Map<string, ThirdPartyIndexItem>} */
    const items = new Map()

    /**
     * @param {string[]} urls
     * @param {'inoplatforms' | 'arduino-wiki'} source
     * @param {Map<string, { label: string; note?: string }> | undefined} [metaByNormalizedUrl]
     */
    function addAll(urls, source, metaByNormalizedUrl) {
      for (const raw of urls) {
        const normalized = normalizeUrl(raw)
        if (!normalized) continue

        const meta = metaByNormalizedUrl
          ? metaByNormalizedUrl.get(normalized)
          : undefined
        const existing = items.get(normalized)
        if (existing) {
          if (!existing.provenance.includes(source)) {
            existing.provenance.push(source)
          }
          if (meta?.label?.trim()) {
            existing.label = meta.label
          }
          if (!existing.note && meta?.note?.trim()) {
            existing.note = meta.note
          }
          continue
        }

        items.set(normalized, {
          url: normalized,
          normalizedUrl: normalized,
          provenance: [source],
          label: meta?.label || deriveLabel(normalized),
          note: meta?.note,
        })
      }
    }

    addAll(tsvUrls, 'inoplatforms')
    addAll(wikiUrls, 'arduino-wiki', wikiMeta)

    const sortedItems = Array.from(items.values()).sort((left, right) =>
      left.normalizedUrl.localeCompare(right.normalizedUrl)
    )
    const officialExcludedItems = options.includeOfficial
      ? []
      : sortedItems.filter((item) =>
          isOfficialArduinoIndexUrl(item.normalizedUrl)
        )
    const officialExcludedByUrl = new Map(
      officialExcludedItems.map((item) => [
        item.normalizedUrl,
        'Excluded official Arduino package index URL',
      ])
    )
    const candidateItems = sortedItems.filter(
      (item) => !officialExcludedByUrl.has(item.normalizedUrl)
    )

    const cliPath = await resolveArduinoCliPath(
      options.cliPath,
      options.cliVersion ?? DEFAULT_CLI_VERSION
    )
    const cliInfo = getCliVersionInfo(cliPath)
    console.log(
      `-> Using arduino-cli: ${cliPath}${cliInfo.version ? ` (${cliInfo.version})` : ''}`
    )

    console.log(
      `-> Prefetching ${candidateItems.length} candidate package indexes and rejecting non-JSON responses`
    )
    const prefetched = await loadPackageIndexDocuments(candidateItems)
    /** @type {Map<string, PackageIndexDocument>} */
    const documentsByUrl = new Map(
      prefetched.documents.map((document) => [document.normalizedUrl, document])
    )
    /** @type {Map<string, string>} */
    const rejectedByUrl = new Map([
      ...officialExcludedByUrl.entries(),
      ...prefetched.rejectedByUrl.entries(),
    ])
    const prevalidatedItems = candidateItems.filter((item) =>
      documentsByUrl.has(item.normalizedUrl)
    )
    console.log(
      `[ok] Prefetch accepted ${prevalidatedItems.length} URLs and rejected ${prefetched.rejectedByUrl.size}${officialExcludedItems.length ? ` (+${officialExcludedItems.length} official excluded)` : ''}`
    )

    const validationEnv = createCliEnv(cliPath, tmpRoot, 'validation')
    setCliConfig(
      cliPath,
      validationEnv.cliConfigPath,
      'board_manager.additional_urls',
      prevalidatedItems.map((item) => item.normalizedUrl)
    )

    console.log(
      `-> Validating ${prevalidatedItems.length} fetch-validated package indexes with arduino-cli`
    )
    const validationResult = runCli(
      cliPath,
      [
        'core',
        'update-index',
        '--format',
        'json',
        '--config-file',
        validationEnv.cliConfigPath,
      ],
      { allowFailure: true }
    )
    const cliRejectedByUrl = collectRejectedUrls(
      validationResult,
      prevalidatedItems
    )
    for (const [url, message] of cliRejectedByUrl) {
      if (!rejectedByUrl.has(url)) {
        rejectedByUrl.set(url, message)
      }
    }
    if (validationResult.status !== 0 && cliRejectedByUrl.size === 0) {
      console.log(
        '[warn] arduino-cli validation failed but did not identify any additional bad URLs; continuing with fetch-validated indexes only'
      )
    }

    const acceptedItems = prevalidatedItems.filter(
      (item) => !rejectedByUrl.has(item.normalizedUrl)
    )
    console.log(
      `[ok] Validation accepted ${acceptedItems.length} URLs and rejected ${rejectedByUrl.size}`
    )

    const catalogEnv = createCliEnv(cliPath, tmpRoot, 'catalog')
    setCliConfig(
      cliPath,
      catalogEnv.cliConfigPath,
      'board_manager.additional_urls',
      acceptedItems.map((item) => item.normalizedUrl)
    )
    const catalogUpdateResult = runCli(
      cliPath,
      [
        'core',
        'update-index',
        '--format',
        'json',
        '--config-file',
        catalogEnv.cliConfigPath,
      ],
      { allowFailure: true }
    )
    if (catalogUpdateResult.status !== 0) {
      console.log(
        '[warn] arduino-cli could not initialize every accepted index in the catalog environment; board FQBN resolution may be incomplete'
      )
    }

    console.log('-> Building catalog from accepted package indexes')
    const documents = /** @type {PackageIndexDocument[]} */ (
      acceptedItems
        .map((item) => documentsByUrl.get(item.normalizedUrl))
        .filter((document) => Boolean(document))
    )
    const rawCatalog = buildCatalogFromPackageIndexes(documents)
    const prunedCatalog = pruneCatalogForOutput(rawCatalog)
    const catalog = prunedCatalog.catalog

    console.log(
      `-> Extracted ${rawCatalog.platforms.length} raw platforms and ${rawCatalog.boards.length} raw boards from package indexes`
    )
    console.log(
      `[ok] Clean catalog has ${catalog.platforms.length} platforms and ${catalog.boards.length} boards`
    )
    console.log(
      `[stats] Dropped: official URLs ${officialExcludedItems.length}, deprecated platforms ${prunedCatalog.dropped.deprecatedPlatforms.length}, deprecated boards ${prunedCatalog.dropped.deprecatedBoards.length}, noisy boards ${prunedCatalog.dropped.noisyBoards.length}, empty platforms ${prunedCatalog.dropped.platformsDroppedBecauseNoBoards.length}`
    )

    const cliBoardList = loadCliBoardList(cliPath, catalogEnv.cliConfigPath)
    const boardResolution = cliBoardList.boards.length
      ? applyCliBoardResolution(catalog.boards, cliBoardList.boards)
      : { matchedCount: 0 }
    if (cliBoardList.command) {
      console.log(
        `[ok] Resolved ${boardResolution.matchedCount} board FQBNs via '${cliBoardList.command}'`
      )
    } else {
      console.log(
        '[warn] Could not run an arduino-cli board listing command; catalog boards will not have FQBNs unless derived elsewhere'
      )
    }

    /** @type {Map<string, number>} */
    const platformCounts = new Map()
    /** @type {Map<string, number>} */
    const boardCounts = new Map()

    for (const platform of catalog.platforms) {
      platformCounts.set(
        platform.url,
        (platformCounts.get(platform.url) || 0) + 1
      )
    }
    for (const board of catalog.boards) {
      boardCounts.set(board.url, (boardCounts.get(board.url) || 0) + 1)
    }

    for (const item of sortedItems) {
      const message = rejectedByUrl.get(item.normalizedUrl)
      item.validationStatus = message ? 'rejected' : 'accepted'
      item.validationMessage = sanitizeTransientPaths(message, [tmpRoot])
      item.platformCount = platformCounts.get(item.normalizedUrl) || 0
      item.boardCount = boardCounts.get(item.normalizedUrl) || 0
    }

    const rawDeprecatedPlatforms = rawCatalog.platforms.filter(
      (platform) => platform.deprecated
    )
    const rawDeprecatedBoards = rawCatalog.boards.filter(
      (board) => board.deprecated
    )

    const report = {
      generatedAt: new Date().toISOString(),
      sources: {
        tsv: {
          url: tsvUrl,
          rawCandidates: tsvUrls.length,
          normalizedCandidates: tsvNormalized.length,
          uniqueCandidates: tsvUnique.size,
        },
        wiki: {
          entries: wikiEntries.length,
          rawUrls: wikiUrls.length,
          normalizedUrls: wikiNormalized.length,
          uniqueUrls: wikiUnique.size,
        },
        overlap: {
          sharedUrls: overlap,
          tsvOnly: tsvUnique.size - overlap,
          wikiOnly: wikiUnique.size - overlap,
        },
      },
      cli: {
        requestedVersion: options.cliVersion ?? DEFAULT_CLI_VERSION,
        actualVersion: cliInfo.version,
        boardListCommand: cliBoardList.command,
      },
      prefetch: {
        acceptedUrls: prevalidatedItems.length,
        rejectedUrls: prefetched.rejectedByUrl.size,
        officialExcludedUrls: officialExcludedItems.length,
      },
      validation: {
        acceptedUrls: acceptedItems.length,
        rejectedUrls: Array.from(rejectedByUrl.entries())
          .sort((left, right) => left[0].localeCompare(right[0]))
          .map(([url, message]) => ({
            url,
            message: sanitizeTransientPaths(message, [tmpRoot]),
          })),
      },
      catalog: {
        rawStats: {
          platforms: rawCatalog.platforms.length,
          boards: rawCatalog.boards.length,
          deprecatedPlatforms: rawDeprecatedPlatforms.length,
          deprecatedBoards: rawDeprecatedBoards.length,
        },
        cleanStats: {
          platforms: catalog.platforms.length,
          boards: catalog.boards.length,
          boardsWithResolvedFqbn: catalog.boards.filter((board) => board.fqbn)
            .length,
        },
      },
      filtering: {
        officialExcludedUrls: {
          count: officialExcludedItems.length,
          items: officialExcludedItems
            .map((item) => item.normalizedUrl)
            .sort((left, right) => left.localeCompare(right)),
        },
        deprecatedPlatformsDropped: {
          count: prunedCatalog.dropped.deprecatedPlatforms.length,
          items: prunedCatalog.dropped.deprecatedPlatforms,
        },
        deprecatedBoardsDropped: {
          count: prunedCatalog.dropped.deprecatedBoards.length,
          items: prunedCatalog.dropped.deprecatedBoards,
        },
        noisyBoardsDropped: {
          count: prunedCatalog.dropped.noisyBoards.length,
          items: prunedCatalog.dropped.noisyBoards,
        },
        platformsDroppedBecauseNoBoards: {
          count: prunedCatalog.dropped.platformsDroppedBecauseNoBoards.length,
          items: prunedCatalog.dropped.platformsDroppedBecauseNoBoards,
        },
      },
    }

    const catalogPayload = toPlatformOnlyCatalogPayload(catalog)

    const payload = options.fullOutput
      ? {
          generatedAt: report.generatedAt,
          sources: {
            inoplatformsTsv: {
              type: 'raw',
              url: tsvUrl,
            },
            arduinoWiki: {
              type: 'git',
              repo: 'https://github.com/arduino/Arduino.wiki.git',
              page: 'Unofficial-list-of-3rd-party-boards-support-urls.md',
            },
          },
          cli: report.cli,
          validation: {
            acceptedUrls: acceptedItems.map((item) => item.normalizedUrl),
            rejectedUrls: report.validation.rejectedUrls,
          },
          filtering: report.filtering,
          items: sortedItems,
          platforms: catalogPayload.platforms,
          stats: report.catalog.cleanStats,
        }
      : catalogPayload

    fs.mkdirSync(path.dirname(options.outFile), { recursive: true })
    fs.writeFileSync(
      options.outFile,
      JSON.stringify(payload, null, 2) + '\n',
      'utf8'
    )
    try {
      await formatJsonWithPrettier(options.outFile)
    } catch (error) {
      const formattedWithCli = await runPrettierCliFallback(options.outFile)
      if (!formattedWithCli) {
        console.warn(
          `[warn] Could not format generated JSON with Prettier: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    if (options.reportFile) {
      fs.mkdirSync(path.dirname(options.reportFile), { recursive: true })
      fs.writeFileSync(
        options.reportFile,
        JSON.stringify(report, null, 2) + '\n',
        'utf8'
      )
      try {
        await formatJsonWithPrettier(options.reportFile)
      } catch (error) {
        const formattedWithCli = await runPrettierCliFallback(
          options.reportFile
        )
        if (!formattedWithCli) {
          console.warn(
            `[warn] Could not format report JSON with Prettier: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }

    console.log(
      `[ok] Wrote ${catalog.platforms.length} platforms and ${catalog.boards.length} boards to ${options.outFile}${options.fullOutput ? ' (full metadata)' : ' (catalog only)'}`
    )
    if (options.reportFile) {
      console.log(`[ok] Wrote generation report to ${options.reportFile}`)
    }

    printReportList(
      'Dropped deprecated platforms',
      prunedCatalog.dropped.deprecatedPlatforms.map((platform) => platform.name)
    )
    printReportList(
      'Dropped deprecated boards',
      prunedCatalog.dropped.deprecatedBoards.map((board) => board.name)
    )
    printReportList(
      'Dropped noisy boards',
      prunedCatalog.dropped.noisyBoards.map((board) => board.name)
    )
    printReportList(
      'Dropped platforms without boards',
      prunedCatalog.dropped.platformsDroppedBecauseNoBoards.map(
        (platform) => platform.name
      )
    )
    printReportList(
      'Excluded official package indexes',
      officialExcludedItems.map((item) => item.normalizedUrl)
    )
    printReportList(
      'Rejected package indexes',
      report.validation.rejectedUrls.map(
        (entry) => `${entry.url} :: ${entry.message || 'unknown error'}`
      ),
      10
    )
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

module.exports = {
  hasDeprecatedCatalogMarker,
  isNoisyBoardName,
  isOfficialArduinoIndexUrl,
  isDeprecatedPlatform,
  isDeprecatedBoard,
  pruneCatalogForOutput,
  toPlatformOnlyCatalogPayload,
  parseArgs,
}

if (require.main === module) {
  main().catch((err) => {
    if (err && typeof err === 'object') {
      if ('stderr' in err && err.stderr) {
        process.stderr.write(String(err.stderr))
      }
      if ('stdout' in err && err.stdout) {
        process.stderr.write(String(err.stdout))
      }
    }
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
