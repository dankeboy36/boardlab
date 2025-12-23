import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { singleCssBundlePlugin } from '../base/vite/singleCssBundlePlugin.mjs'

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
      '@boardlab/resources': path.resolve(
        __dirname,
        '../resources/src/index.tsx'
      ),
    },
  },
  build: {
    outDir: 'out',
    sourcemap: true,
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
})
