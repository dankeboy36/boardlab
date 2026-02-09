// @ts-check
import { expect, test } from '@playwright/test'
import { createPortKey } from 'boards-list'

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
    })
  })

  test.afterAll(async () => {
    await server?.close()
  })

  test('removing a device updates detected ports', async ({ page }) => {
    const portKey = createPortKey({
      protocol: 'serial',
      address: '/dev/tty.usbmock-1',
    })

    await page.goto(`/?bridgeport=${server.port}`)
    await page.waitForSelector('#root', { state: 'attached' })

    const findEntry = (list) => list.find((entry) => entry.portKey === portKey)

    await expect
      .poll(
        async () => {
          const json = await fetch(
            `http://localhost:${server.port}/metrics/detected-ports`
          ).then((r) => r.json())
          return findEntry(json)
        },
        { intervals: [200, 400, 800], timeout: 10_000 }
      )
      .toBeTruthy()

    cliBridge.detachPort(portKey)
    await expect
      .poll(
        async () => {
          const json = await fetch(
            `http://localhost:${server.port}/metrics/detected-ports`
          ).then((r) => r.json())
          return findEntry(json)
        },
        { intervals: [200, 400, 800], timeout: 10_000 }
      )
      .toBeUndefined()

    cliBridge.attachPort({
      protocol: 'serial',
      address: '/dev/tty.usbmock-1',
      boards: [{ name: 'Mock Uno', fqbn: 'arduino:avr:uno' }],
    })
    await expect
      .poll(
        async () => {
          const json = await fetch(
            `http://localhost:${server.port}/metrics/detected-ports`
          ).then((r) => r.json())
          return !!findEntry(json)
        },
        { intervals: [200, 400, 800], timeout: 10_000 }
      )
      .toBe(true)
  })
})
