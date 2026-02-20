// @ts-check

const assert = require('node:assert/strict')

const { describe, before, it } = require('mocha')
const { InputBox, VSBrowser, Workbench } = require('vscode-extension-tester')

describe('BoardLab smoke', function () {
  this.timeout(180000)

  /** @type {import('selenium-webdriver').WebDriver} */
  let driver

  before(async function () {
    driver = VSBrowser.instance.driver
    await driver.sleep(3000)
  })

  it('opens command center and shows available actions', async function () {
    const workbench = new Workbench()
    await workbench.executeCommand('BoardLab: Open Command Center')

    const commandCenter = await InputBox.create(15000)
    const placeholder = await commandCenter.getPlaceHolder()
    assert.equal(
      placeholder,
      'Pick what you want to do with your sketch, board, or port'
    )

    const hasItems = await driver.wait(
      async () => {
        try {
          const items = await commandCenter.getQuickPicks()
          return items.length > 0
        } catch {
          return false
        }
      },
      120000,
      'BoardLab Command Center opened but no actions were shown.',
      500
    )
    assert.equal(hasItems, true)

    await commandCenter.cancel()
  })
})
