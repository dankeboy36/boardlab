import { createHash, randomUUID } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs'
import path from 'node:path'

import { LOG_DIR, ensureLogDir } from './logPaths.js'

/**
 * @typedef {'bridge' | 'ext' | 'webview'} TraceLayer
 *
 * @typedef TraceIdentity
 * @property {string} [version]
 * @property {string} [mode]
 * @property {string} [extensionPath]
 * @property {string} [commit]
 *
 * @typedef TraceHeartbeat
 * @property {number} [intervalMs]
 * @property {number} [timeoutMs]
 *
 * @typedef TraceWriterOptions
 * @property {TraceIdentity} [identity]
 * @property {TraceHeartbeat} [heartbeat]
 * @property {TraceLayer} [layer]
 *
 * @typedef TraceEmitOptions
 * @property {TraceLayer} [layer]
 * @property {string} [monitorSessionId]
 * @property {string} [clientId]
 * @property {string} [webviewId]
 * @property {string} [webviewType]
 * @property {string} [portKey]
 *
 * @typedef TraceEventEnvelope
 * @property {number} v
 * @property {string} ts
 * @property {number} seq
 * @property {{
 *   layer: TraceLayer
 *   runId: string
 *   pid: number
 * }} src
 * @property {string} event
 * @property {string | undefined} monitorSessionId
 * @property {string | undefined} clientId
 * @property {string | undefined} webviewId
 * @property {string | undefined} webviewType
 * @property {string | undefined} portKey
 * @property {Record<string, unknown> | undefined} data
 */
const TRACE_BASE_NAME = 'events.jsonl'
const TRACE_INCLUDE_RUN_ID =
  process.env.PORTINO_BRIDGE_TRACE_INCLUDE_RUN_ID === 'true'
const TRACE_VERSION = 1

function readRunIdFromFile(filePath) {
  if (!existsSync(filePath)) {
    return undefined
  }
  try {
    const fd = openSync(filePath, 'r')
    const buffer = Buffer.alloc(1024)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    fd.close()
    if (bytes <= 0) {
      return undefined
    }
    const firstLine = buffer.toString('utf8', 0, bytes).split('\n')[0].trim()
    if (!firstLine) {
      return undefined
    }
    const parsed = JSON.parse(firstLine)
    return parsed?.src?.runId
  } catch (error) {
    return undefined
  }
}

function rotationPathFor(runId) {
  const safeId = runId.replace(/[^a-zA-Z0-9-_]/g, '-')
  return path.join(LOG_DIR, `events-${safeId}.jsonl`)
}

/** @param {string} token */
function hashToken(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}

class TraceWriter {
  /** @param {TraceWriterOptions} [options] */
  constructor({ identity, heartbeat, layer = 'bridge' } = {}) {
    ensureLogDir()
    this.identity = identity ?? {}
    this.heartbeat = heartbeat ?? {}
    this.layer = layer
    this.runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`
    this.seq = 0
    const withRunId = TRACE_INCLUDE_RUN_ID
      ? TRACE_BASE_NAME.replace(/\.jsonl$/i, `-${this.runId}.jsonl`)
      : TRACE_BASE_NAME
    this.filePath = path.join(LOG_DIR, withRunId)
    if (!TRACE_INCLUDE_RUN_ID) {
      this.rotateExisting()
    }
    this.stream = createWriteStream(this.filePath, {
      flags: 'a',
      encoding: 'utf8',
    })
    this.writeQueue = []
    this.closed = false
    this.isWriting = false
    this.flushResolvers = []
    this.stream.on('error', (error) => {
      console.error('[monitor bridge trace] failed to write event', error)
    })
    this.emit(
      'bridgeDidStart',
      { identity: this.identity, heartbeat: this.heartbeat },
      { layer: this.layer }
    )
  }

  rotateExisting() {
    if (!existsSync(this.filePath)) {
      return
    }
    try {
      const stats = statSync(this.filePath)
      if (stats.size === 0) {
        return
      }
      const previousId =
        readRunIdFromFile(this.filePath) || `prev-${stats.mtimeMs}`
      const dest = rotationPathFor(previousId)
      renameSync(this.filePath, dest)
    } catch (error) {
      console.error(
        '[monitor bridge trace] failed to rotate existing events file',
        error
      )
    }
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} [data]
   * @param {TraceEmitOptions} [options]
   */
  emit(name, data = {}, options = {}) {
    if (this.closed) return
    const envelope = {
      v: TRACE_VERSION,
      ts: new Date().toISOString(),
      seq: ++this.seq,
      src: {
        layer: options.layer ?? this.layer,
        runId: options.runId ?? this.runId,
        pid: options.pid ?? process.pid,
      },
      event: name,
      monitorSessionId: options.monitorSessionId,
      clientId: options.clientId,
      webviewId: options.webviewId,
      webviewType: options.webviewType,
      portKey: options.portKey,
      data,
    }
    this.write(envelope)
  }

  emitLogLine({ message, level, logger, fields }) {
    if (this.closed) return
    this.emit(
      'logDidWrite',
      {
        message,
        level,
        logger,
        fields,
      },
      { layer: this.layer }
    )
  }

  write(value) {
    if (this.closed) return
    this.writeQueue.push(`${JSON.stringify(value)}\n`)
    this.processQueue()
  }

  processQueue() {
    if (this.closed || this.isWriting || this.writeQueue.length === 0) {
      this._resolveFlushers()
      return
    }
    this.isWriting = true
    const chunk = this.writeQueue.shift()
    if (!chunk) {
      this.isWriting = false
      this._resolveFlushers()
      return
    }
    this.stream.write(chunk, (error) => {
      if (error) {
        if (error.code !== 'ERR_STREAM_WRITE_AFTER_END') {
          console.error('[monitor bridge trace] failed to append event', error)
        }
        // Prevent further writes after stream end
        this.closed = true
      }
      this.isWriting = false
      this._resolveFlushers()
      this.processQueue()
    })
  }

  /** @returns {Promise<void>} */
  flush() {
    if (
      !this.stream ||
      this.closed ||
      (this.writeQueue.length === 0 && !this.isWriting)
    ) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.flushResolvers.push(resolve)
    })
  }

  _resolveFlushers() {
    if (this.isWriting || this.writeQueue.length > 0) {
      return
    }
    while (this.flushResolvers.length > 0) {
      const resolve = this.flushResolvers.shift()
      resolve?.()
    }
  }

  async close() {
    if (this.closed) {
      return
    }
    this.closed = true
    if (!this.stream) {
      return
    }

    await this.flush()
    return new Promise((resolve) => {
      this.stream.end(() => {
        this.stream = undefined
        resolve()
      })
    })
  }
}

export { TraceWriter, hashToken }
