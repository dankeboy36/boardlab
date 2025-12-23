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
      testIntrospection: true,
    })
  })

  test.afterAll(async () => {
    await server?.close()
  })

  test('toolbar is inline and plot area has height', async ({ page }) => {
    await page.goto(`/?bridgeport=${server.port}`)

    // Switch to Plotter tab (tab header, not the chart title)
    await page.getByRole('tab', { name: 'Plotter' }).click()

    const controls = page.locator('[data-testid="connection-controls"]').first()

    // Elements we expect in a single row
    const startIcon = controls.locator(
      'vscode-icon[title="Start (open monitor)"]'
    )
    const portLabel = controls.locator('vscode-label[for="serial-port"]')
    const baudLabel = controls.locator('vscode-label[for="baudrate"]')

    // Allow custom elements to render
    await expect(portLabel).toBeVisible()

    const [bStart, bPort, bBaud] = await Promise.all([
      startIcon.boundingBox(),
      portLabel.boundingBox(),
      baudLabel.boundingBox(),
    ])

    // Ensure all exist
    expect(bStart && bPort && bBaud).toBeTruthy()

    // Same row (top edge within 10px)
    const tops = [bStart.y, bPort.y, bBaud.y]
    const minTop = Math.min(...tops)
    const maxTop = Math.max(...tops)
    expect(maxTop - minTop).toBeLessThanOrEqual(10)

    // Plot toolbar button should be visible in tab header when active
    const tabToolbar = page.locator('[data-testid="tab-toolbar"]')
    const clearButton = tabToolbar.locator(
      'vscode-toolbar-button[title="Clear plot"]'
    )
    await expect(clearButton).toBeVisible()

    // Plot container should have meaningful height
    const plot = page.locator('.uplot').first()
    await expect(plot).toBeVisible()
    const pb = await plot.boundingBox()
    expect(pb?.height ?? 0).toBeGreaterThan(200)
  })
})
