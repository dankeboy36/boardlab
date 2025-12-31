// @ts-check
const fs = require('node:fs')
const path = require('node:path')

const LIGHT_FILL = '#424242'
const DARK_FILL = '#c5c5c5'

const iconMap = [
  {
    source: 'terminal',
    outputBase: 'monitor',
  },
  {
    source: 'graph-line',
    outputBase: 'plotter',
  },
]

const resolveCodiconsRoot = () => {
  const pkgPath = require.resolve('@vscode/codicons/package.json')
  return path.dirname(pkgPath)
}

/**
 * @param {string} svg
 * @param {string} color
 */
const replaceFill = (svg, color) =>
  svg.replace(/fill="[^"]*"/g, `fill="${color}"`)

const main = () => {
  const codiconsRoot = resolveCodiconsRoot()
  const srcDir = path.join(codiconsRoot, 'src', 'icons')
  const outDir = path.join(__dirname, '..', 'resources', 'icons')

  fs.mkdirSync(outDir, { recursive: true })

  iconMap.forEach(({ source, outputBase }) => {
    const srcPath = path.join(srcDir, `${source}.svg`)
    const svg = fs.readFileSync(srcPath, 'utf8')

    const lightSvg = replaceFill(svg, LIGHT_FILL)
    const darkSvg = replaceFill(svg, DARK_FILL)

    fs.writeFileSync(
      path.join(outDir, `${outputBase}-light.svg`),
      lightSvg,
      'utf8'
    )
    fs.writeFileSync(
      path.join(outDir, `${outputBase}-dark.svg`),
      darkSvg,
      'utf8'
    )
  })

  console.log(`Generated ${iconMap.length * 2} editor icons in ${outDir}.`)
}

main()
