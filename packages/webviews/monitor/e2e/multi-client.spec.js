// @ts-check
import { expect, test } from '@playwright/test'

import { MockCliBridge, createServer } from './utils/bridge.js'

test.describe('Two clients, one server', () => {
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

  test('both clients render the monitor shell', async ({ browser }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const page1 = await ctx1.newPage()
    const page2 = await ctx2.newPage()

    await page1.goto(`/?bridgeport=${server.port}`)
    await page2.goto(`/?bridgeport=${server.port}`)

    await page1.waitForSelector('#root', { state: 'attached' })
    await page2.waitForSelector('#root', { state: 'attached' })

    const metrics = await fetch(`http://localhost:${server.port}/metrics`).then(
      (res) => res.json()
    )

    expect(typeof metrics.connections.wsConnections).toBe('number')
    expect(Array.isArray(metrics.activeStreams)).toBe(true)
    expect(Array.isArray(metrics.detectedPorts)).toBe(true)

    await ctx1.close()
    await ctx2.close()
  })
})
