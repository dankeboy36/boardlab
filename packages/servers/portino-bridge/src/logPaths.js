import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

const LOG_DIR = path.join(os.tmpdir(), '.boardlab', 'monitor-bridge')

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
}

export { LOG_DIR, ensureLogDir }
