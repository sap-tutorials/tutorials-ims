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
      '/ims-proxy': {
        target: 'https://imsprod-approuter.cfapps.us30.hana.ondemand.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ims-proxy/, ''),
        secure: true,
        ws: true,
      },
    },
  },
})
