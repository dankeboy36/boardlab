// @ts-check
import { spawn } from 'node:child_process'

/**
 * @typedef {Object} StartDaemonParams
 * @property {string} cliPath Path to the Arduino CLI executable.
 * @property {string} [cliConfigPath] Path to the Arduino CLI configuration file
 *   to use.
 * @property {number} [port=0] The port number for the daemon. If `0`, a random
 *   available port will be opened. Default is `0`
 *
 * @typedef {Object} StartDaemonResult
 * @property {DaemonAddress} address Of the running Arduino CLI daemon.
 * @property {import('node:child_process').ChildProcess} cp The daemon process.
 *
 * @typedef {Object} DaemonAddress
 * @property {string} hostname
 * @property {number} port
 */

/**
 * @param {StartDaemonParams} params
 * @returns {Promise<StartDaemonResult>}
 */
export async function startDaemon(params) {
  const args = [
    'daemon',
    '--port',
    String(params.port ?? 0),
    ...(params.cliConfigPath ? ['--config-file', params.cliConfigPath] : []),
    '--format',
    'jsonmini',
  ]
  const cp = spawn(params.cliPath, args)
  return new Promise((resolve, reject) => {
    cp.stdout.on('data', function dataHandler(chunk) {
      const line = chunk.toString()
      const address = tryParseDaemonAddress(line)
      if (address) {
        cp.removeListener('data', dataHandler)
        resolve({ address, cp })
      }
    })
    let errorMessage = ''
    cp.stderr.on('data', (chunk) => (errorMessage += chunk.toString()))
    cp.on('error', reject)
    cp.on('exit', (code, signal) => {
      if (code) {
        reject(new Error(`Unexpected exit code: ${code} ${errorMessage}`))
      }
      if (signal) {
        reject(new Error(`Unexpected exit signal: ${signal} ${errorMessage}`))
      }
      reject(
        new Error(
          `Unexpected exit before resolving the CLI daemon address: ${errorMessage}`
        )
      )
    })
  })
}

/**
 * @param {string} chunk
 * @returns {DaemonAddress | undefined}
 */
function tryParseDaemonAddress(chunk) {
  /** @type {Record<string, unknown> | undefined} */
  let json
  try {
    json = JSON.parse(chunk)
  } catch {}
  if (!json) {
    return undefined
  }
  const maybeIP = json['IP']
  const maybePort = json['Port']
  if (typeof maybeIP === 'string' && typeof maybePort === 'string') {
    const port = Number.parseInt(maybePort, 10)
    if (!Number.isNaN(port)) {
      return { hostname: maybeIP, port }
    }
  }
  return undefined
}
