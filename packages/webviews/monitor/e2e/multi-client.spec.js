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

async function expectActiveClients(port, key, expected) {
  await test.expect
    .poll(
      async () => {
        const res = await fetch(`http://localhost:${port}/__test__/metrics`)
        const json = await res.json()
        return json.activeStreams?.[key]?.clientCount ?? 0
      },
      { intervals: [200, 400, 800], timeout: 10_000 }
    )
    .toBe(expected)
}

test.describe('Two clients, one server', () => {
  /** @type {{ port: number; close: () => Promise<void> }} */
  let server

  test.beforeAll(async () => {
    const cliBridge = new MockCliBridge()
    server = await createServer({
      port: 0,
      cliBridgeFactory: () => cliBridge,
      testIntrospection: true,
    })
  })

  test.afterAll(async () => {
    await server?.close()
  })

  test('both clients start/stop and metrics reflect counts', async ({
    browser,
  }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const page1 = await ctx1.newPage()
    const page2 = await ctx2.newPage()

    const port1 = 'arduino+serial:///dev/tty.usbmock-1'
    const port2 = 'arduino+serial:///dev/tty.usbmock-2'

    // Open both clients
    await page1.goto(`/?bridgeport=${server.port}`)
    await page2.goto(`/?bridgeport=${server.port}`)

    await expect(page1.getByTitle(/WebSocket: connected/)).toBeVisible()
    await expect(page2.getByTitle(/WebSocket: connected/)).toBeVisible()

    // Select same port in both and start
    await selectPort(page1, port1)
    await selectPort(page2, port1)

    // Expect two active clients on port1
    await expectActiveClients(server.port, port1, 2)

    // Stop on client 1 deterministically by clearing selected port -> should drop to 1
    await page1.evaluate(() => {
      const el = /** @type {HTMLSelectElement | null} */ (
        document.getElementById('serial-port')
      )
      if (!el) return
      el.value = ''
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expectActiveClients(server.port, port1, 1)

    // Switch client 2 to a different port (auto-starts)
    await selectPort(page2, port2)

    // Now port1 has 0, port2 has 1
    await expectActiveClients(server.port, port1, 0)
    await expectActiveClients(server.port, port2, 1)

    await ctx1.close()
    await ctx2.close()
  })
})
