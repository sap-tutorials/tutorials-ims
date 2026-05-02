import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/display-app/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/ws': {
        target: 'http://localhost:4004',
        changeOrigin: true,
        ws: true,
      },
      '/rest': {
        target: 'http://localhost:4004',
        changeOrigin: true,
      },
    },
  },
})
