import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

const DEFAULT_LOG_DIR = path.join(os.tmpdir(), '.boardlab', 'monitor-bridge')

function resolveLogDir() {
  const override =
    process.env.PORTINO_BRIDGE_LOG_DIR ||
    process.env.BOARDLAB_MONITOR_LOG_DIR ||
    undefined
  return override ? path.resolve(override) : DEFAULT_LOG_DIR
}

const LOG_DIR = resolveLogDir()

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
}

export { LOG_DIR, ensureLogDir, resolveLogDir }
