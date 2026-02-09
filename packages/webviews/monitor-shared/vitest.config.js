import path from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@boardlab/base': path.resolve(__dirname, '../base/src/index.ts'),
      '@boardlab/protocol': path.resolve(
        __dirname,
        '../../protocol/src/index.ts'
      ),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.js'],
  },
})
