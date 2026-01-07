// @ts-check
import { expect, test } from '@playwright/test'

import { MockCliBridge, createServer } from './utils/bridge.js'

test.describe('Plotter layout', () => {
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

  test('page loads and metrics are reachable', async ({ page }) => {
    await page.goto(`/?bridgeport=${server.port}`)
    await page.waitForSelector('#root')

    const metrics = await fetch(`http://localhost:${server.port}/metrics`).then(
      (res) => res.json()
    )
    expect(metrics).toHaveProperty('connections')
    expect(Array.isArray(metrics.detectedPorts)).toBe(true)
  })
})
