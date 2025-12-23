// @ts-check
import { expect, test } from '@playwright/test'

import { MockCliBridge, createServer } from './utils/bridge.js'

test.describe('Serial UI + Mock Bridge', () => {
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

  test('connects, selects a port, starts then stops monitor', async ({
    page,
  }) => {
    // Open the app pointing at the mock bridge
    await page.goto(`/?bridgeport=${server.port}`)

    // Wait for websocket connection status to become connected
    await expect(page.getByTitle(/WebSocket: connected/)).toBeVisible()

    // Programmatically select the first mock serial port via custom element
    const portKey = 'arduino+serial:///dev/tty.usbmock-1'
    await page.waitForSelector('#serial-port', { state: 'attached' })
    await page.evaluate((value) => {
      const el = /** @type {HTMLSelectElement | null} */ (
        document.getElementById('serial-port')
      )
      if (!el) throw new Error('serial-port select not found')
      el.value = value
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }, portKey)

    // Poll server metrics until a stream is active for the selected port
    await page.waitForFunction(
      async ({ port, key }) => {
        const res = await fetch(`http://localhost:${port}/__test__/metrics`)
        const json = await res.json()
        const entry = json.activeStreams?.[key]
        return entry && entry.clientCount >= 1
      },
      { port: server.port, key: portKey },
      { polling: 250, timeout: 10_000 }
    )

    // Stop the monitor
    await page.locator('vscode-icon[title="Stop monitor"]').evaluate((el) => {
      el?.shadowRoot?.querySelector('button')?.click()
    })

    // Stream should be torn down (no clients remain)
    await page.waitForFunction(
      async ({ port, key }) => {
        const res = await fetch(`http://localhost:${port}/__test__/metrics`)
        const json = await res.json()
        const entry = json.activeStreams?.[key]
        return !entry || entry.clientCount === 0
      },
      { port: server.port, key: portKey },
      { polling: 250, timeout: 10_000 }
    )
  })
})
