// @ts-check

const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { globSync } = require('glob')

const rootDir = path.resolve(__dirname, '..')
const testResourcesDir = path.join(
  rootDir,
  '.vscode-test',
  'extester-resources'
)
const extensionsDir = path.join(
  rootDir,
  '.vscode-test',
  'extester-extensions',
  `${Date.now()}-${process.pid}`
)
const smokeTestFile = path.join(
  rootDir,
  'packages',
  'extension',
  'src',
  'test',
  'smoke',
  'activation.smoke.test.cjs'
)
const mochaConfigFile = path.join(
  rootDir,
  'packages',
  'extension',
  'src',
  'test',
  'smoke',
  '.mocharc.js'
)
const workspaceResource = path.join(rootDir, 'test_workspace', 'blink')
const packageJson = require(path.join(rootDir, 'package.json'))
const extensionIdPrefix =
  `${packageJson.publisher}.${packageJson.name}-`.toLowerCase()

function main() {
  if (!fs.existsSync(smokeTestFile)) {
    throw new Error(`Smoke test file not found: ${smokeTestFile}`)
  }
  if (!fs.existsSync(mochaConfigFile)) {
    throw new Error(`Mocha config not found: ${mochaConfigFile}`)
  }

  const cliPath = require.resolve('vscode-extension-tester/out/cli.js', {
    paths: [rootDir],
  })
  const vsixPath = resolveVsixPath()

  fs.mkdirSync(testResourcesDir, { recursive: true })
  fs.mkdirSync(extensionsDir, { recursive: true })

  console.log(`Using VSIX: ${vsixPath}`)

  runExtest(cliPath, ['get-vscode', '--storage', testResourcesDir])

  runExtest(cliPath, ['get-chromedriver', '--storage', testResourcesDir])

  runExtest(cliPath, [
    'install-vsix',
    '--storage',
    testResourcesDir,
    '--extensions_dir',
    extensionsDir,
    '--vsix_file',
    vsixPath,
  ])
  assertVsixInstalled()

  runExtest(cliPath, [
    'run-tests',
    smokeTestFile,
    '--storage',
    testResourcesDir,
    '--extensions_dir',
    extensionsDir,
    '--mocha_config',
    mochaConfigFile,
    '--open_resource',
    workspaceResource,
  ])
}

function assertVsixInstalled() {
  const installedDirs = fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const boardlabDir = installedDirs.find((dir) =>
    dir.toLowerCase().startsWith(extensionIdPrefix)
  )

  if (!boardlabDir) {
    throw new Error(
      [
        `VSIX install did not produce an extension directory with prefix "${extensionIdPrefix}" in: ${extensionsDir}`,
        `Found directories: ${
          installedDirs.length ? installedDirs.join(', ') : '(none)'
        }`,
      ].join('\n')
    )
  }
}

function resolveVsixPath() {
  const files = globSync('*.vsix', {
    cwd: rootDir,
    absolute: true,
    nodir: true,
  }).filter((file) => file.endsWith('.vsix'))

  const uniqueFiles = Array.from(new Set(files))

  if (!uniqueFiles.length) {
    throw new Error(`No VSIX found. Looked at: '*.vsix' from ${rootDir}`)
  }

  if (uniqueFiles.length > 1) {
    const relativeFiles = uniqueFiles.map((file) =>
      path.relative(rootDir, file)
    )
    throw new Error(
      `Expected exactly one VSIX, found ${uniqueFiles.length}:\n${relativeFiles
        .map((file) => `- ${file}`)
        .join('\n')}`
    )
  }

  return uniqueFiles[0]
}

/**
 * @param {string} cliPath
 * @param {string[]} args
 */
function runExtest(cliPath, args) {
  const result = cp.spawnSync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
