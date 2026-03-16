const assert = require('node:assert/strict')
const test = require('node:test')

const {
  hasDeprecatedCatalogMarker,
  isNoisyBoardName,
  isOfficialArduinoIndexUrl,
  parseArgs,
  pruneCatalogForOutput,
  toPlatformOnlyCatalogPayload,
} = require('./update-3rd-party-platforms.cjs')

test('isOfficialArduinoIndexUrl detects official Arduino package index host', () => {
  assert.equal(
    isOfficialArduinoIndexUrl(
      'https://downloads.arduino.cc/packages/package_index.json'
    ),
    true
  )
  assert.equal(
    isOfficialArduinoIndexUrl(
      'https://github.com/espressif/arduino-esp32/releases/download/package_esp32_index.json'
    ),
    false
  )
})

test('deprecated and noisy markers classify known junk rows', () => {
  assert.equal(hasDeprecatedCatalogMarker('Use ATTinyCore instead'), true)
  assert.equal(hasDeprecatedCatalogMarker('<b>Supported</b>: AVR128DA'), true)
  assert.equal(isNoisyBoardName('Program via ISP or Serial:'), true)
  assert.equal(isNoisyBoardName('USB (Micronucleus) boards:'), true)
  assert.equal(
    isNoisyBoardName(
      'If Win USB drivers not already installed, run the post_install.bat manually or DL from https://azduino.com/bin/micronucleus'
    ),
    true
  )
  assert.equal(
    isNoisyBoardName(
      'DB-series and 32/64k DA-series not supported by Arduino toolchain'
    ),
    true
  )
  assert.equal(
    isNoisyBoardName(
      "My toolchain version doesn't install correctly on Linux for reasons I don't understand, and may not work on mac."
    ),
    true
  )
  assert.equal(
    isNoisyBoardName(
      'Optiboot serial bootloader supported only on 0/1-series currently.'
    ),
    true
  )
  assert.equal(
    isNoisyBoardName('AVR128DA28,AVR128DA32,AVR128DA48,AVR128DA64'),
    true
  )
  assert.equal(isNoisyBoardName('ESP32 WROOM DevKit'), false)
})

test('parseArgs supports --include-official', () => {
  const parsed = parseArgs(['--include-official'])
  assert.equal(parsed.includeOfficial, true)
})

test('pruneCatalogForOutput removes deprecated/noisy entries and rebuilds board lists', () => {
  const rawCatalog = {
    platforms: [
      {
        url: 'https://vendor.example/package_vendor_index.json',
        platformId: 'vendor:avr',
        packageName: 'vendor',
        architecture: 'avr',
        name: 'Vendor AVR',
        version: '1.0.0',
        deprecated: false,
        types: ['Contributed'],
        boards: ['Real Board', 'Program via ISP or Serial:'],
      },
      {
        url: 'https://legacy.example/package_old_index.json',
        platformId: 'legacy:avr',
        packageName: 'legacy',
        architecture: 'avr',
        name: '[DEPRECATED] Legacy AVR',
        version: '1.0.0',
        deprecated: true,
        types: ['Contributed'],
        boards: ['Legacy Board'],
      },
      {
        url: 'https://empty.example/package_empty_index.json',
        platformId: 'empty:avr',
        packageName: 'empty',
        architecture: 'avr',
        name: 'Empty AVR',
        version: '1.0.0',
        deprecated: false,
        types: ['Contributed'],
        boards: ['USB (Micronucleus) boards:'],
      },
    ],
    boards: [
      {
        name: 'Real Board',
        url: 'https://vendor.example/package_vendor_index.json',
        platformId: 'vendor:avr',
        platformName: 'Vendor AVR',
        platformVersion: '1.0.0',
        deprecated: false,
      },
      {
        name: 'Known issue board',
        url: 'https://vendor.example/package_vendor_index.json',
        platformId: 'vendor:avr',
        platformName: 'Vendor AVR',
        platformVersion: '1.0.0',
        deprecated: true,
      },
      {
        name: 'Program via ISP or Serial:',
        url: 'https://vendor.example/package_vendor_index.json',
        platformId: 'vendor:avr',
        platformName: 'Vendor AVR',
        platformVersion: '1.0.0',
        deprecated: false,
      },
      {
        name: 'Legacy Board',
        url: 'https://legacy.example/package_old_index.json',
        platformId: 'legacy:avr',
        platformName: '[DEPRECATED] Legacy AVR',
        platformVersion: '1.0.0',
        deprecated: true,
      },
      {
        name: 'USB (Micronucleus) boards:',
        url: 'https://empty.example/package_empty_index.json',
        platformId: 'empty:avr',
        platformName: 'Empty AVR',
        platformVersion: '1.0.0',
        deprecated: false,
      },
      {
        name: 'DB-series and 32/64k DA-series not supported by Arduino toolchain',
        url: 'https://vendor.example/package_vendor_index.json',
        platformId: 'vendor:avr',
        platformName: 'Vendor AVR',
        platformVersion: '1.0.0',
        deprecated: false,
      },
      {
        name: 'AVR128DA28,AVR128DA32,AVR128DA48,AVR128DA64',
        url: 'https://vendor.example/package_vendor_index.json',
        platformId: 'vendor:avr',
        platformName: 'Vendor AVR',
        platformVersion: '1.0.0',
        deprecated: false,
      },
      {
        name: 'If Win USB drivers not already installed, run the post_install.bat manually or DL from https://azduino.com/bin/micronucleus',
        url: 'https://vendor.example/package_vendor_index.json',
        platformId: 'vendor:avr',
        platformName: 'Vendor AVR',
        platformVersion: '1.0.0',
        deprecated: false,
      },
    ],
  }

  const result = pruneCatalogForOutput(rawCatalog)

  assert.equal(result.catalog.platforms.length, 1)
  assert.equal(result.catalog.boards.length, 1)
  assert.equal(result.catalog.platforms[0].platformId, 'vendor:avr')
  assert.deepEqual(result.catalog.platforms[0].boards, ['Real Board'])
  assert.equal(result.catalog.boards[0].name, 'Real Board')

  assert.equal(result.dropped.deprecatedPlatforms.length, 1)
  assert.equal(result.dropped.deprecatedBoards.length, 1)
  assert.equal(result.dropped.noisyBoards.length, 5)
  assert.equal(result.dropped.platformsDroppedBecauseNoBoards.length, 1)
})

test('toPlatformOnlyCatalogPayload keeps platforms[].boards and omits top-level boards', () => {
  const payload = toPlatformOnlyCatalogPayload({
    platforms: [
      {
        url: 'https://vendor.example/package_vendor_index.json',
        platformId: 'vendor:avr',
        packageName: 'vendor',
        architecture: 'avr',
        name: 'Vendor AVR',
        version: '1.0.0',
        maintainer: 'Vendor',
        website: 'https://vendor.example',
        deprecated: false,
        types: ['Contributed'],
        boards: ['Real Board'],
      },
    ],
    boards: [],
  })

  assert.equal(Array.isArray(payload.platforms), true)
  assert.equal(payload.platforms.length, 1)
  assert.deepEqual(payload.platforms[0].boards, ['Real Board'])
  assert.equal('boards' in payload, false)
})
