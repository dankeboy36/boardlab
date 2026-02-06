import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['packages/webviews/monitor-shared/vitest.setup.js'],
  },
})
