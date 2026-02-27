// @ts-check
const fs = require('node:fs')
const path = require('node:path')

const LIGHT_FILL = '#424242'
const DARK_FILL = '#c5c5c5'

/**
 * @typedef {{
 *   source: { type: 'codicon'; name: string } | { type: 'local'; file: string }
 *   outputBase: string | string[]
 * }} IconConfig
 */

/** @type {IconConfig[]} */
const iconMap = [
  {
    source: { type: 'codicon', name: 'graph-line' },
    outputBase: 'plotter',
  },
  {
    source: { type: 'local', file: 'monitor.svg' },
    outputBase: 'monitor',
  },
]

const resolveCodiconsRoot = () => {
  const pkgPath = require.resolve('@vscode/codicons/package.json')
  return path.dirname(pkgPath)
}

const withSvgExtension = (/** @type {string} */ name) =>
  name.toLowerCase().endsWith('.svg') ? name : `${name}.svg`

/**
 * @param {string} svg
 * @param {string} color
 */
const replaceOrInjectFill = (svg, color) => {
  let replacedAny = false
  const replaced = svg.replace(
    /fill=(['"])([^'"]*)\1/g,
    (full, quote, value) => {
      if (String(value).toLowerCase() === 'none') {
        return full
      }
      replacedAny = true
      return `fill=${quote}${color}${quote}`
    }
  )
  if (replacedAny) {
    return replaced
  }
  return replaced.replace(/<svg\b([^>]*)>/, `<svg$1 fill="${color}">`)
}

/**
 * @param {{ type: 'codicon'; name: string }
 *   | { type: 'local'; file: string }} source
 * @param {string} codiconSrcDir
 * @param {string} localSrcDir
 */
const resolveSourcePath = (source, codiconSrcDir, localSrcDir) => {
  if (source.type === 'codicon') {
    return path.join(codiconSrcDir, `${source.name}.svg`)
  }
  return path.join(localSrcDir, withSvgExtension(source.file))
}

const main = () => {
  const codiconsRoot = resolveCodiconsRoot()
  const codiconSrcDir = path.join(codiconsRoot, 'src', 'icons')
  const localSrcDir = path.join(__dirname, '..', 'resources', 'icons')
  const outDir = path.join(__dirname, '..', 'resources', 'icons')

  fs.mkdirSync(outDir, { recursive: true })

  let generated = 0
  iconMap.forEach(({ source, outputBase }) => {
    const srcPath = resolveSourcePath(source, codiconSrcDir, localSrcDir)
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Icon source does not exist: ${srcPath}`)
    }
    const svg = fs.readFileSync(srcPath, 'utf8')
    const outputBases = Array.isArray(outputBase) ? outputBase : [outputBase]

    const lightSvg = replaceOrInjectFill(svg, LIGHT_FILL)
    const darkSvg = replaceOrInjectFill(svg, DARK_FILL)

    outputBases.forEach((base) => {
      fs.writeFileSync(path.join(outDir, `${base}-light.svg`), lightSvg, 'utf8')
      fs.writeFileSync(path.join(outDir, `${base}-dark.svg`), darkSvg, 'utf8')
      generated += 2
    })
  })

  console.log(`Generated ${generated} editor icons in ${outDir}.`)
}

main()
