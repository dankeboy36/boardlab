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
    })
  })

  test.afterAll(async () => {
    await server?.close()
  })

  test('renders monitor shell and exposes metrics', async ({ page }) => {
    await page.goto(`/?bridgeport=${server.port}`)
    await page.waitForSelector('#root', { state: 'attached' })

    const metricsStatus = await page.evaluate(
      (port) =>
        fetch(`http://127.0.0.1:${port}/metrics`, { cache: 'no-store' })
          .then((res) => res.ok)
          .catch(() => false),
      server.port
    )
    expect(metricsStatus).toBe(true)
  })
})
