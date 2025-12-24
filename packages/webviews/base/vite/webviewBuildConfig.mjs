import path from 'node:path'

/**
 * @param {string} name
 * @param {string} dirname
 */
export function getWebviewBuildConfig(name, dirname) {
  const envMode = (process.env.NODE_ENV ?? '').toLowerCase()
  const isOutBuild = envMode === 'development'
  const outDir = isOutBuild
    ? 'out'
    : path.resolve(dirname, `../../../dist/webviews/${name}`)
  const emptyOutDir = isOutBuild
  return { isOutBuild, outDir, emptyOutDir }
}
