// @ts-check
import { MockCliBridge } from './mockCliBridge.js'
import { createServer } from './server.js'

async function main() {
  await createServer({
    cliBridgeFactory: () => new MockCliBridge(),
    testIntrospection: true,
    debug: true,
  })
}

main().catch(console.error)
