// @ts-check
import { expect, test } from '@playwright/test'

import { MockCliBridge, createServer } from './utils/bridge.js'

test.describe('Device detach/attach', () => {
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

  test('removing a device updates detected ports', async ({ page }) => {
    const portKey = 'arduino+serial:///dev/tty.usbmock-1'

    await page.goto(`/?bridgeport=${server.port}`)
    await expect(page.getByTitle(/WebSocket: connected/)).toBeVisible()

    // Initial detected ports include the device
    const initial = await fetch(
      `http://localhost:${server.port}/__test__/detected-ports`
    ).then((r) => r.json())
    expect(initial[portKey]).toBeTruthy()

    // Detach via mock bridge and expect it to vanish from server state
    cliBridge.detachPort(portKey)
    await test.expect
      .poll(
        async () => {
          const res = await fetch(
            `http://localhost:${server.port}/__test__/detected-ports`
          )
          const json = await res.json()
          return json[portKey]
        },
        { intervals: [200, 400, 800], timeout: 10_000 }
      )
      .toBeUndefined()

    // Re-attach and expect it to show up again
    cliBridge.attachPort({
      protocol: 'serial',
      address: '/dev/tty.usbmock-1',
      boards: [{ name: 'Mock Uno', fqbn: 'arduino:avr:uno' }],
    })
    await test.expect
      .poll(
        async () => {
          const res = await fetch(
            `http://localhost:${server.port}/__test__/detected-ports`
          )
          const json = await res.json()
          return !!json[portKey]
        },
        { intervals: [200, 400, 800], timeout: 10_000 }
      )
      .toBe(true)
  })
})
