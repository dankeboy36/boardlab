import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export default async function globalSetup(): Promise<void> {
  const keep = process.env.KEEP_BRIDGE_LOGS === 'true'
  const dir = mkdtempSync(path.join(os.tmpdir(), 'boardlab-bridge-'))
  process.env.PORTINO_BRIDGE_LOG_DIR = dir
  process.env.PORTINO_BRIDGE_TRACE_INCLUDE_RUN_ID = 'true'

  const cleanup = () => {
    if (keep) return
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  process.once('exit', cleanup)
  process.once('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })
}
