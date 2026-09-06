import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { gzipSync } from 'node:zlib'

// Mirrors app/explore/vite.config.ts budget check.
// Same 150KB gzip budget — channel-atlas reuses the identical Sigma stack.
const MAX_ATLAS_GZIP = 150 * 1024

function atlasBudget() {
  return {
    name: 'atlas-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      let totalGzip = 0
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && name.endsWith('.js')) {
          totalGzip += gzipSync(chunk.code).length
        }
      }
      if (totalGzip > MAX_ATLAS_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`channel-atlas bundle total is ${totalGzip} gzip bytes (> ${MAX_ATLAS_GZIP}).`)
      } else {
        // @ts-ignore
        this.warn(`channel-atlas bundle: ${totalGzip} gzip bytes (budget ${MAX_ATLAS_GZIP}).`)
      }
    },
  }
}

export default defineConfig({
  base: '/channel-atlas-ui/',
  plugins: [vue(), atlasBudget()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        entryFileNames: 'main-[hash].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    // Dev mode: proxy /build/channel-atlas to local CAP server.
    proxy: {
      '/build/channel-atlas': 'http://localhost:4004',
    },
  },
})
