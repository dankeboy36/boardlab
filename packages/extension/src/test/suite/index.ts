import path from 'node:path'

import { glob } from 'glob'
import Mocha from 'mocha'

export async function run(): Promise<void> {
  // Create the mocha test
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: noTestTimeout() ? 0 : 2_000,
  })

  const testsRoot = path.resolve(__dirname, '..')

  const files = await glob('**/**.test.js', { cwd: testsRoot })
  files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)))

  await new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} tests failed.`))
      } else {
        resolve(undefined)
      }
    })
  })
}

function noTestTimeout(): boolean {
  return (
    typeof process.env.NO_TEST_TIMEOUT === 'string' &&
    /true/i.test(process.env.NO_TEST_TIMEOUT)
  )
}
