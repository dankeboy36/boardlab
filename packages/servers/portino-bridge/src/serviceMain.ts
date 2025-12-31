import { createServer } from './server.js'

const HOST = '127.0.0.1'
const IDLE_TIMEOUT_MS = 30_000

interface ServiceOptions {
  port?: number
  cliPath?: string
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const desiredPort = options.port ?? 0

  const { close, attachmentRegistry } = await createServer({
    port: desiredPort,
    cliPath: options.cliPath,
    host: HOST,
  })

  attachmentRegistry.configure({
    idleTimeoutMs: IDLE_TIMEOUT_MS,
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

function parseArgs(args: readonly string[]): ServiceOptions {
  const result: ServiceOptions = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    const value = args[index + 1]
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
  try {
    await close()
  } catch (error) {
    console.error('[PortinoService] error while closing server', error)
  }
  process.exit(exitCode)
}

main().catch((error) => {
  console.error('[PortinoService] fatal error during startup', error)
  process.exit(1)
})
