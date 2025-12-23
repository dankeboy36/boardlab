// @ts-check
import { expect, test } from '@playwright/test'

import { MockCliBridge, createServer } from './utils/bridge.js'

async function selectPort(page, portKey) {
  await page.waitForSelector('#serial-port', { state: 'attached' })
  await page.evaluate((value) => {
    const el = /** @type {HTMLSelectElement | null} */ (
      document.getElementById('serial-port')
    )
    if (!el) throw new Error('serial-port select not found')
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, portKey)
}

async function getMetrics(port) {
  const res = await fetch(`http://localhost:${port}/__test__/metrics`)
  return /** @type {Promise<any>} */ (res.json())
}

test.describe('Monitor reconnect + count continuity', () => {
  /** @type {{ port: number; close: () => Promise<void> }} */
  let server
  /** @type {MockCliBridge} */
  let cliBridge

  test.beforeAll(async () => {
    cliBridge = new MockCliBridge()
    server = await createServer({
      port: 0,
      cliBridgeFactory: () => cliBridge,
      testIntrospection: true,
    })
  })

  test.afterAll(async () => {
    await server?.close()
  })

  test('two clients, detach/attach, one resumes with increasing count', async ({
    browser,
  }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const page1 = await ctx1.newPage()
    const page2 = await ctx2.newPage()

    const portKey = 'arduino+serial:///dev/tty.usbmock-1'

    await page1.goto(`/?bridgeport=${server.port}`)
    await page2.goto(`/?bridgeport=${server.port}`)
    await expect(page1.getByTitle(/WebSocket: connected/)).toBeVisible()
    await expect(page2.getByTitle(/WebSocket: connected/)).toBeVisible()

    // Client 1 starts streaming
    await selectPort(page1, portKey)
    // Wait until count reaches at least 4
    await test.expect
      .poll(
        async () =>
          (await getMetrics(server.port)).activeStreams?.[portKey]?.lastCount ??
          -1,
        {
          intervals: [200, 400, 800],
          timeout: 10_000,
        }
      )
      .toBeGreaterThanOrEqual(4)

    // Client 2 joins same port, counts keep increasing
    await selectPort(page2, portKey)
    const beforeJoin =
      (await getMetrics(server.port)).activeStreams?.[portKey]?.lastCount ?? 0
    await test.expect
      .poll(
        async () =>
          (await getMetrics(server.port)).activeStreams?.[portKey]?.lastCount ??
          0,
        {
          intervals: [200, 400, 800],
          timeout: 10_000,
        }
      )
      .toBeGreaterThan(beforeJoin)

    // Stop client 2: clear the selected port to deterministically drop the stream
    await page2.evaluate(() => {
      const el = /** @type {HTMLSelectElement | null} */ (
        document.getElementById('serial-port')
      )
      if (!el) return
      el.value = ''
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await test.expect
      .poll(
        async () =>
          (await getMetrics(server.port)).activeStreams?.[portKey]
            ?.clientCount ?? 0,
        {
          intervals: [200, 400, 800],
          timeout: 10_000,
        }
      )
      .toBe(1)

    // Detach device
    cliBridge.detachPort(portKey)
    await test.expect
      .poll(
        async () => (await getMetrics(server.port)).activeStreams?.[portKey],
        {
          intervals: [200, 400, 800],
          timeout: 10_000,
        }
      )
      .toBeUndefined()

    // Re-attach device
    cliBridge.attachPort({
      protocol: 'serial',
      address: '/dev/tty.usbmock-1',
      boards: [{ name: 'Mock Uno', fqbn: 'arduino:avr:uno' }],
    })

    // After re-attach, at least one client (client 1) auto-reconnects
    await test.expect
      .poll(
        async () =>
          (await getMetrics(server.port)).activeStreams?.[portKey]
            ?.clientCount ?? 0,
        {
          intervals: [200, 400, 800],
          timeout: 10_000,
        }
      )
      .toBeGreaterThanOrEqual(1)

    // And the count continues increasing from its previous value
    const afterAttach =
      (await getMetrics(server.port)).activeStreams?.[portKey]?.lastCount ?? 0
    await test.expect
      .poll(
        async () =>
          (await getMetrics(server.port)).activeStreams?.[portKey]?.lastCount ??
          0,
        {
          intervals: [200, 400, 800],
          timeout: 10_000,
        }
      )
      .toBeGreaterThan(afterAttach)

    await ctx1.close()
    await ctx2.close()
  })
})
