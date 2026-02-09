// @ts-check
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import util from 'node:util'

import { Port } from 'ardunno-cli'
import { createPortKey, parsePortKey } from 'boards-list'
import cors from 'cors'
import express from 'express'
import deepEqual from 'fast-deep-equal'
import { ClientError } from 'nice-grpc'
import { ResponseError } from 'vscode-jsonrpc'
import { createWebSocketConnection } from 'vscode-ws-jsonrpc'
import { WebSocketServer } from 'ws'

import {
  NotifyDidChangeBaudrate,
  NotifyDidChangeDetectedPorts,
  NotifyDidChangeMonitorSettings,
  NotifyMonitorBridgeLog,
  NotifyMonitorDidPause,
  NotifyMonitorDidResume,
  NotifyMonitorDidStart,
  NotifyMonitorDidStop,
  NotifyTraceEvent,
  RequestMonitorClose,
  RequestMonitorOpen,
  RequestMonitorSubscribe,
  RequestMonitorUnsubscribe,
  RequestMonitorWrite,
  RequestPortinoHello,
  RequestClientConnect,
  RequestDetectedPorts,
  RequestPauseMonitor,
  RequestResumeMonitor,
  RequestSendMonitorMessage,
  RequestUpdateBaudrate,
} from '@boardlab/protocol'

import { DaemonCliBridge } from './cliBridge.js'
import { LOG_DIR, ensureLogDir } from './logPaths.js'
import { TraceWriter, hashToken } from './traceWriter.js'

const DEFAULT_HOST = '127.0.0.1'
const MAX_PROPERTY_STRING_LENGTH = 256
const WS_CONTROL_PATH = '/control'
const WS_DATA_PATH = '/data'
const PORTINO_PROTOCOL_VERSION = 1
const PORTINO_CAPABILITIES = ['multi-client', 'tail', 'tx_allow_all']
const MONITOR_READY_TIMEOUT_MS = 1500
// https://docs.datadoghq.com/tracing/error_tracking/exception_replay/#identifier-based-redaction
// https://github.com/DataDog/dd-trace-py/blob/main/ddtrace/debugging/_redaction.py
const DDT_DATADOG_REDACTION_IDENTIFIERS = [
  '2fa',
  'accesstoken',
  'aiohttpsession',
  'apikey',
  'apisecret',
  'apisignature',
  'appkey',
  'applicationkey',
  'auth',
  'authorization',
  'authtoken',
  'ccnumber',
  'certificatepin',
  'cipher',
  'clientid',
  'clientsecret',
  'connectionstring',
  'connectsid',
  'cookie',
  'credentials',
  'creditcard',
  'csrf',
  'csrftoken',
  'cvv',
  'databaseurl',
  'dburl',
  'encryptionkey',
  'encryptionkeyid',
  'geolocation',
  'gpgkey',
  'ipaddress',
  'jti',
  'jwt',
  'licensekey',
  'masterkey',
  'mysqlpwd',
  'nonce',
  'oauth',
  'oauthtoken',
  'otp',
  'passhash',
  'passwd',
  'password',
  'passwordb',
  'pemfile',
  'pgpkey',
  'phpsessid',
  'pin',
  'pincode',
  'pkcs8',
  'privatekey',
  'publickey',
  'pwd',
  'recaptchakey',
  'refreshtoken',
  'routingnumber',
  'salt',
  'secret',
  'secretkey',
  'secrettoken',
  'securityanswer',
  'securitycode',
  'securityquestion',
  'serviceaccountcredentials',
  'session',
  'sessionid',
  'sessionkey',
  'setcookie',
  'signature',
  'signaturekey',
  'sshkey',
  'ssn',
  'symfony',
  'token',
  'transactionid',
  'twiliotoken',
  'usersession',
  'voterid',
  'xapikey',
  'xauthtoken',
  'xcsrftoken',
  'xforwardedfor',
  'xrealip',
  'xsrf',
  'xsrftoken',
  'apikey',
]
const redactedIdentifierSet = new Set(
  DDT_DATADOG_REDACTION_IDENTIFIERS.map((id) => normalizeIdentifier(id))
)

class AttachmentRegistry {
  constructor() {
    /**
     * @type {Map<
     *   string,
     *   { clientId?: string; attachedAt: number; lastSeen: number }
     * >}
     */
    this.attachments = new Map()
    this.idleTimer = undefined
    this.idleTimeoutMs = 0
    this.onIdle = undefined
    this.heartbeatTimeoutMs = 0
    this.heartbeatSweepMs = 0
    this.heartbeatTimer = undefined
    this.onPruneCallback = undefined
  }

  /**
   * @param {{
   *   idleTimeoutMs?: number
   *   onIdle?: () => void | Promise<void>
   *   heartbeatTimeoutMs?: number
   *   heartbeatSweepMs?: number
   *   onPrune?: (count: number) => void
   * }} [options]
   */
  configure(options = {}) {
    const {
      idleTimeoutMs,
      onIdle,
      heartbeatTimeoutMs,
      heartbeatSweepMs,
      onPrune,
    } = options
    this.idleTimeoutMs =
      typeof idleTimeoutMs === 'number' && idleTimeoutMs > 0 ? idleTimeoutMs : 0
    this.onIdle = typeof onIdle === 'function' ? onIdle : undefined
    this.heartbeatTimeoutMs =
      typeof heartbeatTimeoutMs === 'number' && heartbeatTimeoutMs > 0
        ? heartbeatTimeoutMs
        : 0
    this.heartbeatSweepMs =
      typeof heartbeatSweepMs === 'number' && heartbeatSweepMs > 0
        ? heartbeatSweepMs
        : this.heartbeatTimeoutMs > 0
          ? Math.min(5_000, Math.max(1_000, this.heartbeatTimeoutMs / 2))
          : 0

    this.refreshHeartbeatSweep()
    if (this.attachments.size === 0) {
      // Re-evaluate idle scheduling under the new configuration.
      this.clearTimer()
      this.scheduleIdleShutdown()
    }
    this.onPruneCallback = typeof onPrune === 'function' ? onPrune : undefined
  }

  get size() {
    return this.attachments.size
  }

  attach(clientId) {
    const token = randomUUID()
    const now = Date.now()
    this.attachments.set(token, { clientId, attachedAt: now, lastSeen: now })
    this.clearTimer()
    this.refreshHeartbeatSweep()
    return { token }
  }

  detach(token) {
    this.attachments.delete(token)
    if (this.attachments.size === 0) {
      this.clearHeartbeatTimer()
      this.scheduleIdleShutdown()
    }
    return this.attachments.size
  }

  touch(token) {
    const entry = this.attachments.get(token)
    if (!entry) {
      return undefined
    }
    const now = Date.now()
    const previous = entry.lastSeen ?? entry.attachedAt
    entry.lastSeen = now
    return {
      token,
      ageMs: now - previous,
      attachments: this.attachments.size,
    }
  }

  dispose() {
    this.clearTimer()
    this.clearHeartbeatTimer()
    this.attachments.clear()
  }

  pruneStale() {
    if (this.heartbeatTimeoutMs <= 0 || this.attachments.size === 0) {
      return
    }
    const now = Date.now()
    let removed = 0
    for (const [token, entry] of this.attachments.entries()) {
      const lastSeen = entry.lastSeen ?? entry.attachedAt
      if (now - lastSeen > this.heartbeatTimeoutMs) {
        this.attachments.delete(token)
        removed += 1
      }
    }
    if (removed > 0) {
      this.onPruneCallback?.(removed)
    }
    if (removed && this.attachments.size === 0) {
      this.clearHeartbeatTimer()
      this.scheduleIdleShutdown()
    }
  }

  refreshHeartbeatSweep() {
    if (this.heartbeatTimeoutMs <= 0 || this.attachments.size === 0) {
      this.clearHeartbeatTimer()
      return
    }
    if (this.heartbeatTimer) {
      return
    }
    if (this.heartbeatSweepMs <= 0) {
      return
    }
    this.heartbeatTimer = setInterval(() => {
      this.pruneStale()
    }, this.heartbeatSweepMs)
  }

  clearHeartbeatTimer() {
    if (!this.heartbeatTimer) {
      return
    }
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  scheduleIdleShutdown() {
    if (this.idleTimer || !this.onIdle || this.idleTimeoutMs <= 0) {
      return
    }
    this.idleTimer = setTimeout(async () => {
      this.idleTimer = undefined
      try {
        await this.onIdle()
      } catch (error) {
        console.error(
          '[PortinoServer] idle callback failed',
          /** @type {unknown} */ (error)
        )
      }
    }, this.idleTimeoutMs)
  }

  clearTimer() {
    if (!this.idleTimer) {
      return
    }
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}

class RingBuffer {
  constructor(maxBytes = 0) {
    this.maxBytes = Math.max(0, Number(maxBytes) || 0)
    /** @type {Buffer[]} */
    this.chunks = []
    this.size = 0
  }

  ensureCapacity(maxBytes) {
    const next = Math.max(0, Number(maxBytes) || 0)
    if (next > this.maxBytes) {
      this.maxBytes = next
    }
  }

  push(buf) {
    if (!this.maxBytes) {
      return
    }
    if (!buf || !buf.length) {
      return
    }
    const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    if (buffer.length >= this.maxBytes) {
      this.chunks = [buffer.slice(buffer.length - this.maxBytes)]
      this.size = this.chunks[0].length
      return
    }
    this.chunks.push(buffer)
    this.size += buffer.length
    while (this.size > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0]
      const overflow = this.size - this.maxBytes
      if (head.length <= overflow) {
        this.chunks.shift()
        this.size -= head.length
      } else {
        this.chunks[0] = head.slice(overflow)
        this.size -= overflow
      }
    }
  }

  tail(bytes) {
    const requested = Math.max(0, Number(bytes) || 0)
    if (!requested || !this.size) {
      return Buffer.alloc(0)
    }
    let remaining = Math.min(requested, this.size)
    /** @type {Buffer[]} */
    const parts = []
    for (let i = this.chunks.length - 1; i >= 0 && remaining > 0; i -= 1) {
      const chunk = this.chunks[i]
      if (chunk.length <= remaining) {
        parts.push(chunk)
        remaining -= chunk.length
      } else {
        parts.push(chunk.slice(chunk.length - remaining))
        remaining = 0
      }
    }
    if (parts.length === 0) {
      return Buffer.alloc(0)
    }
    return Buffer.concat(parts.reverse())
  }
}

/**
 * @param {unknown} value
 * @returns {value is { type: 'Buffer'; data: readonly number[] }}
 */
const isBufferPayload = (value) =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  /** @type {{ type?: string }} */ (value).type === 'Buffer' &&
  Array.isArray(/** @type {{ data?: unknown }} */ (value).data)

const baseConsoleFunctions = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
}

