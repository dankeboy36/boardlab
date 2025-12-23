// @ts-check
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const { createServer } = require('@vscode-ardunno/portino-bridge/server')
export const {
  MockCliBridge,
} = require('@vscode-ardunno/portino-bridge/mockCliBridge')
