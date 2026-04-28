import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: '../hugo/static/js',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        navigator: resolve(__dirname, 'src/navigator/main.ts'),
        'app-space': resolve(__dirname, 'src/app-space/main.ts'),
        'event-display': resolve(__dirname, 'src/event-display/main.ts'),
        'nav-dropdown': resolve(__dirname, 'src/nav-dropdown/main.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
})
