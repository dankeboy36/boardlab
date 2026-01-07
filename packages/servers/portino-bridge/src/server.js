// @ts-check
import { randomUUID } from 'node:crypto'
import http from 'node:http'

import { Port } from 'ardunno-cli'
import { createPortKey } from 'boards-list'
import cors from 'cors'
import express from 'express'
import { FQBN } from 'fqbn'
import { ClientError } from 'nice-grpc'
import { ConsoleLogger, createWebSocketConnection } from 'vscode-ws-jsonrpc'
import { WebSocketServer } from 'ws'

import {
  NotifyDidChangeBaudrate,
  NotifyDidChangeDetectedPorts,
  NotifyDidChangeMonitorSettings,
  NotifyMonitorDidPause,
  NotifyMonitorDidResume,
  NotifyMonitorDidStart,
  NotifyMonitorDidStop,
  RequestClientConnect,
  RequestDetectedPorts,
  RequestPauseMonitor,
  RequestResumeMonitor,
  RequestSendMonitorMessage,
  RequestUpdateBaudrate,
} from '@boardlab/protocol'

import { DaemonCliBridge } from './cliBridge.js'

const DEFAULT_HOST = '127.0.0.1'

class AttachmentRegistry {
  constructor() {
    /** @type {Map<string, { clientId?: string; attachedAt: number }>} */
    this.attachments = new Map()
    this.idleTimer = undefined
    this.idleTimeoutMs = 0
    this.onIdle = undefined
  }

  /** @param {{ idleTimeoutMs?: number; onIdle?: () => void | Promise<void> }} [options] */
  configure(options = {}) {
    const { idleTimeoutMs, onIdle } = options
    this.idleTimeoutMs =
      typeof idleTimeoutMs === 'number' && idleTimeoutMs > 0 ? idleTimeoutMs : 0
    this.onIdle = typeof onIdle === 'function' ? onIdle : undefined
    if (this.attachments.size === 0) {
      // Re-evaluate idle scheduling under the new configuration.
      this.clearTimer()
      this.scheduleIdleShutdown()
    }
  }

  get size() {
    return this.attachments.size
  }

  attach(clientId) {
    const token = randomUUID()
    this.attachments.set(token, { clientId, attachedAt: Date.now() })
    this.clearTimer()
    return { token }
  }

  detach(token) {
    this.attachments.delete(token)
    if (this.attachments.size === 0) {
      this.scheduleIdleShutdown()
    }
    return this.attachments.size
  }