// Swallow EPIPE from stdout/stderr so a disconnected parent/pipe
// doesn't crash the bridge during shutdown or client disconnects.
const swallowEpipe = (error) => {
  if (error && typeof error === 'object' && error.code === 'EPIPE') {
    return
  }
  throw error
}
try {
  process.stdout.on('error', swallowEpipe)
  process.stderr.on('error', swallowEpipe)
} catch {}

class BridgeWebSocketLogger {
  constructor(baseConsole) {
    this.baseConsole = baseConsole
  }

  error(...args) {
    this.baseConsole.error(...args)
  }

  warn(...args) {
    this.baseConsole.warn(...args)
  }

  info(...args) {
    this.baseConsole.info(...args)
  }

  log(...args) {
    this.baseConsole.log(...args)
  }
}

// TODO: create .d.ts from these, import them in the extension code
/**
 * @typedef {Object} MonitorBridgeIdentity
 * @property {string} [version]
 * @property {string} [mode]
 * @property {number} pid
 * @property {number} [port]
 * @property {string} startedAt
 * @property {string} [extensionPath]
 * @property {string} [commit]
 * @property {string} [nodeVersion]
 * @property {string} [platform]
 */

function buildBridgeIdentity(
  /** @type {Partial<MonitorBridgeIdentity>} */ info
) {
  const startedAt =
    typeof info?.startedAt === 'string' && info.startedAt
      ? info.startedAt
      : new Date().toISOString()
  return {
    version: info?.version,
    mode: info?.mode,
    pid: process.pid,
    port: info?.port,
    startedAt,
    extensionPath: info?.extensionPath,
    commit: info?.commit,
    nodeVersion: process.version,
    platform: process.platform,
  }
}

function formatBridgeIdentityBanner(
  /** @type {MonitorBridgeIdentity} */ identity
) {
  const version = identity.version ?? 'unknown'
  const mode = identity.mode ?? 'unknown'
  const port = identity.port ?? 0
  const startedAt = identity.startedAt ?? new Date().toISOString()
  const extensionPath = identity.extensionPath ?? 'unknown'
  const commit = identity.commit ? ` commit=${identity.commit}` : ''
  return `[boardlab] monitor-bridge ${version} mode=${mode} pid=${identity.pid} port=${port} startedAt=${startedAt} extPath=${extensionPath}${commit}`
}

function formatBridgeLogMessage(args) {
  return args
    .map((value) => {
      if (typeof value === 'string') {
        return value
      }
      if (value instanceof Error) {
        return value.stack ?? value.message
      }
      try {
        return typeof value === 'object'
          ? util.inspect(value, { depth: 3 })
          : String(value)
      } catch {
        return String(value)
      }
    })
    .join(' ')
}

function createMonitorBridgeLogStream() {
  try {
    ensureLogDir()
  } catch (error) {
    baseConsoleFunctions.error(
      '[monitor bridge] failed to create log directory',
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    )
  }
  const timestamp = new Date().toISOString().replace(/:/g, '-')
  const fileName = `log-${timestamp}.txt`
  const filePath = path.join(LOG_DIR, fileName)
  const stream = createWriteStream(filePath, { flags: 'a' })
  stream.on('error', (error) => {
    baseConsoleFunctions.error(
      '[monitor bridge] failed to write to log file',
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    )
  })
  return { stream, filePath }
}

/**
 * @typedef {Object} PortinoConnection
 * @property {import('vscode-jsonrpc').MessageConnection} messageConnection
 * @property {string} [clientId]
 */

/**
 * @typedef {Object} CreateServerOptions
 * @property {number} [port=3000] Default is `3000`
 * @property {boolean} [debug]
 * @property {boolean} [testIntrospection]
 * @property {string} [cliPath]
 * @property {string} [host='127.0.0.1'] Default is `'127.0.0.1'`
 * @property {{
 *   idleTimeoutMs?: number
 *   onIdle?: () => void | Promise<void>
 *   heartbeatTimeoutMs?: number
 *   heartbeatSweepMs?: number
 *   onPrune?: (count: number) => void
 * }} [control]
 * @property {{ heartbeat?: boolean }} [logging]
 * @property {Partial<MonitorBridgeIdentity>} [identity]
 * @property {() =>
 *   | import('./cliBridge.js').CliBridge
 *   | Promise<import('./cliBridge.js').CliBridge>} [cliBridgeFactory]
 * @property {string | string[]} [redactedIdentifiers]
 */

/** @typedef {import('ws').WebSocket} WsSocket */

/**
 * @param {CreateServerOptions} options
 * @returns {Promise<{
 *   port: number
 *   app: import('express').Express
 *   httpServer: import('http').Server
 *   attachmentRegistry: AttachmentRegistry
 *   close: () => Promise<void>
 * }>}
 */
