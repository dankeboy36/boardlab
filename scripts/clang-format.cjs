// @ts-check
const path = require('node:path')
const cp = require('node:child_process')

const { globSync } = require('glob')
const { clangFormatPath } = require('clang-format-node')

function main() {
  const files = globSync('**/*.{ino,cpp,h}', {
    cwd: path.join(__dirname, '../test_workspace'),
    absolute: true,
  })

  for (const file of files) {
    const result = cp.spawnSync(clangFormatPath, ['-i', file])
    if (result.status !== 0) {
      process.exit(result.status ?? 1)
    }
  }

  console.log(`Done. Formatted ${files.length} ino-like files.`)
}

main()
