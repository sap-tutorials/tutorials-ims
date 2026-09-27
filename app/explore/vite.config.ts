import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { gzipSync } from 'node:zlib'

const MAX_EXPLORE_GZIP = 150 * 1024 // 150KB budget — Sigma + graphology + ForceAtlas2 baseline ~65KB
const MAX_3D_GZIP = 400 * 1024 // 400KB budget for 3d-force-graph lazy chunk

function exploreBudget() {
  return {
    name: 'explore-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      let entryGzip = 0
      let threeGzip = 0

      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && name.endsWith('.js')) {
          const gzipSize = gzipSync(chunk.code).length
          const isEntry = name.startsWith('main-') && name.endsWith('.js')

          // Entry chunk: main-*.js
          if (isEntry) {
            entryGzip += gzipSize
          }

          // 3D chunk: name contains ThreeDGraph or moduleIds contains 3d-force-graph
          // (but NOT entry chunks, which may only reference 3d-force-graph dynamically)
          const isThreeD = !isEntry && (name.includes('ThreeDGraph') || (chunk.moduleIds && chunk.moduleIds.some((id: string) => id.includes('3d-force-graph'))))
          if (isThreeD) {
            threeGzip += gzipSize
          }
        }
      }

      // Check entry chunk budget
      if (entryGzip > MAX_EXPLORE_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`explore entry chunk is ${entryGzip} gzip bytes (> ${MAX_EXPLORE_GZIP}).`)
      }

      // Check 3D chunk budget
      if (threeGzip > MAX_3D_GZIP) {
        // @ts-ignore
        this.error(`explore 3D chunk is ${threeGzip} gzip bytes (> ${MAX_3D_GZIP}).`)
      }

      // Informational: report both budgets
      // @ts-ignore
      this.warn(`explore bundle: entry ${entryGzip} bytes (budget ${MAX_EXPLORE_GZIP}), 3D ${threeGzip} bytes (budget ${MAX_3D_GZIP}).`)
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
