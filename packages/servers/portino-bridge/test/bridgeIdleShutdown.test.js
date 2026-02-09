// @ts-check
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serviceMainPath = path.join(__dirname, '..', 'out', 'serviceMain.js')
const HOST = '127.0.0.1'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })

const waitForHealth = async (port, attempts = 40, gapMs = 50) => {
  const url = `http://${HOST}:${port}/control/health`
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST' })
      if (res.ok) {
        return await res.json()
      }
    } catch {
      // keep polling until the server is ready
    }
    await delay(gapMs)
  }
  throw new Error('Timed out waiting for monitor bridge health check')
}

const postJson = async (url, payload) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(`Unexpected status ${res.status} from ${url}`)
  }
  return res.json()
}

describe('monitor bridge idle shutdown', () => {
  it('exits after heartbeat timeout and idle timeout', async () => {
    const port = await getFreePort()
    const child = spawn(
      process.execPath,
      [
        serviceMainPath,
        '--port',
        String(port),
        '--heartbeat-timeout-ms',
        '300',
        '--heartbeat-sweep-ms',
        '100',
        '--idle-timeout-ms',
        '300',
      ],
      {
        env: {
          ...process.env,
          MOCK_CLI: 'true',
        },
      }
    )

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    const exitPromise = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })

    try {
      await waitForHealth(port)
      const baseUrl = `http://${HOST}:${port}`
      const attach = await postJson(`${baseUrl}/control/attach`, {
        clientId: 'test-client',
      })
      await postJson(`${baseUrl}/control/heartbeat`, {
        token: attach.token,
      })
      await delay(150)
      await postJson(`${baseUrl}/control/heartbeat`, {
        token: attach.token,
      })

      const exitResult = await Promise.race([
        exitPromise,
        delay(2_500).then(() => {
          throw new Error(
            `Bridge did not exit in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        }),
      ])

      expect(exitResult.code).toBe(0)
    } finally {
      if (!child.killed) {
        child.kill('SIGTERM')
      }
      await Promise.race([exitPromise, delay(1_000)]).catch(() => undefined)
    }
  }, 10_000)
})
