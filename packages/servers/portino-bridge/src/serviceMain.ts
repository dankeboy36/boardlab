import { createServer } from './server.js'
import { MockCliBridge } from './mockCliBridge.js'

const HOST = '127.0.0.1'
const IDLE_TIMEOUT_MS = 30_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 20_000

interface ServiceOptions {
  port?: number
  cliPath?: string
  idleTimeoutMs?: number
  heartbeatTimeoutMs?: number
  heartbeatSweepMs?: number
  mockCli?: boolean
  boardlabVersion?: string
  extensionPath?: string
  bridgeMode?: string
  commit?: string
  logHeartbeat?: boolean
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const desiredPort = options.port ?? 0
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
  const heartbeatSweepMs = options.heartbeatSweepMs
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const useMockCli = options.mockCli === true || process.env.MOCK_CLI === 'true'
  const boardlabVersion =
    options.boardlabVersion ?? process.env.BOARDLAB_VERSION
  const extensionPath =
    options.extensionPath ?? process.env.BOARDLAB_EXTENSION_PATH
  const bridgeMode =
    options.bridgeMode ?? process.env.BOARDLAB_BRIDGE_MODE ?? 'external-process'
  const commit = options.commit ?? process.env.BOARDLAB_COMMIT
  const logHeartbeat =
    options.logHeartbeat ?? process.env.PORTINO_LOG_HEARTBEAT === 'true'

  const { close, attachmentRegistry } = await createServer({
    port: desiredPort,
    cliPath: options.cliPath,
    host: HOST,
    control: {
      heartbeatTimeoutMs,
      heartbeatSweepMs,
    },
    cliBridgeFactory: useMockCli ? () => new MockCliBridge() : undefined,
    identity: {
      version: boardlabVersion,
      mode: bridgeMode,
      extensionPath,
      commit,
    },
    logging: {
      heartbeat: logHeartbeat,
    },
  })

  if (useMockCli) {
    console.log('[PortinoService] using mock CLI bridge')
  }

  attachmentRegistry.configure({
    idleTimeoutMs,
    heartbeatTimeoutMs,
    heartbeatSweepMs,
    onIdle: async () => {
      console.log('[PortinoService] idle timeout reached; shutting down')
      await shutdown('idle-timeout', close)
    },
  })

  const handleSignal = async (signal: NodeJS.Signals) => {
    console.log(`[PortinoService] received ${signal}; shutting down`)
    await shutdown(`signal-${signal}`, close)
  }

  process.on('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)
  process.on('SIGUSR1', handleSignal)
  process.on('SIGUSR2', handleSignal)

  process.on('uncaughtException', async (err) => {
    console.error('[PortinoService] uncaught exception', err)
    await shutdown('uncaught-exception', close, 1)
  })

  process.on('unhandledRejection', async (reason) => {
    console.error('[PortinoService] unhandled rejection', reason)
    await shutdown('unhandled-rejection', close, 1)
  })
}

// TODO: use a lib
function parseArgs(args: readonly string[]): ServiceOptions {
  const result: ServiceOptions = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    const value = args[index + 1]
    if (name === 'mock-cli') {
      result.mockCli = true
      continue
    }
    if (name === 'log-heartbeat') {
      result.logHeartbeat = true
      continue
    }
    if (!value || value.startsWith('--')) continue
    switch (name) {
      case 'cli-path':
        result.cliPath = value
        index++
        break
      case 'port':
        {
          const parsed = Number.parseInt(value, 10)
          if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
            result.port = parsed
          }
          index++
        }
        break
      case 'boardlab-version':
        result.boardlabVersion = value
        index++
        break
      case 'extension-path':
        result.extensionPath = value
        index++
        break
      case 'bridge-mode':
        result.bridgeMode = value
        index++
        break
      case 'boardlab-commit':
        result.commit = value
        index++
        break
      case 'idle-timeout-ms':
        {
          const parsed = Number.parseInt(value, 10)
          if (Number.isInteger(parsed) && parsed >= 0) {
            result.idleTimeoutMs = parsed
          }
          index++
        }
        break
      case 'heartbeat-timeout-ms':
        {
          const parsed = Number.parseInt(value, 10)
          if (Number.isInteger(parsed) && parsed >= 0) {
            result.heartbeatTimeoutMs = parsed
          }
          index++
        }
        break
      case 'heartbeat-sweep-ms':
        {
          const parsed = Number.parseInt(value, 10)
          if (Number.isInteger(parsed) && parsed >= 0) {
            result.heartbeatSweepMs = parsed
          }
          index++
        }
        break
      default:
        break
    }
  }
  return result
}

let shuttingDown = false

async function shutdown(
  reason: string,
  close: () => Promise<void>,
  exitCode = 0
) {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  console.log(`[PortinoService] shutdown starting (${reason})`)
  try {
    await close()
  } catch (error) {
    console.error('[PortinoService] error while closing server', error)
  }
  console.log('[PortinoService] shutdown complete, exiting soon')
  // Defer process exit to allow async teardown (e.g., trace flush) to complete.
  setTimeout(() => process.exit(exitCode), 50)
}

main().catch((error) => {
  console.error('[PortinoService] fatal error during startup', error)
  process.exit(1)
})
