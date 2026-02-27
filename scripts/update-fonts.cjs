// @ts-check
// https://github.com/microsoft/vscode-extension-samples/blob/61fda64ede073136f3716f69b067d212ef0893e1/product-icon-theme-sample/build/updateFont.js
const fs = require('node:fs')
const path = require('node:path')

const webfont = require('webfont')

const svgs = ['boardlab.svg', 'monitor.svg'].map((name) =>
  path.join(__dirname, '..', 'resources', 'icons', name)
)

async function generateFont() {
  try {
    const result = await webfont.webfont({
      files: svgs,
      formats: ['woff'],
      startUnicode: 0xe000,
      fontHeight: 1000,
      verbose: true,
      normalize: true,
      sort: false,
    })
    const dest = path.join(
      __dirname,
      '..',
      'resources',
      'theme',
      'boardlab.woff'
    )
    // @ts-ignore
    fs.writeFileSync(dest, result.woff, 'binary')
    console.log(`Font created at ${dest}`)
  } catch (e) {
    console.error('Font creation failed.', e)
  }
}

generateFont()