export async function createServer(options = {}) {
  const DEBUG = true // options.debug ?? process.env.PORTINO_DEBUG === '1'
  const extraIdentifiers =
    typeof options.redactedIdentifiers === 'string'
      ? options.redactedIdentifiers
          .split(',')
          .map((v) => normalizeIdentifier(v))
          .filter(Boolean)
      : Array.isArray(options.redactedIdentifiers)
        ? options.redactedIdentifiers
            .map((v) => normalizeIdentifier(String(v)))
            .filter(Boolean)
        : []
  extraIdentifiers.forEach((identifier) =>
    redactedIdentifierSet.add(identifier)
  )
  const bridgeIdentity = buildBridgeIdentity(options.identity)
  /** @type {Set<PortinoConnection>} */
  const portinoConnections = new Set()
  const safeNotify = (connection, method, payload) => {
    if (!connection || connection.closed) return
    try {
      connection.messageConnection.sendNotification(method, payload)
    } catch (error) {
      connection.closed = true
      portinoConnections.delete(connection)
      const message =
        error instanceof Error ? error.message : String(error ?? '')
      if (
        !/disposed|closed|EPIPE/i.test(message) &&
        !(error && typeof error === 'object' && error.code === 'EPIPE')
      ) {
        baseConsoleFunctions.error(
          '[monitor bridge] failed to send notification',
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        )
      }
    }
  }
  const envHeartbeat = process.env.PORTINO_LOG_HEARTBEAT === 'true'
  const loggingConfig = {
    heartbeat:
      typeof options.logging?.heartbeat === 'boolean'
        ? options.logging.heartbeat
        : envHeartbeat,
  }
  const controlOptions = options.control ?? {}
  const heartbeatInfo = {
    intervalMs:
      typeof controlOptions.heartbeatSweepMs === 'number'
        ? controlOptions.heartbeatSweepMs
        : (controlOptions.heartbeatTimeoutMs ?? 0),
    timeoutMs: controlOptions.heartbeatTimeoutMs ?? 0,
  }
  const { stream: logFileStream } = createMonitorBridgeLogStream()
  const writeLogFile = (line) => {
    if (logFileStream && !logFileStream.destroyed) {
      logFileStream.write(`${line}\n`)
    }
  }
  const traceWriter = new TraceWriter({
    identity: {
      version: bridgeIdentity.version,
      mode: bridgeIdentity.mode,
      extensionPath: bridgeIdentity.extensionPath,
      commit: bridgeIdentity.commit,
    },
    heartbeat: heartbeatInfo,
  })
  let lastHeartbeatLogAt = 0
  const heartbeatTraceThrottleMs =
    heartbeatInfo.timeoutMs > 0
      ? Math.max(10_000, Math.min(30_000, heartbeatInfo.timeoutMs))
      : 15_000
  const heartbeatTraceTimestamps = new Map()
  const heartbeatEmissionState = new Map()
  const heartbeatSummaryIntervalMs = 10 * 60_000
  const heartbeatStats = new Map()
  const heartbeatSummaryTimer = setInterval(() => {
    emitHeartbeatSummaries('interval')
  }, heartbeatSummaryIntervalMs)
  const broadcastBridgeLog = (entry) => {
    portinoConnections.forEach((connection) =>
      safeNotify(connection, NotifyMonitorBridgeLog, entry)
    )
  }

  const loggerId = 'bridge'

  const emitHeartbeatSummary = (tokenHash, reason) => {
    const stats = heartbeatStats.get(tokenHash)
    if (!stats || stats.count === 0) return
    const windowMs = Date.now() - stats.since
    traceWriter.emit(
      'heartbeatSummary',
      {
        tokenHash,
        count: stats.count,
        lastAgeMs: stats.lastAgeMs,
        minAgeMs: stats.minAgeMs,
        maxAgeMs: stats.maxAgeMs,
        avgAgeMs: stats.sumAgeMs / stats.count,
        windowMs,
        reason,
      },
      { layer: 'bridge' }
    )
    heartbeatStats.delete(tokenHash)
  }

  const emitHeartbeatSummaries = (reason) => {
    for (const tokenHash of heartbeatStats.keys()) {
      emitHeartbeatSummary(tokenHash, reason)
    }
  }

  const recordHeartbeatStat = (tokenHash, ageMs) => {
    const now = Date.now()
    const stats = heartbeatStats.get(tokenHash) ?? {
      count: 0,
      sumAgeMs: 0,
      minAgeMs: Number.POSITIVE_INFINITY,
      maxAgeMs: Number.NEGATIVE_INFINITY,
      lastAgeMs: 0,
      since: now,
    }
    stats.count += 1
    stats.sumAgeMs += ageMs
    stats.minAgeMs = Math.min(stats.minAgeMs, ageMs)
    stats.maxAgeMs = Math.max(stats.maxAgeMs, ageMs)
    stats.lastAgeMs = ageMs
    heartbeatStats.set(tokenHash, stats)
  }
  const logEntry = (level, args, context) => {
    const entry = {
      level,
      message: formatBridgeLogMessage(args),
      timestamp: new Date().toISOString(),
      ...(context && Object.keys(context).length ? { context } : undefined),
    }
    const contextString =
      entry.context && Object.keys(entry.context).length
        ? ` ${JSON.stringify(entry.context)}`
        : ''
    const normalizedMessage =
      entry.message.length > 120
        ? entry.message.slice(0, 120) + '…'
        : entry.message
    const line = `${entry.timestamp} [${entry.level}] ${entry.message}${contextString}`
    writeLogFile(line)
    traceWriter.emitLogLine({
      level: entry.level,
      logger: loggerId,
      message: normalizedMessage,
      fields: entry.context,
    })
    try {
      broadcastBridgeLog(entry)
    } catch (error) {
      baseConsoleFunctions.error(
        '[monitor bridge] failed to broadcast log',
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      )
    }
    const target =
      level === 'warn'
        ? baseConsoleFunctions.warn
        : level === 'error'
          ? baseConsoleFunctions.error
          : baseConsoleFunctions.log
    target(...args)
  }

  const bridgeLog = (level, message, context) => {
    logEntry(level, [message], context)
  }
  console.log = (...args) => logEntry('info', args)
  console.info = (...args) => logEntry('info', args)
  console.warn = (...args) => logEntry('warn', args)
  console.error = (...args) => logEntry('error', args)
  const v = (/** @type {unknown[]} */ ...args) => {
    if (DEBUG) console.log(...args)
  }
  // 1) boot the Arduino CLI daemon and gRPC client

  const ownBridge = !options.cliBridgeFactory
  const cliBridge = options.cliBridgeFactory
    ? await options.cliBridgeFactory()
    : new DaemonCliBridge({ cliPath: options.cliPath })
  const onExit = () => cliBridge.dispose().catch(() => {})
  process.on('exit', onExit)
  // Prefetch serial protocol settings (always present)
  await cliBridge.fetchMonitorSettingsForProtocol('serial')

  /** @type {Set<string>} */
  const knownProtocols = new Set(['serial'])

  /**
   * Builds a snapshot of monitor settings for all known protocols.
   *
   * @returns {Promise<import('@boardlab/protocol').MonitorSettingsByProtocol>}
   */
  async function buildMonitorSettingsSnapshot() {
    const protocols = Array.from(knownProtocols)
    const byProtocol = await cliBridge.fetchMonitorSettingsForProtocol(
      ...protocols
    )
    /** @type {Record<string, { settings?: any[]; error?: string }>} */
    const payload = {}
    for (const proto of protocols) {
      const value = byProtocol[proto]
      if (value instanceof Error) {
        payload[proto] = { error: String(value.message || value) }
      } else {
        payload[proto] = { settings: value }
      }
    }
    return { protocols: payload }
  }

  // 3) HTTP + WebSocket server
  const host = options.host ?? DEFAULT_HOST
  let httpBaseUrl = ''
  let wsBaseUrl = ''

  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '1mb' }))
  const server = http.createServer(app)
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  })
  const controlWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  })
  const dataWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  })
  const handleUpgrade = (req, socket, head) => {
    let pathname = ''
    try {
      pathname = new URL(req?.url ?? '', 'http://localhost').pathname
    } catch {
      socket.destroy()
      return
    }
    if (pathname === '/serial') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
      return
    }
    if (pathname === WS_CONTROL_PATH) {
      controlWss.handleUpgrade(req, socket, head, (ws) => {
        controlWss.emit('connection', ws, req)
      })
      return
    }
    if (pathname === WS_DATA_PATH) {
      dataWss.handleUpgrade(req, socket, head, (ws) => {
        dataWss.emit('connection', ws, req)
      })
      return
    }
    socket.destroy()
  }
  server.on('upgrade', handleUpgrade)
  const attachmentRegistry = new AttachmentRegistry()
  attachmentRegistry.configure({
    ...controlOptions,
    onPrune: (count) => {
      traceWriter.emit(
        'attachmentDidPrune',
        {
          prunedCount: count,
          timeoutMs: attachmentRegistry.heartbeatTimeoutMs,
          maxAgeMs: attachmentRegistry.heartbeatTimeoutMs,
        },
        { layer: 'bridge' }
      )
    },
  })

  /** @type {import('./boardListWatch.js').BoardListStateWatcher | undefined} */
  const watcher = await cliBridge.createBoardListWatch()
  let previousDetectedPortKeys = new Set()
  let previousSanitizedPortsSnapshot = new Map()

  /** Tracks RequestClientConnect count */
  let clientConnectCount = 0

  app.post('/control/attach', (req, res) => {
    try {
      const clientId =
        typeof req.body?.clientId === 'string' ? req.body.clientId : undefined
      const attachment = attachmentRegistry.attach(clientId)
      res.json({
        token: attachment.token,
        httpBaseUrl,
        wsUrl: wsBaseUrl,
        pid: process.pid,
        attachments: attachmentRegistry.size,
      })
      traceWriter.emit(
        'attachmentDidAttach',
        {
          tokenHash: hashToken(attachment.token),
          attachments: attachmentRegistry.size,
        },
        { layer: 'bridge' }
      )
      heartbeatEmissionState.set(attachment.token, {
        firstEmitted: false,
        lastEmitted: 0,
      })
    } catch (error) {
      console.error('[PortinoServer] attach failed', error)
      res.status(500).json({ error: 'attach_failed' })
    }
  })

  app.post('/control/heartbeat', (req, res) => {
    try {
      const token = req.body?.token
      if (!token) {
        res.status(400).json({ error: 'missing_token' })
        return
      }
      const touch = attachmentRegistry.touch(token)
      if (!touch) {
        res.status(404).json({ error: 'unknown_token' })
        return
      }
      const now = Date.now()
      const ageMs = touch.ageMs ?? 0
      const tokenHash = hashToken(token)
      recordHeartbeatStat(tokenHash, ageMs)
      if (loggingConfig.heartbeat) {
        const logNow = Date.now()
        if (logNow - lastHeartbeatLogAt > 10_000) {
          lastHeartbeatLogAt = logNow
          logEntry('debug', ['Heartbeat received'], {
            token,
            attachments: attachmentRegistry.size,
          })
        }
      }
      const state = heartbeatEmissionState.get(token) ?? {
        firstEmitted: false,
        lastEmitted: 0,
      }
      const intervalMs = heartbeatInfo.intervalMs ?? 0
      const lateThreshold =
        intervalMs > 0 ? intervalMs * 1.5 : heartbeatTraceThrottleMs
      const isLate = intervalMs > 0 ? ageMs >= lateThreshold : false
      const allowPerHeartbeat =
        loggingConfig.heartbeat &&
        (!state.firstEmitted ||
          now - state.lastEmitted >= heartbeatTraceThrottleMs)
      const shouldEmit = allowPerHeartbeat || isLate
      if (shouldEmit) {
        state.firstEmitted = true
        state.lastEmitted = now
        heartbeatTraceTimestamps.set(token, now)
        heartbeatEmissionState.set(token, state)
        traceWriter.emit(
          'heartbeatDidReceive',
          {
            tokenHash,
            ageMs,
            attachments: touch.attachments,
          },
          { layer: 'bridge' }
        )
      } else {
        if (loggingConfig.heartbeat) {
          traceWriter.emitLogLine({
            message: 'Heartbeat suppressed',
            level: 'debug',
            logger: 'bridge',
            fields: {
              tokenHash,
              ageMs,
              attachments: touch.attachments,
            },
          })
        }
      }
      res.json({ ok: true })
    } catch (error) {
      console.error('[PortinoServer] heartbeat failed', error)
      res.status(500).json({ error: 'heartbeat_failed' })
    }
  })

  app.post('/control/detach', (req, res) => {
    try {
      const token =
        typeof req.body?.token === 'string' ? req.body.token : undefined
      if (!token) {
        res.status(400).json({ error: 'missing_token' })
        return
      }
      const remaining = attachmentRegistry.detach(token)
      emitHeartbeatSummary(hashToken(token), 'detach')
      heartbeatTraceTimestamps.delete(token)
      res.json({ remaining })
    } catch (error) {
      console.error('[PortinoServer] detach failed', error)
      res.status(500).json({ error: 'detach_failed' })
    }
  })

  /* curl -s -X POST http://127.0.0.1:55888/control/logging -H 'Content-Type: application/json' -d '{"heartbeat": true}' */
  app.post('/control/logging', (req, res) => {
    try {
      if (typeof req.body?.heartbeat === 'boolean') {
        loggingConfig.heartbeat = req.body.heartbeat
        logEntry('info', ['Logging config updated'], {
          heartbeat: loggingConfig.heartbeat,
        })
      }
      res.json({ logging: loggingConfig })
    } catch (error) {
      console.error('[PortinoServer] logging config failed', error)
      res.status(500).json({ error: 'logging_config_failed' })
    }
  })

  // POST to avoid any caching
  app.post('/control/health', (_req, res) => {
    const heartbeatEnabled = attachmentRegistry.heartbeatTimeoutMs > 0
    const heartbeatStatus = heartbeatEnabled
      ? 'enabled'
      : 'disabled (heartbeatTimeoutMs=0)'
    res.json({
      ok: true,
      status: 'ok',
      attachments: attachmentRegistry.size,
      pid: bridgeIdentity.pid,
      version: bridgeIdentity.version,
      mode: bridgeIdentity.mode,
      port: bridgeIdentity.port,
      startedAt: bridgeIdentity.startedAt,
      extensionPath: bridgeIdentity.extensionPath,
      commit: bridgeIdentity.commit,
      nodeVersion: bridgeIdentity.nodeVersion,
      platform: bridgeIdentity.platform,
      logging: loggingConfig,
      timeouts: {
        idleTimeoutMs: attachmentRegistry.idleTimeoutMs,
        heartbeatTimeoutMs: attachmentRegistry.heartbeatTimeoutMs,
        heartbeatSweepMs: attachmentRegistry.heartbeatSweepMs,
        heartbeatStatus,
      },
    })
  })

  app.get('/control/state', (_req, res) => {
    const ports = []
    for (const entry of portinoPorts.values()) {
      const status = entry.monitor?.isPaused?.()
        ? 'paused'
        : entry.monitor
          ? 'running'
          : 'stopped'
      const subscribers = Array.from(entry.subscribers.entries()).map(
        ([monitorId, clientId]) => ({
          monitorId,
          clientId,
        })
      )
      ports.push({
        portKey: entry.basePortKey,
        status,
        subscribers,
      })
    }
    res.json({
      timestamp: new Date().toISOString(),
      ports,
    })
  })

  const describeDetectedPorts = () => {
    const state = watcher?.state ?? {}
    return Object.entries(state).map(([portKey, entry]) => ({
      portKey,
      port: toPortIdentifier(entry.port),
      boards: (entry?.boards ?? []).map((board) => ({
        name: board.name,
        fqbn: board.fqbn,
      })),
    }))
  }

  const describeActiveStreams = () => {
    const streams = []
    for (const entry of portinoPorts.values()) {
      const clientIds = Array.from(new Set(entry.subscribers.values()))
      streams.push({
        portKey: entry.basePortKey,
        monitorSessionId: entry.sessionId,
        clientCount: clientIds.length,
        clientIds,
      })
    }
    return streams
  }

  const describeRunningMonitors = () => {
    const monitors = []
    for (const [portKey, info] of runningMonitorsByKey.entries()) {
      const clientCount = Array.from(portinoPorts.values()).reduce(
        (count, entry) =>
          entry.basePortKey === portKey
            ? count + new Set(entry.subscribers.values()).size
            : count,
        0
      )
      monitors.push({
        portKey,
        port: info.port,
        baudrate: info.baudrate,
        monitorSessionId: info.monitorSessionId,
        clientCount,
      })
    }
    return monitors
  }

  const describePortinoConnections = () => {
    return Array.from(portinoConnections).map(({ clientId }) => ({
      clientId: clientId ?? null,
    }))
  }

  app.get('/metrics', (_req, res) => {
    try {
      /** @type {Record<string, number>} */
      const counts = {}
      for (const entry of portinoPorts.values()) {
        counts[entry.basePortKey] = new Set(entry.subscribers.values()).size
      }
      v(
        `[metrics] ws=${portinoConnections.size} active=${JSON.stringify(
          counts
        )}`
      )
    } catch {
      // ignore logging failures
    }
    const detectedPorts = describeDetectedPorts()
    const activeStreams = describeActiveStreams()
    const runningMonitors = describeRunningMonitors()
    const monitorRefs = cliBridge.getMonitorSummaries()
    res.json({
      timestamp: new Date().toISOString(),
      host,
      bridgePort: boundPort,
      httpBaseUrl,
      wsBaseUrl,
      attachments: {
        total: attachmentRegistry.size,
      },
      connections: {
        wsConnections: portinoConnections.size,
        details: describePortinoConnections(),
      },
      clientConnectCount,
      globalClientCount: portinoClients.size,
      detectedPorts,
      runningMonitors,
      activeStreams,
      monitorRefs,
      cliBridge: {
        selectedBaudrates: cliBridge.selectedBaudrates,
        suspendedPortKeys: cliBridge.suspendedPortKeys,
      },
    })
  })

  app.get('/metrics/detected-ports', (_req, res) => {
    res.json(describeDetectedPorts())
  })

  const listenPort = options.port ?? 3000
  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off('listening', handleListening)
      reject(error)
    }
    const handleListening = () => {
      server.off('error', handleError)
      resolve(undefined)
    }
    server.once('error', handleError)
    server.listen(listenPort, handleListening)
  })
  const address = server.address()
  const boundPort =
    typeof address === 'object' && address ? address.port : listenPort
  httpBaseUrl = `http://${host}:${boundPort}`
  wsBaseUrl = `ws://${host}:${boundPort}/serial`
  bridgeIdentity.port = boundPort
  logEntry('info', [formatBridgeIdentityBanner(bridgeIdentity)])
  bridgeLog('info', 'Monitor bridge service ready', {
    httpBaseUrl,
    wsBaseUrl,
  })
  /**
   * Tracks currently running monitors opened via the Portino WS API.
   *
   * @type {Map<
   *   string,
   *   {
   *     port: import('boards-list').PortIdentifier
   *     baudrate?: string
   *     monitorSessionId?: string
   *   }
   * >}
   */
  const runningMonitorsByKey = new Map()
  const monitorSessionBaudrates = new Map()

  function toPortIdentifier(port) {
    return typeof port?.toJSON === 'function' ? port.toJSON() : port
  }

  const createMonitorSessionId = () =>
    `ms_${Date.now()}_${randomUUID().slice(0, 8)}`

  /**
   * @type {Map<
   *   string,
   *   { messageConnection: import('vscode-jsonrpc').MessageConnection }
   * >}
   */
  const portinoControlClients = new Map()
  /** @type {Map<string, WsSocket>} */
  const portinoDataConnections = new Map()
  /**
   * @type {Map<
   *   string,
   *   { monitorIds: Set<number>; monitorIdsByPortKey: Map<string, number> }
   * >}
   */
  const portinoClients = new Map()
  /** @type {Map<number, { clientId: string; portKey: string }>} */
  const portinoMonitors = new Map()
  /**
   * @type {Map<
   *   string,
   *   {
   *     portKey: string
   *     basePortKey: string
   *     port: import('boards-list').PortIdentifier
   *     monitor?: import('./monitor.js').PortinoMonitor
   *     monitorIds: Set<number>
   *     subscribers: Map<number, string>
   *     ringBuffer: RingBuffer
   *     openPromise?: Promise<void>
   *     closing?: boolean
   *     sessionId: string
   *     config: { baudrate?: string; optionsHash: string }
   *     monitorStarted?: boolean
   *     writeChain?: Promise<void>
   *   }
   * >}
   */
  const portinoPorts = new Map()
  /** @type {Map<string, string>} */
  const portinoPortKeyByBase = new Map()
  let nextMonitorId = 1

  const resolvePortinoEntryByBaseKey = (basePortKey) => {
    const portKey = portinoPortKeyByBase.get(basePortKey)
    if (!portKey) {
      return undefined
    }
    return portinoPorts.get(portKey)
  }

  const resolveMonitorSessionId = (basePortKey) => {
    return (
      resolvePortinoEntryByBaseKey(basePortKey)?.sessionId ??
      runningMonitorsByKey.get(basePortKey)?.monitorSessionId
    )
  }

  const allocateMonitorId = () => {
    const next = nextMonitorId++ >>> 0
    if (next === 0) {
      nextMonitorId = 1
      return allocateMonitorId()
    }
    return next
  }

  const createPortinoError = (code, message, status, extra = {}) =>
    new ResponseError(-32000, message, { code, status, ...extra })

  const parseMonitorPortKey = (portKey) => {
    if (typeof portKey !== 'string' || !portKey) {
      throw createPortinoError('invalid-port-key', 'Invalid portKey', 400)
    }
    const firstAt = portKey.indexOf('@')
    const secondAt = portKey.indexOf('@', firstAt + 1)
    if (firstAt <= 0 || secondAt <= firstAt + 1 || secondAt >= portKey.length) {
      throw createPortinoError('invalid-port-key', 'Invalid portKey', 400)
    }
    const basePortKey = portKey.slice(0, firstAt)
    const baudratePart = portKey.slice(firstAt + 1, secondAt)
    const optionsHash = portKey.slice(secondAt + 1)
    if (!optionsHash) {
      throw createPortinoError('invalid-port-key', 'Invalid portKey', 400)
    }
    let port
    try {
      port = parsePortKey(basePortKey)
    } catch {
      throw createPortinoError('invalid-port-key', 'Invalid portKey', 400)
    }
    const baudrate =
      baudratePart && baudratePart !== 'na' ? baudratePart : undefined
    return {
      portKey,
      basePortKey,
      port,
      baudrate,
      optionsHash,
    }
  }

  const resolvePortinoClient = (clientId) => {
    let entry = portinoClients.get(clientId)
    if (!entry) {
      entry = {
        monitorIds: new Set(),
        monitorIdsByPortKey: new Map(),
      }
      portinoClients.set(clientId, entry)
    }
    return entry
  }

  const getMonitorRefCount = (entry) => entry.subscribers.size

  const sendPortinoDataFrame = (clientId, monitorId, kind, payload) => {
    const socket = portinoDataConnections.get(clientId)
    if (!socket || socket.readyState !== 1) {
      return
    }
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    const frame = Buffer.allocUnsafe(5 + buffer.length)
    frame.writeUInt32LE(monitorId, 0)
    frame.writeUInt8(kind, 4)
    buffer.copy(frame, 5)
    try {
      socket.send(frame, { binary: true })
    } catch (error) {
      console.warn('[portino][control] ws data send failed', error)
    }
  }

  const ensureMonitorSettings = async (protocol, baudrate) => {
    try {
      const result = await cliBridge.fetchMonitorSettingsForProtocol(
        String(protocol)
      )
      const settingsOrError = result[String(protocol)]
      if (settingsOrError instanceof Error) {
        const msg = settingsOrError.message || String(settingsOrError)
        throw createPortinoError(
          'protocol-error',
          `Monitor unavailable for protocol ${protocol}: ${msg}`,
          400
        )
      }
      const settings = settingsOrError
      const hasBaudrate = Array.isArray(settings)
        ? !!settings.find((setting) => setting.settingId === 'baudrate')
        : false
      if (hasBaudrate && typeof baudrate !== 'string') {
        throw createPortinoError(
          'baudrate-required',
          'Baudrate required for this protocol',
          400
        )
      }
    } catch (error) {
      if (error instanceof ResponseError) {
        throw error
      }
      const msg = String(/** @type {any} */ (error)?.message || error)
      throw createPortinoError(
        'settings-unavailable',
        `Failed to resolve monitor settings for ${protocol}: ${msg}`,
        400
      )
    }
  }

  const ensurePortinoEntry = async (parsed) => {
    const existingKey = portinoPortKeyByBase.get(parsed.basePortKey)
    if (existingKey && existingKey !== parsed.portKey) {
      const current = portinoPorts.get(existingKey)
      const currentConfig = current
        ? {
            portKey: current.portKey,
            baudrate: current.config.baudrate,
            optionsHash: current.config.optionsHash,
          }
        : {
            portKey: existingKey,
          }
      throw createPortinoError(
        'PORT_IN_USE_DIFFERENT_CONFIG',
        'Port already open with different config',
        409,
        {
          portPath: parsed.port?.address ?? parsed.basePortKey,
          currentConfig,
          requestedConfig: {
            portKey: parsed.portKey,
            baudrate: parsed.baudrate,
            optionsHash: parsed.optionsHash,
          },
        }
      )
    }

    let entry = portinoPorts.get(parsed.portKey)
    if (entry) {
      return entry
    }

    const isPortDetected = Boolean(watcher?.state?.[parsed.basePortKey])
    if (!isPortDetected) {
      throw createPortinoError(
        'port-not-detected',
        `Port ${parsed.port?.address ?? parsed.basePortKey} is not detected.`,
        404
      )
    }

    await ensureMonitorSettings(parsed.port?.protocol, parsed.baudrate)

    entry = {
      portKey: parsed.portKey,
      basePortKey: parsed.basePortKey,
      port: parsed.port,
      monitor: undefined,
      monitorIds: new Set(),
      subscribers: new Map(),
      ringBuffer: new RingBuffer(0),
      sessionId: createMonitorSessionId(),
      config: {
        baudrate: parsed.baudrate,
        optionsHash: parsed.optionsHash,
      },
      writeChain: Promise.resolve(),
    }
    portinoPorts.set(parsed.portKey, entry)
    portinoPortKeyByBase.set(parsed.basePortKey, parsed.portKey)
    return entry
  }

  const closePortinoEntry = async (entry, reason, clientId) => {
    if (entry.closing) {
      return
    }
    entry.closing = true
    const monitor = entry.monitor
    entry.monitor = undefined
    entry.openPromise = undefined
    if (monitor) {
      try {
        await monitor.dispose?.()
      } catch {}
    }
    try {
      await cliBridge.releaseMonitor(entry.port)
    } catch (error) {
      console.error('Error releasing monitor:', error)
    }
    if (entry.monitorStarted) {
      notifyMonitorStopped(entry.basePortKey, entry.port, entry.sessionId)
      entry.monitorStarted = false
    }
    console.log('[portino][control] port closed', {
      portKey: entry.portKey,
      clientId,
      refCount: getMonitorRefCount(entry),
      reason,
    })
    entry.closing = false
  }

  const dropPortinoEntryIfIdle = (entry) => {
    if (entry.monitorIds.size > 0) {
      return
    }
    portinoPorts.delete(entry.portKey)
    if (portinoPortKeyByBase.get(entry.basePortKey) === entry.portKey) {
      portinoPortKeyByBase.delete(entry.basePortKey)
    }
  }

  const startPortinoMonitorLoop = (entry, monitor, respIterator, buffered) => {
    ;(async () => {
      try {
        if (buffered.length) {
          for (const buf of buffered) {
            entry.ringBuffer.push(buf)
            for (const [monitorId, clientId] of entry.subscribers.entries()) {
              sendPortinoDataFrame(clientId, monitorId, 0, buf)
            }
          }
          buffered.length = 0
        }
        while (true) {
          const { value: chunk, done } = await respIterator.next()
          if (done) break
          const buf = Buffer.from(chunk)
          entry.ringBuffer.push(buf)
          for (const [monitorId, clientId] of entry.subscribers.entries()) {
            sendPortinoDataFrame(clientId, monitorId, 0, buf)
          }
        }
      } catch (error) {
        const name = /** @type {any} */ (error)?.name || ''
        const msg = String(
          (error && /** @type {any} */ (error).details) || error || ''
        )
        const isAbort = name === 'AbortError' || /aborted/i.test(msg)
        if (!isAbort) {
          console.error('Portino data stream error:', error)
        }
      } finally {
        if (entry.monitor === monitor) {
          await closePortinoEntry(entry, 'stream-ended')
        }
      }
    })()
  }

  const openPortinoMonitorIfNeeded = async (entry, clientId) => {
    if (entry.monitor) {
      return entry.monitor
    }
    if (entry.openPromise) {
      await entry.openPromise
      if (!entry.monitor) {
        throw createPortinoError(
          'monitor-open-failed',
          'Monitor open failed',
          502
        )
      }
      return entry.monitor
    }

    entry.openPromise = (async () => {
      const onDidChangeBaudrate = () => {}
      /** @type {import('./monitor.js').PortinoMonitor} */
      let monitor
      try {
        monitor = await cliBridge.acquireMonitor(
          {
            port: Port.fromJSON(entry.port),
            baudrate: entry.config.baudrate,
          },
          onDidChangeBaudrate
        )
        entry.monitor = monitor
      } catch (err) {
        const message = String((err && /** @type {any} */ (err).details) || err)
        if (message.includes('Serial port busy')) {
          throw createPortinoError('port-busy', 'Serial port busy', 423)
        }
        if (/no such file or directory/i.test(message)) {
          throw createPortinoError(
            'port-not-detected',
            `Port ${entry.port?.address ?? entry.basePortKey} is not detected.`,
            404
          )
        }
        const stillDetected = Boolean(watcher?.state?.[entry.basePortKey])
        if (!stillDetected) {
          throw createPortinoError(
            'port-not-detected',
            `Port ${entry.port?.address ?? entry.basePortKey} is not detected.`,
            404
          )
        }
        throw createPortinoError('monitor-open-failed', message, 502)
      }

      const respIterator = monitor.messages[Symbol.asyncIterator]()
      startPortinoMonitorLoop(entry, monitor, respIterator, [])
      try {
        let readyTimedOut = false
        await Promise.race([
          monitor.ready,
          new Promise((resolve) =>
            setTimeout(() => {
              readyTimedOut = true
              resolve(undefined)
            }, MONITOR_READY_TIMEOUT_MS)
          ),
        ])
        if (readyTimedOut) {
          bridgeLog('info', 'Monitor ready timed out; streaming anyway', {
            portKey: entry.portKey,
          })
        }
      } catch (err) {
        entry.monitor = undefined
        try {
          await cliBridge.releaseMonitor(entry.port)
        } catch {}
        if (err instanceof ClientError) {
          if (err.details.includes('Serial port busy')) {
            throw createPortinoError('port-busy', 'Serial port busy', 423)
          }
          if (/no such file or directory/i.test(err.details)) {
            throw createPortinoError(
              'port-not-detected',
              `Port ${entry.port?.address ?? entry.basePortKey} is not detected.`,
              404
            )
          }
          const stillDetected = Boolean(watcher?.state?.[entry.basePortKey])
          if (!stillDetected) {
            throw createPortinoError(
              'port-not-detected',
              `Port ${entry.port?.address ?? entry.basePortKey} is not detected.`,
              404
            )
          }
          throw createPortinoError('monitor-open-failed', err.details, 502)
        }
        const message = String(/** @type {any} */ (err)?.message || err)
        if (/no such file or directory/i.test(message)) {
          throw createPortinoError(
            'port-not-detected',
            `Port ${entry.port?.address ?? entry.basePortKey} is not detected.`,
            404
          )
        }
        throw createPortinoError('monitor-open-failed', message, 502)
      }

      if (!entry.monitorStarted) {
        entry.monitorStarted = true
        notifyMonitorStarted(
          entry.basePortKey,
          entry.port,
          entry.config.baudrate,
          entry.sessionId
        )
        console.log('[portino][control] port opened', {
          portKey: entry.portKey,
          clientId,
          refCount: getMonitorRefCount(entry),
        })
      }
    })()

    try {
      await entry.openPromise
    } finally {
      entry.openPromise = undefined
    }

    if (!entry.monitor) {
      throw createPortinoError(
        'monitor-open-failed',
        'Monitor open failed',
        502
      )
    }
    return entry.monitor
  }

  const closePortinoMonitor = async (monitorId, reason) => {
    const monitorEntry = portinoMonitors.get(monitorId)
    if (!monitorEntry) {
      return { ok: true }
    }
    const entry = portinoPorts.get(monitorEntry.portKey)
    if (entry) {
      entry.subscribers.delete(monitorId)
      entry.monitorIds.delete(monitorId)
      console.log('[portino][control] monitor closed', {
        portKey: entry.portKey,
        clientId: monitorEntry.clientId,
        refCount: getMonitorRefCount(entry),
        reason,
      })
      if (entry.subscribers.size === 0 && entry.monitor) {
        await closePortinoEntry(entry, reason, monitorEntry.clientId)
      }
      dropPortinoEntryIfIdle(entry)
    }
    portinoMonitors.delete(monitorId)
    const clientEntry = portinoClients.get(monitorEntry.clientId)
    if (clientEntry) {
      clientEntry.monitorIds.delete(monitorId)
      clientEntry.monitorIdsByPortKey.delete(monitorEntry.portKey)
    }
    return { ok: true }
  }

  const cleanupPortinoClient = async (clientId, reason) => {
    const clientEntry = portinoClients.get(clientId)
    if (clientEntry) {
      for (const monitorId of Array.from(clientEntry.monitorIds)) {
        await closePortinoMonitor(monitorId, reason)
      }
    }
    const dataSocket = portinoDataConnections.get(clientId)
    if (dataSocket) {
      try {
        dataSocket.close()
      } catch {}
    }
    portinoClients.delete(clientId)
    portinoDataConnections.delete(clientId)
    portinoControlClients.delete(clientId)
    console.log('[portino][control] client cleanup', { clientId, reason })
  }

  function notifyMonitorStarted(portKey, port, baudrate, monitorSessionId) {
    const portJson = toPortIdentifier(port)
    const existing = runningMonitorsByKey.get(portKey)
    const finalBaudrate = baudrate ?? existing?.baudrate
    if (!existing) {
      runningMonitorsByKey.set(portKey, {
        port: portJson,
        baudrate: finalBaudrate,
        monitorSessionId,
      })
      traceWriter.emit(
        'monitorDidStart',
        {
          baudrate: finalBaudrate,
          paused: false,
        },
        {
          layer: 'bridge',
          monitorSessionId,
          portKey,
        }
      )
      broadcastMonitorDidStart(portJson, finalBaudrate, monitorSessionId)
      bridgeLog('info', 'Monitor started', {
        port: portJson,
        baudrate: finalBaudrate,
        monitorSessionId,
      })
    } else {
      runningMonitorsByKey.set(portKey, {
        port: portJson,
        baudrate: finalBaudrate,
        monitorSessionId: monitorSessionId ?? existing?.monitorSessionId,
      })
    }
    const sessionIdToSet = monitorSessionId ?? existing?.monitorSessionId
    if (sessionIdToSet) {
      monitorSessionBaudrates.set(sessionIdToSet, finalBaudrate)
    }
  }

  function notifyMonitorStopped(portKey, port, monitorSessionId) {
    if (runningMonitorsByKey.delete(portKey)) {
      traceWriter.emit(
        'monitorDidStop',
        {
          reason: 'last-client',
        },
        {
          layer: 'bridge',
          monitorSessionId,
          portKey,
        }
      )
      bridgeLog('info', 'Monitor stopped', {
        port: toPortIdentifier(port),
        monitorSessionId,
      })
      broadcastMonitorDidStop(toPortIdentifier(port), monitorSessionId)
      if (monitorSessionId) {
        monitorSessionBaudrates.delete(monitorSessionId)
      }
    }
  }

  function updateMonitorBaudrate(portKey, port, baudrate) {
    if (!baudrate) {
      return false
    }
    const existing = runningMonitorsByKey.get(portKey)
    const sessionId = existing?.monitorSessionId
    const previousBaudrate = existing?.baudrate
    if (previousBaudrate === baudrate) {
      if (sessionId) {
        monitorSessionBaudrates.set(sessionId, baudrate)
      }
      return false
    }
    runningMonitorsByKey.set(portKey, {
      port: toPortIdentifier(port),
      baudrate,
      monitorSessionId: sessionId,
    })
    if (sessionId) {
      const oldBaudrate = monitorSessionBaudrates.get(sessionId)
      monitorSessionBaudrates.set(sessionId, baudrate)
      emitMonitorDidChangeBaudrate(sessionId, portKey, oldBaudrate, baudrate)
    }
    return true
  }

  function emitMonitorDidChangeBaudrate(
    sessionId,
    portKey,
    oldBaudrate,
    newBaudrate
  ) {
    if (oldBaudrate === newBaudrate) {
      return
    }
    traceWriter.emit(
      'monitorDidChangeBaudrate',
      {
        oldBaudrate,
        newBaudrate,
        origin: 'bridge',
      },
      {
        layer: 'bridge',
        monitorSessionId: sessionId,
        portKey,
      }
    )
    bridgeLog('info', 'Monitor baudrate changed', {
      portKey,
      monitorSessionId: sessionId,
      oldBaudrate,
      newBaudrate,
    })
  }

  /**
   * @type {(
   *   predicate?: (portinoConnection: PortinoConnection) => boolean
   * ) => (
   *   event: import('@boardlab/protocol').DidChangeBaudrateNotification
   * ) => void}
   */
  const createNotifyDidChangeBaudrateCallback = (predicate) => {
    return (event) => {
      portinoConnections.forEach((portinoConnection) => {
        if (predicate && !predicate(portinoConnection)) return

        safeNotify(portinoConnection, NotifyDidChangeBaudrate, event)
      })
    }
  }

  const broadcastMonitorDidPause = (port) => {
    portinoConnections.forEach((connection) => {
      safeNotify(connection, NotifyMonitorDidPause, { port })
    })
  }

  const broadcastMonitorDidResume = (port, resumedPort = port) => {
    portinoConnections.forEach((connection) => {
      safeNotify(connection, NotifyMonitorDidResume, {
        didPauseOnPort: port,
        didResumeOnPort: resumedPort,
      })
    })
  }

  const broadcastMonitorDidStart = (port, baudrate, monitorSessionId) => {
    portinoConnections.forEach((connection) => {
      safeNotify(connection, NotifyMonitorDidStart, {
        port,
        baudrate,
        monitorSessionId,
      })
    })
  }

  const broadcastMonitorDidStop = (port, monitorSessionId) => {
    portinoConnections.forEach((connection) => {
      safeNotify(connection, NotifyMonitorDidStop, {
        port,
        monitorSessionId,
      })
    })
  }

  watcher.emitter.on('update', async () => {
    // Track seen protocols and proactively fetch their monitor settings
    try {
      const detectedPorts = watcher.state
      const protocols = new Set(knownProtocols)
      for (const detected of Object.values(detectedPorts)) {
        const p = detected.port?.protocol
        if (p) protocols.add(p)
      }
      // Update known protocols set
      protocols.forEach((p) => knownProtocols.add(p))
      await cliBridge.fetchMonitorSettingsForProtocol(...protocols)
      const monitorSettingsSnapshot = await buildMonitorSettingsSnapshot()
      const detectedPortKeys = Object.keys(detectedPorts)
      const currentKeySet = new Set(detectedPortKeys)
      const added = detectedPortKeys.filter(
        (key) => !previousDetectedPortKeys.has(key)
      )
      const removed = Array.from(previousDetectedPortKeys).filter(
        (key) => !currentKeySet.has(key)
      )
      previousDetectedPortKeys = currentKeySet
      const sanitizedPorts = createSanitizedPortSnapshot(detectedPorts)
      const { changed, snapshot } = recordSanitizedPortSnapshot(
        sanitizedPorts,
        previousSanitizedPortsSnapshot
      )
      previousSanitizedPortsSnapshot = snapshot
      traceWriter.emit(
        'portsDidUpdate',
        {
          count: detectedPortKeys.length,
          added: added.length,
          removed: removed.length,
          changed,
          ports: sanitizedPorts,
        },
        { layer: 'bridge' }
      )
      bridgeLog('info', 'Detected ports updated', {
        detectedPortKeys,
        protocols: Array.from(protocols),
      })
      // Broadcast settings to all clients
      portinoConnections.forEach((connection) =>
        safeNotify(
          connection,
          NotifyDidChangeMonitorSettings,
          monitorSettingsSnapshot
        )
      )
    } catch (e) {
      console.error('Failed to refresh monitor settings:', e)
    }
  })

  wss.on('connection', (ws) => {
    /** @type {import('vscode-ws-jsonrpc').IWebSocket} */
    const socket = {
      send: ws.send.bind(ws),
      onMessage: ws.on.bind(ws, 'message'),
      onError: ws.on.bind(ws, 'error'),
      onClose: ws.on.bind(ws, 'close'),
      dispose: ws.close.bind(ws),
    }

    // Create and start the JSON-RPC connection
    const logger = new BridgeWebSocketLogger(baseConsoleFunctions)
    const messageConnection = createWebSocketConnection(socket, logger)
    const portinoConnection = { messageConnection, closed: false }
    portinoConnections.add(portinoConnection)

    // Forward board list updates to client
    const updateHandler = () => {
      const detectedPorts = watcher.state
      const detectedPortKeys = Object.keys(detectedPorts)
      const sanitizedPorts = createSanitizedPortSnapshot(detectedPorts)
      bridgeLog('info', 'Detected ports pushed to client', {
        detectedPortKeys,
      })
      safeNotify(portinoConnection, NotifyDidChangeDetectedPorts, detectedPorts)
      emitPortsTraceEvent(traceWriter, detectedPortKeys, sanitizedPorts)
    }
    watcher.emitter.on('update', updateHandler)
    const disposables = [
      {
        dispose: () => {
          watcher.emitter.off('update', updateHandler)
        },
      },
    ]
    disposables.push(
      messageConnection.onError((error) => {
        bridgeLog('warn', 'Client rpc error', {
          clientId: portinoConnection.clientId,
          message: String(error instanceof Error ? error?.message : error),
        })
      })
    )

    // Now start listening for incoming JSON-RPC messages
    messageConnection.listen()

    // broadcast the initial detected ports
    safeNotify(portinoConnection, NotifyDidChangeDetectedPorts, watcher.state)

    const onDidChangeBaudrate = createNotifyDidChangeBaudrateCallback(
      (connection) => connection.messageConnection !== messageConnection // Exclude the current connection
    )
    disposables.push(
      messageConnection.onRequest(RequestDetectedPorts, () => watcher.state),
      messageConnection.onRequest(
        RequestUpdateBaudrate.method,
        async (params) => {
          v(
            `[serial] RequestUpdateBaudrate port=${createPortKey(
              params.port
            )} baud=${params.baudrate}`
          )
          const portKey = createPortKey(params.port)
          const current = runningMonitorsByKey.get(portKey)
          const currentBaudrate = current?.baudrate
          if (currentBaudrate && currentBaudrate === params.baudrate) {
            traceWriter.emitLogLine({
              message: 'Monitor baudrate unchanged',
              level: 'debug',
              logger: 'bridge',
              fields: {
                portKey,
                monitorSessionId: current?.monitorSessionId,
                baudrate: params.baudrate,
              },
            })
            return true
          }
          try {
            // Prefer updating via cliBridge (source of truth for monitors)
            await cliBridge.updateBaudrate(
              params.port,
              params.baudrate,
              onDidChangeBaudrate
            )
            v('[serial] baudrate updated via cliBridge')
            updateMonitorBaudrate(
              createPortKey(params.port),
              params.port,
              params.baudrate
            )
          } catch {
            // Fallback: if cliBridge lost the monitor reference but we still have
            // an active stream entry (e.g., during rapid reselect), update it
            // directly to avoid surfacing an error to the client.
            const portKey = createPortKey(params.port)
            const entry = resolvePortinoEntryByBaseKey(portKey)
            if (entry?.monitor) {
              await entry.monitor.updateBaudrate(params.baudrate)
              // Notify other clients about the change to keep UI in sync
              onDidChangeBaudrate({
                port: params.port,
                baudrate: params.baudrate,
              })
              v('[serial] baudrate updated via portino entry')
              updateMonitorBaudrate(portKey, entry.port, params.baudrate)
            }
            // No active stream/monitor for this port: ignore as a no-op.
            // The next monitor acquisition will use the provided baudrate.
            if (!entry || !entry.monitor) {
              v('[serial] baudrate update ignored (no active monitor)')
            }
          }
        }
      ),
      messageConnection.onRequest(RequestSendMonitorMessage, (params) => {
        const { port, message } = params
        const portKey = createPortKey(port)
        const entry = resolvePortinoEntryByBaseKey(portKey)
        if (!entry) {
          throw new Error(`No active monitor for port: ${portKey}`)
        }
        v(`[serial] send message to ${portKey} (${message?.length ?? 0} bytes)`)
        return openPortinoMonitorIfNeeded(
          entry,
          portinoConnection.clientId
        ).then(() => entry.monitor?.sendMessage(message))
      }),
      messageConnection.onRequest(RequestPauseMonitor, async (params) => {
        const portKey = createPortKey(params.port)
        v(`[serial] RequestPauseMonitor port=${portKey}`)
        try {
          const paused = await cliBridge.pauseMonitor(params.port)
          if (paused) {
            broadcastMonitorDidPause(params.port)
            bridgeLog('info', 'Monitor paused', {
              port: params.port,
              portKey,
              monitorSessionId: resolveMonitorSessionId(portKey),
            })
            traceWriter.emit(
              'monitorDidSuspend',
              {
                reason: 'task',
                released: true,
              },
              {
                layer: 'bridge',
                portKey,
                monitorSessionId: resolveMonitorSessionId(portKey),
              }
            )
            v(`[serial] monitor paused via RPC ${portKey}`)
          }
          return paused
        } catch (error) {
          console.error('Failed to pause monitor', error)
          throw error
        }
      }),
      messageConnection.onRequest(RequestResumeMonitor, async (params) => {
        const portKey = createPortKey(params.port)
        v(`[serial] RequestResumeMonitor port=${portKey}`)
        try {
          const resumed = await cliBridge.resumeMonitor(params.port)
          const entry = resolvePortinoEntryByBaseKey(portKey)
          const shouldNotify =
            resumed || entry || runningMonitorsByKey.has(portKey)
          if (shouldNotify) {
            broadcastMonitorDidResume(params.port)
            bridgeLog('info', 'Monitor resumed', {
              port: params.port,
              portKey,
              monitorSessionId: resolveMonitorSessionId(portKey),
            })
            const resumedSessionId = resolveMonitorSessionId(portKey)
            traceWriter.emit(
              'monitorDidResume',
              {
                portChanged: false,
                newPortKey: portKey,
              },
              {
                layer: 'bridge',
                portKey,
                monitorSessionId: resumedSessionId,
              }
            )
            const entryBaudrate = entry?.config?.baudrate
            const baudrate =
              entryBaudrate ?? runningMonitorsByKey.get(portKey)?.baudrate
            notifyMonitorStarted(
              portKey,
              entry?.port ?? params.port,
              baudrate,
              resumedSessionId
            )
            v(`[serial] monitor resumed via RPC ${createPortKey(params.port)}`)
          }
          return shouldNotify
        } catch (error) {
          console.error('Failed to resume monitor', error)
          throw error
        }
      }),
      messageConnection.onRequest(RequestClientConnect, async (params) => {
        const { clientId, selectedPort, selectedBaudrate } = params
        if (!portinoConnection) {
          throw new Error(`Connection not found for clientId: ${clientId}`)
        }

        if (portinoConnection.clientId) {
          throw new Error(
            `Client already connected with clientId: ${portinoConnection.clientId}, new clientId: ${clientId}`
          )
        }

        portinoConnection.clientId = clientId
        clientConnectCount += 1
        bridgeLog('info', `Client connected: ${clientId}`, {
          clientId,
          selectedPort,
          selectedBaudrate,
        })
        traceWriter.emit(
          'clientDidConnect',
          {
            selectedBaudrate,
          },
          {
            layer: 'bridge',
            clientId,
            portKey: selectedPort ? createPortKey(selectedPort) : undefined,
          }
        )

        // Update the selected baudrate for this port if given
        if (selectedPort && selectedBaudrate) {
          // TODO: merge in the baudrate for the selected port (if any)
          // await cliBridge.updateBaudrate(
          //   selectedPort,
          //   selectedBaudrate,
          //   onDidChangeBaudrate
          // );
        }

        const monitorSettingsByProtocol = await buildMonitorSettingsSnapshot()
        const { selectedBaudrates, suspendedPortKeys } = cliBridge
        const detectedPorts = watcher.state
        const runningMonitors = Array.from(runningMonitorsByKey.values())

        /** @type {import('@boardlab/protocol').HostConnectClientResult} */
        const result = {
          detectedPorts,
          monitorSettingsByProtocol,
          selectedBaudrates,
          suspendedPortKeys,
          runningMonitors,
        }
        return result
      }),
      messageConnection.onNotification(NotifyTraceEvent, (evt) => {
        traceWriter.emit(evt.event, evt.data ?? {}, {
          layer: evt.src?.layer ?? 'ext',
          monitorSessionId: evt.monitorSessionId,
          clientId: evt.clientId,
          portKey: evt.portKey,
          webviewId: evt.webviewId,
          webviewType: evt.webviewType,
        })
      })
    )

    // Clean up when client disconnects
    ws.on('close', (code, reasonBuffer) => {
      if (portinoConnection) {
        portinoConnection.closed = true
        portinoConnections.delete(portinoConnection)
        let reason = ''
        if (typeof reasonBuffer === 'string') {
          reason = reasonBuffer
        } else if (reasonBuffer instanceof Buffer) {
          reason = reasonBuffer.toString('utf8')
        }
        bridgeLog('info', 'Client disconnected', {
          clientId: portinoConnection.clientId,
          code,
          reason: reason || undefined,
        })
        traceWriter.emit(
          'clientDidDisconnect',
          { reason: 'ws-close' },
          {
            layer: 'bridge',
            clientId: portinoConnection.clientId,
          }
        )
      }

      messageConnection.dispose()
      disposables.forEach((d) => d.dispose())
    })
    ws.on('error', (error) => {
      bridgeLog('warn', 'Client connection error', {
        clientId: portinoConnection.clientId,
        message: String(error?.message || error),
      })
    })
  })

  const resolvePortinoClientId = (req) => {
    try {
      const url = new URL(req?.url ?? '', httpBaseUrl || 'http://localhost')
      return url.searchParams.get('clientId') ?? ''
    } catch {
      return ''
    }
  }

  controlWss.on('connection', (ws) => {
    const clientId = randomUUID()
    bridgeLog('info', 'Monitor control channel connected', { clientId })

    /** @type {import('vscode-ws-jsonrpc').IWebSocket} */
    const socket = {
      send: ws.send.bind(ws),
      onMessage: ws.on.bind(ws, 'message'),
      onError: ws.on.bind(ws, 'error'),
      onClose: ws.on.bind(ws, 'close'),
      dispose: ws.close.bind(ws),
    }
    const logger = new BridgeWebSocketLogger(baseConsoleFunctions)
    const messageConnection = createWebSocketConnection(socket, logger)
    portinoControlClients.set(clientId, { messageConnection })
    resolvePortinoClient(clientId)

    messageConnection.onRequest(RequestPortinoHello, async () => ({
      serverVersion: bridgeIdentity.version ?? 'unknown',
      protocolVersion: PORTINO_PROTOCOL_VERSION,
      capabilities: PORTINO_CAPABILITIES,
      clientId,
    }))

    messageConnection.onRequest(RequestMonitorOpen, async (params) => {
      const parsed = parseMonitorPortKey(params?.portKey)
      bridgeLog('info', 'Monitor open request', {
        portKey: parsed.portKey,
        basePortKey: parsed.basePortKey,
        clientId,
      })
      const entry = await ensurePortinoEntry(parsed)
      const clientEntry = resolvePortinoClient(clientId)
      const existing = clientEntry.monitorIdsByPortKey.get(parsed.portKey)
      if (existing) {
        bridgeLog('info', 'Monitor open reused', {
          portKey: parsed.portKey,
          clientId,
          monitorId: existing,
        })
        return { monitorId: existing, effectivePortKey: parsed.portKey }
      }
      if (params?.mode === 'exclusive') {
        for (const monitorId of entry.monitorIds) {
          const owner = portinoMonitors.get(monitorId)
          if (owner && owner.clientId !== clientId) {
            throw createPortinoError(
              'PORT_IN_USE_EXCLUSIVE',
              'Port already open by another client',
              409,
              {
                portPath: parsed.port?.address ?? parsed.basePortKey,
              }
            )
          }
        }
      }
      const monitorId = allocateMonitorId()
      entry.monitorIds.add(monitorId)
      portinoMonitors.set(monitorId, {
        clientId,
        portKey: parsed.portKey,
      })
      clientEntry.monitorIds.add(monitorId)
      clientEntry.monitorIdsByPortKey.set(parsed.portKey, monitorId)
      bridgeLog('info', 'Monitor opened', {
        portKey: parsed.portKey,
        clientId,
        refCount: getMonitorRefCount(entry),
      })
      return { monitorId, effectivePortKey: parsed.portKey }
    })

    messageConnection.onRequest(RequestMonitorSubscribe, async (params) => {
      const monitorId = params?.monitorId
      if (typeof monitorId !== 'number') {
        throw createPortinoError('invalid-monitor-id', 'Invalid monitorId', 400)
      }
      const monitorEntry = portinoMonitors.get(monitorId)
      if (!monitorEntry) {
        throw createPortinoError('monitor-not-found', 'Unknown monitorId', 404)
      }
      const entry = portinoPorts.get(monitorEntry.portKey)
      if (!entry) {
        throw createPortinoError('monitor-not-found', 'Unknown monitorId', 404)
      }
      if (!entry.subscribers.has(monitorId)) {
        entry.subscribers.set(monitorId, monitorEntry.clientId)
        bridgeLog('info', 'Monitor subscribe request', {
          portKey: entry.portKey,
          clientId: monitorEntry.clientId,
          monitorId,
        })
        const tailBytes =
          typeof params?.tailBytes === 'number' ? params.tailBytes : 0
        if (tailBytes > 0) {
          entry.ringBuffer.ensureCapacity(tailBytes)
          const tail = entry.ringBuffer.tail(tailBytes)
          if (tail.length) {
            sendPortinoDataFrame(monitorEntry.clientId, monitorId, 0, tail)
          }
        }
        try {
          await openPortinoMonitorIfNeeded(entry, monitorEntry.clientId)
        } catch (error) {
          entry.subscribers.delete(monitorId)
          throw error
        }
        bridgeLog('info', 'Monitor subscribed', {
          portKey: entry.portKey,
          clientId: monitorEntry.clientId,
          refCount: getMonitorRefCount(entry),
        })
      } else if (!entry.monitor) {
        await openPortinoMonitorIfNeeded(entry, monitorEntry.clientId)
      }
      return { ok: true }
    })

    messageConnection.onRequest(RequestMonitorUnsubscribe, async (params) => {
      const monitorId = params?.monitorId
      if (typeof monitorId !== 'number') {
        return { ok: true }
      }
      const monitorEntry = portinoMonitors.get(monitorId)
      if (!monitorEntry) {
        return { ok: true }
      }
      const entry = portinoPorts.get(monitorEntry.portKey)
      if (entry && entry.subscribers.delete(monitorId)) {
        bridgeLog('info', 'Monitor unsubscribed', {
          portKey: entry.portKey,
          clientId: monitorEntry.clientId,
          refCount: getMonitorRefCount(entry),
        })
        if (entry.subscribers.size === 0 && entry.monitor) {
          await closePortinoEntry(entry, 'last-unsubscribe', clientId)
        }
      }
      return { ok: true }
    })

    messageConnection.onRequest(RequestMonitorClose, async (params) => {
      const monitorId = params?.monitorId
      if (typeof monitorId !== 'number') {
        return { ok: true }
      }
      return closePortinoMonitor(monitorId, 'monitor-close')
    })

    messageConnection.onRequest(RequestMonitorWrite, async (params) => {
      const monitorId = params?.monitorId
      if (typeof monitorId !== 'number') {
        throw createPortinoError('invalid-monitor-id', 'Invalid monitorId', 400)
      }
      const monitorEntry = portinoMonitors.get(monitorId)
      if (!monitorEntry) {
        throw createPortinoError('monitor-not-found', 'Unknown monitorId', 404)
      }
      const entry = portinoPorts.get(monitorEntry.portKey)
      if (!entry) {
        throw createPortinoError('monitor-not-found', 'Unknown monitorId', 404)
      }
      if (!entry.subscribers.has(monitorId)) {
        throw createPortinoError(
          'monitor-not-subscribed',
          'Monitor not subscribed',
          409
        )
      }
      await openPortinoMonitorIfNeeded(entry, monitorEntry.clientId)
      const raw = params?.data
      let buffer
      if (raw instanceof Uint8Array) {
        buffer = Buffer.from(raw)
      } else if (raw instanceof ArrayBuffer) {
        buffer = Buffer.from(raw)
      } else if (ArrayBuffer.isView(raw)) {
        buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
      } else if (Array.isArray(raw)) {
        buffer = Buffer.from(raw)
      } else if (isBufferPayload(raw)) {
        buffer = Buffer.from(raw.data)
      } else if (typeof raw === 'string') {
        buffer = Buffer.from(raw)
      } else {
        buffer = Buffer.alloc(0)
      }
      if (!buffer.length) {
        return { bytesWritten: 0 }
      }
      const text = buffer.toString('utf8')
      entry.writeChain = (entry.writeChain ?? Promise.resolve())
        .then(() => {
          entry.monitor?.sendMessage(text)
          console.log('[portino][control] monitor write', {
            portKey: entry.portKey,
            clientId: monitorEntry.clientId,
            bytes: buffer.length,
            ts: new Date().toISOString(),
          })
        })
        .catch((error) => {
          console.error('Monitor write failed', error)
        })
      await entry.writeChain
      return { bytesWritten: buffer.length }
    })

    messageConnection.listen()

    ws.on('close', () => {
      cleanupPortinoClient(clientId, 'control-close').catch((error) => {
        console.error('Failed to cleanup portino client', error)
      })
      messageConnection.dispose()
    })
    ws.on('error', (error) => {
      bridgeLog('warn', 'Monitor control channel error', {
        clientId,
        message: String(error?.message || error),
      })
    })
  })

  dataWss.on('connection', (ws, req) => {
    const clientId = resolvePortinoClientId(req)
    if (!clientId) {
      try {
        ws.close()
      } catch {}
      return
    }
    portinoDataConnections.set(clientId, ws)
    bridgeLog('info', 'Monitor data channel connected', { clientId })

    ws.on('close', () => {
      if (portinoDataConnections.get(clientId) === ws) {
        portinoDataConnections.delete(clientId)
      }
      bridgeLog('info', 'Monitor data channel disconnected', { clientId })
    })
  })
  // Provide a close handle for tests/embedders
  return {
    port: boundPort,
    app,
    httpServer: server,
    attachmentRegistry,
    async close() {
      try {
        watcher.dispose?.()
      } catch {}
      try {
      } catch {}
      try {
        clearInterval(heartbeatSummaryTimer)
      } catch {}
      emitHeartbeatSummaries('shutdown')
      traceWriter.emit(
        'logDidWrite',
        {
          message: 'Trace shutdown: emitting bridgeDidStop',
          level: 'debug',
          logger: 'bridge',
        },
        { layer: 'bridge' }
      )
      traceWriter.emit('bridgeDidStop', { reason: 'exit' }, { layer: 'bridge' })
      traceWriter.emit(
        'logDidWrite',
        {
          message: 'Trace shutdown: closing websocket server',
          level: 'debug',
          logger: 'bridge',
        },
        { layer: 'bridge' }
      )
      try {
        server.off('upgrade', handleUpgrade)
      } catch {}
      try {
        wss.close()
      } catch {}
      try {
        controlWss.close()
      } catch {}
      try {
        dataWss.close()
      } catch {}
      traceWriter.emit(
        'logDidWrite',
        {
          message: 'Trace shutdown: closing HTTP server',
          level: 'debug',
          logger: 'bridge',
        },
        { layer: 'bridge' }
      )
      await new Promise((resolve) => server.close(() => resolve(undefined)))
      traceWriter.emit(
        'logDidWrite',
        {
          message: 'Trace shutdown: closing trace writer',
          level: 'debug',
          logger: 'bridge',
        },
        { layer: 'bridge' }
      )
      await traceWriter.close()
      process.off('exit', onExit)
      if (ownBridge) {
        traceWriter.emit(
          'logDidWrite',
          {
            message: 'Trace shutdown: disposing cli bridge',
            level: 'debug',
            logger: 'bridge',
          },
          { layer: 'bridge' }
        )
        try {
          await cliBridge.dispose()
        } catch {}
      }
      try {
        traceWriter.emit(
          'logDidWrite',
          {
            message: 'Trace shutdown: closing log file stream',
            level: 'debug',
            logger: 'bridge',
          },
          { layer: 'bridge' }
        )
        logFileStream.end()
      } catch {}
      traceWriter.emit(
        'logDidWrite',
        {
          message: 'Trace shutdown: disposing attachment registry',
          level: 'debug',
          logger: 'bridge',
        },
        { layer: 'bridge' }
      )
      attachmentRegistry.dispose()
    },
  }
}

