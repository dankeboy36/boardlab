// @ts-check
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const DEFAULT_TAG = process.env.TAG || '1.10.3'
const DEFAULT_TARGET =
  process.env.TARGET || 'resources/arduino-examples/examples'

function usage() {
  console.error(`Usage: TAG=<tag> TARGET=<dir> ${path.basename(process.argv[1])}
  or:   ${path.basename(process.argv[1])} --tag <tag> --target <dir>

Defaults:
  TAG    = ${DEFAULT_TAG}
  TARGET = ${DEFAULT_TARGET}
`)
}

/** @param {string[]} argv */
function parseArgs(argv) {
  let tag = DEFAULT_TAG
  let target = DEFAULT_TARGET

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      usage()
      process.exit(0)
    }

    if (arg === '--tag') {
      const value = argv[i + 1]
      if (!value) {
        console.error('Missing value for --tag')
        usage()
        process.exit(1)
      }
      tag = value
      i += 1
      continue
    }

    if (arg === '--target') {
      const value = argv[i + 1]
      if (!value) {
        console.error('Missing value for --target')
        usage()
        process.exit(1)
      }
      target = value
      i += 1
      continue
    }

    console.error(`Unknown arg: ${arg}`)
    usage()
    process.exit(1)
  }

  return { tag, target }
}

/**
 * @param {readonly string[]} args
 * @param {import('child_process').ExecFileSyncOptionsWithStringEncoding
 *   | undefined} [options]
 */
function runGit(args, options) {
  return execFileSync('git', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...options,
  })
}

function main() {
  const { tag, target } = parseArgs(process.argv.slice(2))
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arduino-examples-'))
  const srcDir = path.join(tmpRoot, 'src')

  try {
    console.log('-> Cloning arduino/arduino-examples (full clone with tags)...')
    runGit([
      'clone',
      '--quiet',
      'https://github.com/arduino/arduino-examples.git',
      srcDir,
    ])
    runGit(['-C', srcDir, 'checkout', '-q', tag])
    const commitHash = runGit([
      '-C',
      srcDir,
      'rev-parse',
      '--short',
      'HEAD',
    ]).trim()
    console.log(`[ok] Checked out tag ${tag} (${commitHash})`)

    const examplesDir = path.join(srcDir, 'examples')
    if (
      !fs.existsSync(examplesDir) ||
      !fs.statSync(examplesDir).isDirectory()
    ) {
      console.error('[x] Clone failed or examples directory missing')
      process.exitCode = 2
      return
    }

    fs.mkdirSync(path.dirname(target), { recursive: true })
    console.log(`-> Copying examples to ${target}...`)
    fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(examplesDir, target, { recursive: true })

    console.log(
      `[ok] Done. Installed examples from arduino/arduino-examples@${tag} into ${target}`
    )
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

try {
  main()
} catch (err) {
  if (err && typeof err === 'object') {
    if ('stderr' in err && err.stderr) {
      process.stderr.write(String(err.stderr))
    }
    if ('stdout' in err && err.stdout) {
      process.stderr.write(String(err.stdout))
    }
  }
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
