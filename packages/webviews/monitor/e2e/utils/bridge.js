// @ts-check
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const { createServer } = require('@boardlab/portino-bridge/server')
export const {
  MockCliBridge,
} = require('@boardlab/portino-bridge/mockCliBridge')
