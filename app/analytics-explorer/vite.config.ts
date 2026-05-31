import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  base: '/analytics-ui/',
  plugins: [vue()],
  resolve: {
    alias: {
      // Phase 2: lets the chip builder import the isomorphic Phase 1 modules
      // (query-spec-validator.mjs, spec-to-sql.mjs) directly from srv/lib.
      // Pure-ESM .mjs files; Vite consumes them with no transformation.
      '@srv-lib': fileURLToPath(new URL('../../srv/lib', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('monaco-editor') || id.includes('monaco-sql-languages')) return 'monaco'
            if (id.includes('echarts')) return 'echarts'
            if (id.includes('@ui5/webcomponents')) return 'ui5'
            if (id.includes('vue-router') || id.includes('/vue/') || id.includes('/@vue/')) return 'vendor'
          }
          return undefined
        },
      },
    },
  },
  server: {
    proxy: {
      '/admin/analytics': {
        target: 'http://localhost:4004',
        changeOrigin: true,
      },
    },
  },
})