  dispose() {
    this.clearTimer()
    this.attachments.clear()
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
 * @property {{ idleTimeoutMs?: number; onIdle?: () => void | Promise<void> }} [control]
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
  attachmentRegistry.configure(options.control ?? {})

  /** @type {import('./boardListWatch.js').BoardListStateWatcher | undefined} */
  const watcher = await cliBridge.createBoardListWatch()

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
    } catch (error) {
      console.error('[PortinoServer] attach failed', error)
      res.status(500).json({ error: 'attach_failed' })
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
      res.json({ remaining })
    } catch (error) {
      console.error('[PortinoServer] detach failed', error)
      res.status(500).json({ error: 'detach_failed' })
    }
  })

  app.post('/control/health', (_req, res) => {
    res.json({
      status: 'ok',
      attachments: attachmentRegistry.size,
      pid: process.pid,
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
  /** @type {Set<PortinoConnection>} */
  const portinoConnections = new Set()
  // Broadcast hub for raw serial streams: one monitor per unique port+baudrate+fqbn
  /**
   * @type {Map<
   *   string,
   *   {
   *     port: import('ardunno-cli').Port
   *     monitor: import('./monitor.js').PortinoMonitor | undefined
   *     clients: Set<import('express').Response>
   *     clientIndex: Map<string, import('express').Response>
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
   *   { port: import('boards-list').PortIdentifier; baudrate?: string }
   * >}
   */
  const runningMonitorsByKey = new Map()

  function toPortIdentifier(port) {
    return typeof port?.toJSON === 'function' ? port.toJSON() : port
  }

  function notifyMonitorStarted(portKey, port, baudrate) {
    const portJson = toPortIdentifier(port)
    const existing = runningMonitorsByKey.get(portKey)
    const finalBaudrate = baudrate ?? existing?.baudrate
    if (!existing) {
      runningMonitorsByKey.set(portKey, {
        port: portJson,
        baudrate: finalBaudrate,
      })
      broadcastMonitorDidStart(portJson, finalBaudrate)
    } else {
      runningMonitorsByKey.set(portKey, {
        port: portJson,
        baudrate: finalBaudrate,
      })
    }
  }

  function notifyMonitorStopped(portKey, port) {
    if (runningMonitorsByKey.delete(portKey)) {
      broadcastMonitorDidStop(toPortIdentifier(port))
    }
  }

  function updateMonitorBaudrate(portKey, port, baudrate) {
    if (!baudrate) {
      return
    }
    if (runningMonitorsByKey.has(portKey)) {
      runningMonitorsByKey.set(portKey, {
        port: toPortIdentifier(port),
        baudrate,
      })
    }
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
        notifyMonitorStopped(prevPortKey, prevEntry.port)
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

  const broadcastMonitorDidStart = (port, baudrate) => {
    portinoConnections.forEach(({ messageConnection }) => {
      messageConnection.sendNotification(NotifyMonitorDidStart, {
        port,
        baudrate,
      })
    })
  }

  const broadcastMonitorDidStop = (port) => {
    portinoConnections.forEach(({ messageConnection }) => {
      messageConnection.sendNotification(NotifyMonitorDidStop, { port })
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
    if (existing) {
      v(`[serial] client switch: ${clientId} ${existing.portKey} -> ${portKey}`)
      await forceDisconnectClient(clientId)
    }

    // Lookup (or lazily create) the active entry for this port after any cleanup
    let entry = activeSerialStreams.get(portKey)

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
          // Cleanup when monitor ends
          for (const clientRes of clients) {
            try {
              clientRes.end()
            } catch {}
          }
          notifyMonitorStopped(portKey, streamEntry.port)
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
     * }}
     */ (activeSerialStreams.get(portKey))
    if (!streamEntry) {
      return res.status(500).send('No active stream entry')
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

    // Register this response as a client
    streamEntry.clients.add(res)
    streamEntry.clientIndex.set(clientId, res)
    globalClientIndex.set(clientId, { portKey, res })
    v(
      `[serial] +client ${clientId} on ${portKey}; total=${streamEntry.clients.size}`
    )

    if (streamEntry.clients.size === 1) {
      notifyMonitorStarted(
        portKey,
        streamEntry.port,
        requestBaudrate ?? runningMonitorsByKey.get(portKey)?.baudrate
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
      v(`[serial] -client ${clientId} on ${portKey}; remaining=${remaining}`)
      if (remaining === 0) {
        v(`[serial] last client -> closing monitor for ${portKey}`)
        streamEntry.closed = true
        notifyMonitorStopped(portKey, streamEntry.port)
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
      const protocols = new Set(knownProtocols)
      for (const detected of Object.values(watcher.state)) {
        const p = detected.port?.protocol
        if (p) protocols.add(p)
      }
      // Update known protocols set
      protocols.forEach((p) => knownProtocols.add(p))
      await cliBridge.fetchMonitorSettingsForProtocol(...protocols)
      const snapshot = await buildMonitorSettingsSnapshot()
      // Broadcast settings to all clients
      portinoConnections.forEach(({ messageConnection }) => {
        messageConnection.sendNotification(
          NotifyDidChangeMonitorSettings,
          snapshot
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
    const logger = new ConsoleLogger()
    const messageConnection = createWebSocketConnection(socket, logger)
    portinoConnections.add({ messageConnection })

    // Forward board list updates to client
    const updateHandler = () => {
      const detectedPorts = watcher.state
      console.log(`Detected ports: ${JSON.stringify(detectedPorts)}`)
      messageConnection.sendNotification(
        NotifyDidChangeDetectedPorts,
        detectedPorts
      )
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
        v(`[serial] RequestPauseMonitor port=${createPortKey(params.port)}`)
        try {
          const paused = await cliBridge.pauseMonitor(params.port)
          if (paused) {
            broadcastMonitorDidPause(params.port)
            v(`[serial] monitor paused via RPC ${createPortKey(params.port)}`)
          }
          return paused
        } catch (error) {
          console.error('Failed to pause monitor', error)
          throw error
        }
      }),
      messageConnection.onRequest(RequestResumeMonitor, async (params) => {
        v(`[serial] RequestResumeMonitor port=${createPortKey(params.port)}`)
        try {
          const resumed = await cliBridge.resumeMonitor(params.port)
          const portKey = createPortKey(params.port)
          const entry = activeSerialStreams.get(portKey)
          const shouldNotify =
            resumed || entry || runningMonitorsByKey.has(portKey)
          if (shouldNotify) {
            broadcastMonitorDidResume(params.port)
            const entryBaudrate = entry
              ? /** @type {any} */ (entry).baudrate
              : undefined
            const baudrate =
              entryBaudrate ?? runningMonitorsByKey.get(portKey)?.baudrate
            notifyMonitorStarted(portKey, entry?.port ?? params.port, baudrate)
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
        console.log(`Client connected: ${clientId}`)

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
      })
    )

    // Clean up when client disconnects
    ws.on('close', () => {
      const portinoConnection = Array.from(portinoConnections).find(
        (v) => v.messageConnection === messageConnection
      )
      if (portinoConnection) {
        console.log(
          `Client disconnected: ${
            portinoConnection.clientId ?? '(no clientId set)'
          }`
        )
        portinoConnections.delete(portinoConnection)
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
      attachmentRegistry.dispose()
    },
  }
}
