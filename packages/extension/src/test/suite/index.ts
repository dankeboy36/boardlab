import path from 'node:path'

import glob from 'glob'
import Mocha from 'mocha'

export function run(): Promise<void> {
  // Create the mocha test
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: noTestTimeout() ? 0 : 2_000,
  })

  const testsRoot = path.resolve(__dirname, '..')

  return new Promise((resolve, reject) => {
    glob('**/**.test.js', { cwd: testsRoot }, (err, files) => {
      if (err) {
        return reject(err)
      }

      // Add files to the test suite
      files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)))

      try {
        // Run the mocha test
        mocha.run((failures) => {
          if (failures > 0) {
            reject(new Error(`${failures} tests failed.`))
          } else {
            resolve()
          }
        })
      } catch (err) {
        console.error(err)
        reject(err)
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
