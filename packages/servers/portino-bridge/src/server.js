// @ts-check
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import util from 'node:util'

import { Port } from 'ardunno-cli'
import { createPortKey } from 'boards-list'
import cors from 'cors'
import express from 'express'
import deepEqual from 'fast-deep-equal'
import { FQBN } from 'fqbn'
import { ClientError } from 'nice-grpc'
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
const SENSITIVE_PROPERTY_TOKENS = [
  'password',
  'passwd',
  'token',
  'secret',
  'apikey',
  'authorization',
  'cookie',
  'session',
  'jwt',
  'privatekey',
]

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

const baseConsoleFunctions = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
}

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
 */

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
  const bridgeIdentity = buildBridgeIdentity(options.identity)
  /** @type {Set<PortinoConnection>} */
  const portinoConnections = new Set()
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
  const broadcastBridgeLog = (entry) => {
    portinoConnections.forEach((connection) => {
      try {
        connection.messageConnection.sendNotification(
          NotifyMonitorBridgeLog,
          entry
        )
      } catch (error) {
        portinoConnections.delete(connection)
        const message =
          error instanceof Error ? error.message : String(error ?? '')
        if (!/disposed|closed/i.test(message)) {
          baseConsoleFunctions.error(
            '[monitor bridge] failed to send log notification',
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error)
          )
        }
      }
    })
  }

  const loggerId = 'bridge'
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
  const wss = new WebSocketServer({ server, path: '/serial' })
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
      const now = Date.now()
      const ageMs = touch.ageMs ?? 0
      const previousTraceTs = heartbeatTraceTimestamps.get(token)
      const shouldTrace =
        !previousTraceTs ||
        now - previousTraceTs >= heartbeatTraceThrottleMs ||
        (heartbeatInfo.timeoutMs > 0 && ageMs >= heartbeatInfo.timeoutMs)
      if (shouldTrace) {
        heartbeatTraceTimestamps.set(token, now)
        traceWriter.emit(
          'heartbeatDidReceive',
          {
            tokenHash: hashToken(token),
            ageMs,
            attachments: touch.attachments,
          },
          { layer: 'bridge' }
        )
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
    for (const [portKey, entry] of activeSerialStreams.entries()) {
      streams.push({
        portKey,
        monitorSessionId: entry.sessionId,
        clientCount: entry.clients.size,
        lastCount: entry.lastCount,
        clientIds: Array.from(entry.clientIndex.keys()),
      })
    }
    return streams
  }

  const describeRunningMonitors = () => {
    const monitors = []
    for (const [portKey, info] of runningMonitorsByKey.entries()) {
      const stream = activeSerialStreams.get(portKey)
      monitors.push({
        portKey,
        port: info.port,
        baudrate: info.baudrate,
        monitorSessionId: info.monitorSessionId,
        clientCount: stream?.clients.size ?? 0,
        lastCount: stream?.lastCount,
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
      for (const [key, entry] of activeSerialStreams.entries()) {
        counts[key] = entry.clients.size
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
      globalClientCount: globalClientIndex.size,
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
  // Broadcast hub for raw serial streams: one monitor per unique port+baudrate+fqbn
  /**
   * @type {Map<
   *   string,
   *   {
   *     port: import('ardunno-cli').Port
   *     monitor: import('./monitor.js').PortinoMonitor | undefined
   *     clients: Set<import('express').Response>
   *     clientIndex: Map<string, import('express').Response>
   *     sessionId?: string
   *     baudrate?: string
   *     closed?: boolean
   *     lastCount?: number
   *   }
   * >}
   */
  const activeSerialStreams = new Map()

  /**
   * Tracks currently running monitors (at least one HTTP client streaming).
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
   * Global index of connected clients to their current stream response. Ensures
   * we can proactively close a client's previous stream when switching ports so
   * cleanup is deterministic and fast.
   *
   * @type {Map<
   *   string,
   *   { portKey: string; res: import('express').Response }
   * >}
   */
  const globalClientIndex = new Map()

  /**
   * Forcefully disconnects a client from its current stream, if any. Cleans
   * local indices and disposes the monitor when no clients remain.
   *
   * @param {string} clientId
   */
  async function forceDisconnectClient(clientId) {
    v(`[serial] forceDisconnectClient client=${clientId}`)
    const mapping = globalClientIndex.get(clientId)
    if (!mapping) return
    const { portKey: prevPortKey, res: prevRes } = mapping
    const prevEntry = activeSerialStreams.get(prevPortKey)
    bridgeLog('info', 'Force disconnecting serial client', {
      clientId,
      portKey: prevPortKey,
      monitorSessionId: prevEntry?.sessionId,
    })

    // Remove from indices first so writers stop targeting this response
    if (prevEntry) {
      try {
        prevEntry.clients.delete(prevRes)
      } catch {}
      const mapped = prevEntry.clientIndex.get(clientId)
      if (mapped === prevRes) prevEntry.clientIndex.delete(clientId)

      const remaining = prevEntry.clients.size
      if (DEBUG) {
        console.log(
          `[serial] -client ${clientId} on ${prevPortKey}; remaining=${remaining}`
        )
      }
      if (remaining === 0 && !prevEntry.closed) {
        if (DEBUG) {
          console.log(
            `[serial] last client -> closing monitor for ${prevPortKey}`
          )
        }
        prevEntry.closed = true
        notifyMonitorStopped(prevPortKey, prevEntry.port, prevEntry.sessionId)
        try {
          await prevEntry.monitor.dispose?.()
        } catch {}
        try {
          await cliBridge.releaseMonitor(prevEntry.port)
        } catch (e) {
          console.error('Error releasing monitor:', e)
        }
        activeSerialStreams.delete(prevPortKey)
        if (DEBUG) {
          console.log(`[serial] monitor removed for ${prevPortKey}`)
        }
      }
    }

    // End the response last so the client-side reader completes cleanly
    try {
      prevRes.end()
    } catch {}
    globalClientIndex.delete(clientId)
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

        portinoConnection.messageConnection.sendNotification(
          NotifyDidChangeBaudrate,
          event
        )
      })
    }
  }

  const broadcastMonitorDidPause = (port) => {
    portinoConnections.forEach(({ messageConnection }) => {
      messageConnection.sendNotification(NotifyMonitorDidPause, { port })
    })
  }

  const broadcastMonitorDidResume = (port, resumedPort = port) => {
    portinoConnections.forEach(({ messageConnection }) => {
      messageConnection.sendNotification(NotifyMonitorDidResume, {
        didPauseOnPort: port,
        didResumeOnPort: resumedPort,
      })
    })
  }

  const broadcastMonitorDidStart = (port, baudrate, monitorSessionId) => {
    portinoConnections.forEach(({ messageConnection }) => {
      messageConnection.sendNotification(NotifyMonitorDidStart, {
        port,
        baudrate,
        monitorSessionId,
      })
    })
  }

  const broadcastMonitorDidStop = (port, monitorSessionId) => {
    portinoConnections.forEach(({ messageConnection }) => {
      messageConnection.sendNotification(NotifyMonitorDidStop, {
        port,
        monitorSessionId,
      })
    })
  }

  app.get('/monitor', async (req, res) => {
    const { protocol, address, baudrate, fqbn, clientid: clientId } = req.query
    if (
      typeof protocol !== 'string' ||
      typeof address !== 'string' ||
      typeof clientId !== 'string' ||
      (fqbn && typeof fqbn !== 'string')
    ) {
      return res.sendStatus(400)
    }

    // Create a unique key for this serial stream
    const portKey = createPortKey({ protocol, address })
    v(
      `[serial] [/serial-data] client=${clientId} request port=${portKey} baud=${
        typeof baudrate === 'string' ? baudrate : '-'
      } fqbn=${fqbn ?? '-'}`
    )

    const requestBaudrate =
      typeof baudrate === 'string' ? String(baudrate) : undefined

    const isPortDetected = Boolean(watcher?.state?.[portKey])
    if (!isPortDetected) {
      return res.status(404).json({
        code: 'port-not-detected',
        message: `Port ${address} is not detected.`,
      })
    }

    // If this clientId already has a connection (possibly on a different port),
    // close the old one first using the global index for deterministic cleanup.
    const existing = globalClientIndex.get(clientId)
    /** @type {import('express').Response | undefined} */
    let previousRes
    if (existing) {
      if (existing.portKey === portKey) {
        previousRes = existing.res
      } else {
        v(
          `[serial] client switch: ${clientId} ${existing.portKey} -> ${portKey}`
        )
        await forceDisconnectClient(clientId)
      }
    }

    const existingEntry = activeSerialStreams.get(portKey)
    const monitorSessionId =
      existingEntry?.sessionId ?? createMonitorSessionId()
    if (!res.headersSent) {
      res.setHeader('x-monitor-session-id', monitorSessionId)
    }

    // Lookup (or lazily create) the active entry for this port after any cleanup
    let entry = existingEntry
    if (entry && !entry.sessionId) {
      entry.sessionId = monitorSessionId
    }

    if (!entry) {
      // Ensure monitor settings for the selected protocol were retrieved successfully
      try {
        const result = await cliBridge.fetchMonitorSettingsForProtocol(
          String(protocol)
        )
        const settingsOrError = result[String(protocol)]
        if (settingsOrError instanceof Error) {
          const msg = settingsOrError.message || String(settingsOrError)
          return res
            .status(400)
            .send(`Monitor unavailable for protocol ${protocol}: ${msg}`)
        }
        const settings = settingsOrError
        const hasBaudrate = Array.isArray(settings)
          ? !!settings.find((s) => s.settingId === 'baudrate')
          : false
        v(`[serial] settings for proto=${protocol} hasBaudrate=${hasBaudrate}`)
        if (hasBaudrate && typeof baudrate !== 'string') {
          return res.status(400).send('Baudrate required for this protocol')
        }
      } catch (e) {
        const msg = String(/** @type {any} */ (e)?.message || e)
        return res
          .status(400)
          .send(`Failed to resolve monitor settings for ${protocol}: ${msg}`)
      }

      // First client for this key: acquire monitor and start broadcast loop
      const port = Port.fromJSON({ protocol, address })
      // Place a placeholder entry immediately to prevent concurrent duplicate
      // acquisitions for the same port while we initialize the monitor.
      const clients = new Set()
      const clientIndex = new Map()
      entry = {
        port,
        /** @type {import('./monitor.js').PortinoMonitor | undefined} */
        monitor: undefined,
        clients,
        clientIndex,
        sessionId: monitorSessionId,
        baudrate: requestBaudrate,
        lastCount: undefined,
      }
      activeSerialStreams.set(portKey, entry)
      const onDidChangeBaudrate = createNotifyDidChangeBaudrateCallback(
        (portinoConnection) => {
          return (
            // Only notify clients that are connected to this port
            !!portinoConnection.clientId &&
            // Exclude the current client
            portinoConnection.clientId !== clientId
          )
        }
      )
      /** @type {import('./monitor.js').PortinoMonitor} */
      let monitor
      try {
        monitor = await cliBridge.acquireMonitor(
          {
            port,
            baudrate: typeof baudrate === 'string' ? baudrate : undefined,
            fqbn: fqbn ? new FQBN(/** @type {string} */ (fqbn)) : undefined,
          },
          onDidChangeBaudrate
        )
        // Assign monitor to the placeholder entry now that it's ready
        entry.monitor = monitor
      } catch (err) {
        // Fail fast for busy/denied ports without crashing the process
        const message = String((err && /** @type {any} */ (err).details) || err)
        if (message.includes('Serial port busy')) {
          return res.status(423).json({
            code: 'port-busy',
            message: 'Serial port busy',
          })
        }
        // Cleanup placeholder
        activeSerialStreams.delete(portKey)
        const stillDetected = Boolean(watcher?.state?.[portKey])
        if (!stillDetected) {
          return res.status(404).json({
            code: 'port-not-detected',
            message: `Port ${address} is not detected.`,
          })
        }
        return res.status(502).json({
          code: 'monitor-open-failed',
          message,
        })
      }
      v(
        `[serial] acquired monitor for ${portKey} @ ${
          typeof baudrate === 'string' ? baudrate : '-'
        }${fqbn ? ' ' + fqbn : ''}`
      )

      // Prime the stream: read until success/error, buffering any early data
      const respIterator = monitor.messages[Symbol.asyncIterator]()
      const bufferedChunks = []
      try {
        // Drain until monitor.ready resolves; buffer any early data
        const READY = Symbol('ready')
        // Loop until `monitor.ready` resolves or the iterator ends
        while (true) {
          const winner = await Promise.race([
            monitor.ready.then(() => READY),
            respIterator.next(),
          ])
          if (winner === READY) break
          const { value, done } =
            /** @type {{ value?: Uint8Array; done: boolean }} */ (winner)
          if (done) break
          if (value && value.length) bufferedChunks.push(Buffer.from(value))
        }
        // Surface any error from `ready`
        await monitor.ready
      } catch (err) {
        if (err instanceof ClientError) {
          if (err.details.includes('Serial port busy')) {
            res.status(423).json({
              code: 'port-busy',
              message: 'Serial port busy',
            })
          } else {
            const stillDetected = Boolean(watcher?.state?.[portKey])
            if (!stillDetected) {
              res.status(404).json({
                code: 'port-not-detected',
                message: `Port ${address} is not detected.`,
              })
            } else {
              res.status(502).json({
                code: 'monitor-open-failed',
                message: err.details,
              })
            }
          }
        }
        // Cleanup on priming failure
        cliBridge.releaseMonitor(port)
        activeSerialStreams.delete(portKey)
        return
      }

      // Broadcast incoming chunks to all connected HTTP clients
      const streamEntry = /**
       * @type {{
       *   port: import('ardunno-cli').Port
       *   monitor: import('./monitor.js').PortinoMonitor | undefined
       *   clients: Set<import('express').Response>
       *   clientIndex: Map<string, import('express').Response>
       *   sessionId?: string
       *   closed?: boolean
       *   lastCount?: number
       *   baudrate?: string
       *   startedNotified?: boolean
       * }}
       */ (entry)
      ;(async () => {
        try {
          // First, flush any buffered chunks captured during priming
          if (bufferedChunks.length) {
            const total = bufferedChunks.reduce((n, b) => n + b.length, 0)
            v(
              `[serial] primed ${portKey}: buffered=${bufferedChunks.length} totalBytes=${total}`
            )
          }
          for (const buf of bufferedChunks) {
            for (const clientRes of clients) {
              clientRes.write(buf)
            }
            try {
              const m = Buffer.from(buf)
                .toString('utf8')
                .match(/\[count:(\d+)\]/)
              if (m) streamEntry.lastCount = Number(m[1])
            } catch {}
          }
          bufferedChunks.length = 0

          // Then continue with the same iterator to avoid double-opening
          let rxSeq = 0
          while (true) {
            const { value: chunk, done } = await respIterator.next()
            if (done) break
            const buf = Buffer.from(chunk)
            rxSeq++
            v(
              `[serial] rx#${rxSeq} ${buf.length} bytes -> clients=${clients.size} on ${portKey}`
            )
            for (const clientRes of clients) {
              clientRes.write(buf)
            }
            try {
              const m = buf.toString('utf8').match(/\[count:(\d+)\]/)
              if (m) streamEntry.lastCount = Number(m[1])
            } catch {}
          }
        } catch (err) {
          const name = /** @type {any} */ (err)?.name || ''
          const msg = String(
            (err && /** @type {any} */ (err).details) || err || ''
          )
          const isAbort = name === 'AbortError' || /aborted/i.test(msg)
          if (!isAbort) {
            console.error('Serial data stream error:', err)
            // Only surface non-abort errors to connected clients
            for (const clientRes of clients) {
              try {
                clientRes.write(Buffer.from(`\n[error] ${msg}\n`))
              } catch {}
            }
          }
        } finally {
          v(`[serial] monitor ended for ${portKey} (stream finished)`)
          const keepEntry = monitor?.isPaused?.()
          if (keepEntry) {
            v(`[serial] monitor paused; keeping entry for ${portKey}`)
          } else {
            // Cleanup when monitor ends
            for (const clientRes of clients) {
              try {
                clientRes.end()
              } catch {}
            }
            notifyMonitorStopped(
              portKey,
              streamEntry.port,
              streamEntry.sessionId
            )
            try {
              await cliBridge.releaseMonitor(port)
            } catch {}
            // Only delete if this entry is still the active one for the key and not already closed
            const current = activeSerialStreams.get(portKey)
            if (current && current.monitor === monitor && !current.closed) {
              current.closed = true
              activeSerialStreams.delete(portKey)
              v(`[serial] monitor removed for ${portKey}`)
            }
          }
        }
      })()
    }

    // Resolve the active entry for this port for client registration
    const streamEntry = /**
     * @type {{
     *   port: import('ardunno-cli').Port
     *   monitor: import('./monitor.js').PortinoMonitor | undefined
     *   clients: Set<import('express').Response>
     *   clientIndex: Map<string, import('express').Response>
     *   closed?: boolean
     *   lastCount?: number
     *   baudrate?: string
     *   startedNotified?: boolean
     *   sessionId: string
     * }}
     */ (activeSerialStreams.get(portKey))
    if (!streamEntry) {
      return res.status(500).send('No active stream entry')
    }

    // Deduplicate attaches for the same monitor session/client
    if (
      streamEntry.sessionId &&
      streamEntry.sessionId === monitorSessionId &&
      streamEntry.clientIndex.has(clientId)
    ) {
      traceWriter.emitLogLine({
        message: 'Duplicate monitor stream attach ignored',
        level: 'debug',
        logger: 'bridge',
        fields: {
          clientId,
          portKey,
          monitorSessionId: streamEntry.sessionId,
        },
      })
      return res.status(409).json({
        code: 'duplicate-attach',
        message: 'Client already attached to this monitor session',
      })
    }

    // Setup HTTP response for this client
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Transfer-Encoding', 'chunked')
    try {
      res.flushHeaders?.()
    } catch {}
    if (req.socket) {
      req.socket.setTimeout(0)
      req.socket.setNoDelay(true)
      req.socket.setKeepAlive(true)
    }

    entry.sessionId = monitorSessionId
    if (requestBaudrate) {
      entry.baudrate = requestBaudrate
    }

    // Register this response as a client
    streamEntry.clients.add(res)
    streamEntry.clientIndex.set(clientId, res)
    globalClientIndex.set(clientId, { portKey, res })
    if (previousRes && previousRes !== res) {
      try {
        previousRes.end()
      } catch {}
    }
    bridgeLog('info', 'Monitor stream client attached', {
      clientId,
      portKey,
      monitorSessionId: streamEntry.sessionId,
    })
    v(
      `[serial] +client ${clientId} on ${portKey}; total=${streamEntry.clients.size}`
    )

    if (streamEntry.clients.size === 1) {
      bridgeLog('info', 'Monitor stream opened', {
        clientId,
        portKey,
        monitorSessionId: streamEntry.sessionId,
      })
      notifyMonitorStarted(
        portKey,
        streamEntry.port,
        requestBaudrate ?? runningMonitorsByKey.get(portKey)?.baudrate,
        streamEntry.sessionId
      )
    } else if (requestBaudrate) {
      updateMonitorBaudrate(portKey, streamEntry.port, requestBaudrate)
    }

    let cleaned = false
    const onReqGone = async () => {
      if (cleaned) return
      cleaned = true

      try {
        streamEntry.clients.delete(res)
      } catch {}
      const mapped = streamEntry.clientIndex.get(clientId)
      if (mapped === res) streamEntry.clientIndex.delete(clientId)
      const globalMapped = globalClientIndex.get(clientId)
      if (globalMapped && globalMapped.res === res) {
        globalClientIndex.delete(clientId)
      }

      const remaining = streamEntry.clients.size
      bridgeLog('info', 'Monitor stream client detached', {
        clientId,
        portKey,
        monitorSessionId: streamEntry.sessionId,
        remaining,
      })
      v(`[serial] -client ${clientId} on ${portKey}; remaining=${remaining}`)
      if (remaining === 0) {
        const isPaused = streamEntry.monitor?.isPaused?.()
        if (isPaused) {
          v(
            `[serial] last client while paused -> keeping monitor for ${portKey}`
          )
          return
        }
        v(`[serial] last client -> closing monitor for ${portKey}`)
        bridgeLog('info', 'Monitor stream closed', {
          portKey,
          monitorSessionId: streamEntry.sessionId,
        })
        streamEntry.closed = true
        notifyMonitorStopped(portKey, streamEntry.port, streamEntry.sessionId)
        try {
          await streamEntry.monitor?.dispose?.()
        } catch {}
        try {
          await cliBridge.releaseMonitor(streamEntry.port)
        } catch (e) {
          console.error('Error releasing monitor:', e)
        }
        activeSerialStreams.delete(portKey)
        if (DEBUG) {
          console.log(`[serial] monitor removed for ${portKey}`)
        }
      }
    }
    req.on('close', onReqGone)
    req.on('aborted', onReqGone)
  })

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
      portinoConnections.forEach(({ messageConnection }) => {
        messageConnection.sendNotification(
          NotifyDidChangeMonitorSettings,
          monitorSettingsSnapshot
        )
      })
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
    portinoConnections.add({ messageConnection })

    // Forward board list updates to client
    const updateHandler = () => {
      const detectedPorts = watcher.state
      const detectedPortKeys = Object.keys(detectedPorts)
      const sanitizedPorts = createSanitizedPortSnapshot(detectedPorts)
      bridgeLog('info', 'Detected ports pushed to client', {
        detectedPortKeys,
      })
      messageConnection.sendNotification(
        NotifyDidChangeDetectedPorts,
        detectedPorts
      )
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

    // Now start listening for incoming JSON-RPC messages
    messageConnection.listen()

    // broadcast the initial detected ports
    messageConnection.sendNotification(
      NotifyDidChangeDetectedPorts,
      watcher.state
    )

    const onDidChangeBaudrate = createNotifyDidChangeBaudrateCallback(
      (connection) => connection.messageConnection !== messageConnection // Exclude the current connection
    )
    disposables.push(
      messageConnection.onRequest(RequestDetectedPorts, () => watcher.state),
      messageConnection.onRequest(RequestUpdateBaudrate, async (params) => {
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
          const entry = activeSerialStreams.get(portKey)
          if (entry && !entry.closed && entry.monitor) {
            await entry.monitor.updateBaudrate(params.baudrate)
            // Notify other clients about the change to keep UI in sync
            onDidChangeBaudrate({
              port: params.port,
              baudrate: params.baudrate,
            })
            v('[serial] baudrate updated via active stream entry')
            updateMonitorBaudrate(portKey, entry.port, params.baudrate)
          }
          // No active stream/monitor for this port: ignore as a no-op.
          // The next monitor acquisition will use the provided baudrate via
          // `/serial-data?baudrate=...` and broadcast as needed.
          if (!entry || entry.closed) {
            v('[serial] baudrate update ignored (no active monitor)')
          }
        }
      }),
      messageConnection.onRequest(RequestSendMonitorMessage, (params) => {
        const { port, message } = params
        const portKey = createPortKey(port)
        const entry = activeSerialStreams.get(portKey)
        if (!entry || !entry.monitor) {
          throw new Error(`No active monitor for port: ${portKey}`)
        }
        v(`[serial] send message to ${portKey} (${message?.length ?? 0} bytes)`)
        return entry.monitor.sendMessage(message)
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
              monitorSessionId:
                activeSerialStreams.get(portKey)?.sessionId ??
                runningMonitorsByKey.get(portKey)?.monitorSessionId,
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
                monitorSessionId:
                  activeSerialStreams.get(portKey)?.sessionId ??
                  runningMonitorsByKey.get(portKey)?.monitorSessionId,
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
          const entry = activeSerialStreams.get(portKey)
          const shouldNotify =
            resumed || entry || runningMonitorsByKey.has(portKey)
          if (shouldNotify) {
            broadcastMonitorDidResume(params.port)
            bridgeLog('info', 'Monitor resumed', {
              port: params.port,
              portKey,
              monitorSessionId:
                entry?.sessionId ??
                runningMonitorsByKey.get(portKey)?.monitorSessionId,
            })
            const resumedSessionId =
              entry?.sessionId ??
              runningMonitorsByKey.get(portKey)?.monitorSessionId
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
            const entryBaudrate = entry
              ? /** @type {any} */ (entry).baudrate
              : undefined
            const baudrate =
              entryBaudrate ?? runningMonitorsByKey.get(portKey)?.baudrate
            notifyMonitorStarted(
              portKey,
              entry?.port ?? params.port,
              baudrate,
              entry?.sessionId ??
                runningMonitorsByKey.get(portKey)?.monitorSessionId
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
        const portinoConnection = Array.from(portinoConnections).find(
          (v) => v.messageConnection === messageConnection
        )

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
    ws.on('close', () => {
      const portinoConnection = Array.from(portinoConnections).find(
        (v) => v.messageConnection === messageConnection
      )
      if (portinoConnection) {
        portinoConnections.delete(portinoConnection)
        bridgeLog('info', 'Client disconnected', {
          clientId: portinoConnection.clientId,
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
        // Forcefully disconnect any remaining HTTP stream clients
        for (const { res } of globalClientIndex.values()) {
          try {
            res.end()
          } catch {}
        }
        globalClientIndex.clear()
      } catch {}
      try {
        wss.close()
      } catch {}
      await new Promise((resolve) => server.close(() => resolve(undefined)))
      process.off('exit', onExit)
      if (ownBridge) {
        try {
          await cliBridge.dispose()
        } catch {}
      }
      try {
        logFileStream.end()
      } catch {}
      traceWriter.emit('bridgeDidStop', { reason: 'exit' }, { layer: 'bridge' })
      traceWriter.close()
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
  if (isSensitivePortKey(key)) {
    return '***'
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

function isSensitivePortKey(key) {
  const lower = key.toLowerCase()
  return SENSITIVE_PROPERTY_TOKENS.some((token) => lower.includes(token))
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
