// @ts-check
import { expect, test } from '@playwright/test'
import { createPortKey } from 'boards-list'

import { MockCliBridge, createServer } from './utils/bridge.js'

const PORT = { protocol: 'serial', address: '/dev/tty.usbmock-1' }
const BAUDRATE = '9600'

const buildPersistedState = (port, baudrate = BAUDRATE) => ({
  serialMonitor: {
    selectedPort: port,
    selectedBaudrates: [[port, baudrate]],
    autoPlay: true,
  },
})

const installState = async (page, state) => {
  await page.addInitScript((payload) => {
    localStorage.setItem('vscodeState', JSON.stringify(payload))
  }, state)
}

const fetchMetrics = async (port) =>
  fetch(`http://127.0.0.1:${port}/metrics`, { cache: 'no-store' }).then((res) =>
    res.json()
  )

const hasStream = (metrics, basePortKey) =>
  metrics.activeStreams.some((entry) =>
    entry.portKey.startsWith(`${basePortKey}@`)
  )

const requiresMessenger = process.env.BOARDLAB_E2E_MESSENGER === '1'

test.describe('Plotter reattach', () => {
  test.skip(
    !requiresMessenger,
    'Requires VS Code messenger to open monitor streams in the webview.'
  )
  /** @type {{ port: number; close: () => Promise<void> }} */
  let server
  /** @type {MockCliBridge} */
  let cliBridge

  test.beforeAll(async () => {
    cliBridge = new MockCliBridge()
    server = await createServer({
      port: 0,
      cliBridgeFactory: () => cliBridge,
    })
  })

  test.afterAll(async () => {
    await server?.close()
  })

  test('auto-reconnects after detach/attach with plotter open', async ({
    page,
  }) => {
    const basePortKey = createPortKey(PORT)
    await installState(page, buildPersistedState(PORT))

    await page.goto(`/?bridgeport=${server.port}`)
    await page.waitForSelector('#root', { state: 'attached' })

    await test.expect
      .poll(
        async () => {
          const metrics = await fetchMetrics(server.port)
          return hasStream(metrics, basePortKey)
        },
        { intervals: [200, 400, 800], timeout: 10_000 }
      )
      .toBe(true)

    cliBridge.detachPort(basePortKey)
    await test.expect
      .poll(
        async () => {
          const metrics = await fetchMetrics(server.port)
          return hasStream(metrics, basePortKey)
        },
        { intervals: [200, 400, 800], timeout: 10_000 }
      )
      .toBe(false)

    cliBridge.attachPort({
      protocol: 'serial',
      address: PORT.address,
      boards: [{ name: 'Mock Uno', fqbn: 'arduino:avr:uno' }],
    })

    await test.expect
      .poll(
        async () => {
          const metrics = await fetchMetrics(server.port)
          return hasStream(metrics, basePortKey)
        },
        { intervals: [200, 400, 800], timeout: 10_000 }
      )
      .toBe(true)
  })
})
