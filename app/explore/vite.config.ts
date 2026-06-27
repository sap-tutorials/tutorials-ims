import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { gzipSync } from 'node:zlib'

const MAX_EXPLORE_GZIP = 150 * 1024 // 150KB budget — Sigma + graphology + ForceAtlas2 baseline ~65KB

function exploreBudget() {
  return {
    name: 'explore-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      let totalGzip = 0
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && name.endsWith('.js')) {
          totalGzip += gzipSync(chunk.code).length
        }
      }
      if (totalGzip > MAX_EXPLORE_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`explore bundle total is ${totalGzip} gzip bytes (> ${MAX_EXPLORE_GZIP}).`)
      } else {
        // @ts-ignore
        this.warn(`explore bundle: ${totalGzip} gzip bytes (budget ${MAX_EXPLORE_GZIP}).`)
      }
    }
  }
}

export default defineConfig({
  base: '/explore-ui/',
  plugins: [vue(), exploreBudget()],
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
})