/** @param {Record<string, { port: import('boards-list').Port }>} detectedPorts */
function createSanitizedPortSnapshot(detectedPorts) {
  return Object.keys(detectedPorts)
    .sort()
    .map((portKey) => createSanitizedPortEntry(portKey, detectedPorts[portKey]))
}

/**
 * @param {{ portKey: string }[]} sanitizedPorts
 * @param {Map<string, any>} previousSnapshot
 */
function recordSanitizedPortSnapshot(sanitizedPorts, previousSnapshot) {
  const snapshot = new Map()
  let changed = 0
  for (const port of sanitizedPorts) {
    const previous = previousSnapshot.get(port.portKey)
    if (previous && !deepEqual(previous, port)) {
      changed += 1
    }
    snapshot.set(port.portKey, port)
  }
  return { changed, snapshot }
}

/**
 * @param {string} portKey
 * @param {{ port: import('boards-list').Port }} detectedPort
 */
function createSanitizedPortEntry(portKey, detectedPort) {
  const port = detectedPort.port
  const sanitizedProperties = sanitizePortProperties(port.properties)
  return {
    portKey,
    protocol: port.protocol,
    address: port.address,
    label: port.label,
    hardwareId: port.hardwareId,
    properties: sanitizedProperties,
  }
}

/** @param {import('boards-list').Port['properties']} properties */
function sanitizePortProperties(properties) {
  if (!properties || typeof properties !== 'object') {
    return undefined
  }
  const sanitized = {}
  for (const [key, value] of Object.entries(properties)) {
    const sanitizedValue = sanitizePortPropertyValue(key, value)
    if (sanitizedValue !== undefined) {
      sanitized[key] = sanitizedValue
    }
  }
  return Object.keys(sanitized).length === 0 ? undefined : sanitized
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function sanitizePortPropertyValue(key, value) {
  if (value === undefined || value === null) {
    return value
  }
  if (shouldRedactIdentifier(key)) {
    return '{redacted}'
  }
  return sanitizePortPropertyRecursively(value)
}

function sanitizePortPropertyRecursively(value) {
  if (value === null || value === undefined) {
    return value
  }
  if (typeof value === 'string') {
    return value.length > MAX_PROPERTY_STRING_LENGTH
      ? value.slice(0, MAX_PROPERTY_STRING_LENGTH) + '…'
      : value
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePortPropertyRecursively(item))
  }
  if (typeof value === 'object') {
    const sanitized = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitizedChildValue = sanitizePortPropertyValue(
        childKey,
        childValue
      )
      if (sanitizedChildValue !== undefined) {
        sanitized[childKey] = sanitizedChildValue
      }
    }
    return sanitized
  }
  return value
}

/** @param {string} value */
function normalizeIdentifier(value) {
  if (!value || typeof value !== 'string') {
    return ''
  }
  return value.toLowerCase().replace(/[^0-9a-z]+/g, '')
}

/** @param {string} key */
function shouldRedactIdentifier(key) {
  const normalized = normalizeIdentifier(key)
  return Boolean(normalized && redactedIdentifierSet.has(normalized))
}

function emitPortsTraceEvent(writer, detectedPortKeys, sanitizedPorts) {
  writer.emit(
    'portsDidPush',
    {
      count: detectedPortKeys.length,
      keys: detectedPortKeys,
      ports: sanitizedPorts,
    },
    { layer: 'bridge' }
  )
}
