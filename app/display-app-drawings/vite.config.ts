import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/drawings-ui/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/rest': {
        target: 'http://localhost:4004',
        changeOrigin: true,
      },
      '/drawings': {
        target: 'http://localhost:4004',
        changeOrigin: true,
      },
    },
  },
})
