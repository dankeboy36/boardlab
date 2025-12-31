import path from 'node:path'

const SPECIAL_REGEX_CHARS = /[\\^$.*+?()[\]{}|]/g

function escapeRegex(segment) {
  return segment.replace(SPECIAL_REGEX_CHARS, '\\$&')
}

function toCssSource(source) {
  if (typeof source === 'string') {
    return source
  }
  if (source instanceof Uint8Array) {
    return Buffer.from(source).toString('utf8')
  }
  if (source == null) {
    return ''
  }
  return String(source)
}

/**
 * Ensures that Vite emits a single CSS asset for the bundle. All CSS files
 * under the configured directory (default: `static/css/`) are concatenated into
 * `cssFileName`. Any references in the generated HTML or chunk metadata are
 * rewritten to point at the consolidated stylesheet so the webview only needs
 * to load one CSS file.
 *
 * @param {{
 *   cssFileName?: string
 * }} [options]
 */
export function singleCssBundlePlugin(options = {}) {
  const cssFileName = (options.cssFileName ?? 'static/css/main.css').replace(
    /\\/g,
    '/'
  )

  const parsedPath = path.posix.parse(cssFileName)
  const targetDir =
    parsedPath.dir && parsedPath.dir !== '.' ? parsedPath.dir : ''
  const cssDir = targetDir ? `${targetDir}/` : ''
  const cssBase = parsedPath.name
  const htmlPattern = new RegExp(
    `${escapeRegex(cssDir + cssBase)}[^"']*\\.css`,
    'g'
  )

  return {
    name: 'single-css-bundle',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(htmlPattern, cssFileName)
    },
    generateBundle(_options, bundle) {
      let combinedCss = ''
      const cssFiles = []
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'asset' || !fileName.endsWith('.css')) {
          continue
        }
        const assetDir = path.posix.dirname(fileName)
        const normalizedAssetDir = assetDir === '.' ? '' : assetDir
        if (normalizedAssetDir === targetDir) {
          combinedCss += combinedCss
            ? `\n${toCssSource(output.source)}`
            : toCssSource(output.source)
          cssFiles.push(fileName)
        }
      }

      if (!cssFiles.length) {
        return
      }

      for (const fileName of cssFiles) {
        delete bundle[fileName]
      }

      bundle[cssFileName] = {
        type: 'asset',
        name: path.posix.basename(cssFileName),
        fileName: cssFileName,
        source: combinedCss,
      }

      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          const metadata = output.viteMetadata
          if (metadata?.importedCss?.length) {
            metadata.importedCss = [cssFileName]
          }
        }
      }
    },
  }
}

export default singleCssBundlePlugin
