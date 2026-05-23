import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: '/analytics-ui/',
  plugins: [vue()],
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
