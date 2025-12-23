import path from 'node:path'

/**
 * @param {string} name
 * @param {string} dirname
 */
export function getWebviewBuildConfig(name, dirname) {
  const buildTarget = process.env.BOARDLAB_WEBVIEW_BUILD_TARGET ?? 'dist'
  const isOutBuild = buildTarget === 'out'
  const outDir = isOutBuild
    ? 'out'
    : path.resolve(dirname, `../../../dist/webviews/${name}`)
  return { buildTarget, isOutBuild, outDir }
}
