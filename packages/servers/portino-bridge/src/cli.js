// @ts-check
import { createServer } from './server.js'

let port = 0
if (process.env.PORT) {
  port = Number(process.env.PORT)
}

if (!port) {
  const portArgIndex = process.argv.findIndex((arg) =>
    arg.startsWith('--port=')
  )
  if (portArgIndex !== -1) {
    const portArg = process.argv[portArgIndex]
    port = Number(portArg.split('=')[1])
  }
}

async function main() {
  return createServer({ port })
}

main().then(
  (server) => {
    console.log(`Server is running on http://localhost:${server.port}`)
  },
  (error) => {
    console.error('Error starting server:', error)
    process.exit(1)
  }
)
