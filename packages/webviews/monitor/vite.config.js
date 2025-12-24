import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

import { singleCssBundlePlugin } from '../base/vite/singleCssBundlePlugin.mjs'
import { getWebviewBuildConfig } from '../base/vite/webviewBuildConfig.mjs'

const { isOutBuild, outDir, emptyOutDir } = getWebviewBuildConfig(
  'monitor',
  __dirname
)

export default defineConfig({
  base: './',
  plugins: [react(), singleCssBundlePlugin()],
  optimizeDeps: {
    include: ['@boardlab/protocol'],
  },
  resolve: {
    alias: {
      '@boardlab/base': path.resolve(__dirname, '../base/src/index.ts'),
      '@boardlab/protocol': path.resolve(
        __dirname,
        '../../protocol/src/index.ts'
      ),
      '@boardlab/monitor-shared': path.resolve(
        __dirname,
        '../monitor-shared/src'
      ),
      '@boardlab/resources': path.resolve(
        __dirname,
        '../resources/src/index.tsx'
      ),
    },
  },
  build: {
    outDir,
    sourcemap: isOutBuild,
    minify: isOutBuild ? false : 'esbuild',
    emptyOutDir,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
        entryFileNames: 'static/js/main.js',
        assetFileNames: (assetInfo) => {
          const assetName = assetInfo.name ?? ''
          const ext = path.extname(assetName)
          if (ext === '.css') {
            return 'static/css/main.css'
          }
          return 'static/media/[name][extname]'
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.js'],
    exclude: ['e2e/**', 'playwright-report/**', 'test-results/**'],
    deps: {
      optimizer: {
        web: {
          include: ['vscode-elements-x', 'vscode-react-elements-x'],
        },
      },
    },
  },
})
