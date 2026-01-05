import path from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: path.resolve(__dirname),
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/test/suite/**/*-vsix-test.ts'],
    setupFiles: ['src/test/setup/vscode.ts'],
  },
})
