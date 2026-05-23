import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: '/analytics-ui/',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router'],
          echarts: ['echarts'],
          ui5: ['@ui5/webcomponents', '@ui5/webcomponents-fiori'],
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
