// @ts-check
import { expect, test } from '@playwright/test'

import { MockCliBridge, createServer } from './utils/bridge.js'

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
    })
  })

  test.afterAll(async () => {
    await server?.close()
  })

  test('two monitor pages render and metrics report active connections', async ({
    browser,
  }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const page1 = await ctx1.newPage()
    const page2 = await ctx2.newPage()

    await Promise.all([
      page1.goto(`/?bridgeport=${server.port}`),
      page2.goto(`/?bridgeport=${server.port}`),
    ])

    await page1.waitForSelector('#root', { state: 'attached' })
    await page2.waitForSelector('#root', { state: 'attached' })

    const metrics = await fetch(`http://localhost:${server.port}/metrics`).then(
      (res) => res.json()
    )
    expect(typeof metrics.connections.wsConnections).toBe('number')
    expect(Array.isArray(metrics.detectedPorts)).toBe(true)

    await ctx1.close()
    await ctx2.close()
  })
})
