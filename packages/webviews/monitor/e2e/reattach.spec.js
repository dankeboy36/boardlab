// @ts-check
import { test } from '@playwright/test'
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
    window.localStorage.setItem('vscodeState', JSON.stringify(payload))
  }, state)
}

const fetchMetrics = async (port) =>
  fetch(`http://127.0.0.1:${port}/metrics`, { cache: 'no-store' }).then((res) =>
    res.json()
  )

const findStream = (metrics, basePortKey) =>
  metrics.activeStreams.find((entry) =>
    entry.portKey.startsWith(`${basePortKey}@`)
  )

const requiresMessenger = process.env.BOARDLAB_E2E_MESSENGER === '1'

test.describe('Device reattach with multiple clients', () => {
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

  test('reattaches twice with two monitor clients on the same port', async ({
    browser,
  }) => {
    const basePortKey = createPortKey(PORT)
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const page1 = await ctx1.newPage()
    const page2 = await ctx2.newPage()

    await installState(page1, buildPersistedState(PORT))
    await installState(page2, buildPersistedState(PORT))

    await Promise.all([
      page1.goto(`/?bridgeport=${server.port}`),
      page2.goto(`/?bridgeport=${server.port}`),
    ])
    await page1.waitForSelector('#root', { state: 'attached' })
    await page2.waitForSelector('#root', { state: 'attached' })

    await test.expect
      .poll(
        async () => {
          const metrics = await fetchMetrics(server.port)
          return findStream(metrics, basePortKey)?.clientCount ?? 0
        },
        { intervals: [200, 400, 800], timeout: 10_000 }
      )
      .toBeGreaterThan(1)

    for (let i = 0; i < 2; i += 1) {
      cliBridge.detachPort(basePortKey)
      await test.expect
        .poll(
          async () => {
            const metrics = await fetchMetrics(server.port)
            return !!findStream(metrics, basePortKey)
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
            return findStream(metrics, basePortKey)?.clientCount ?? 0
          },
          { intervals: [200, 400, 800], timeout: 10_000 }
        )
        .toBeGreaterThan(1)
    }

    await ctx1.close()
    await ctx2.close()
  })
})
