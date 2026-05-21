import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue(), cssInjectedByJsPlugin({ relativeCSSInjection: true })],
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
        'mini-navigator': resolve(__dirname, 'src/mini-navigator/main.ts'),
        'scanner-vue': resolve(__dirname, 'src/scanner-vue/main.ts'),
        'tutorial-feedback': resolve(__dirname, 'src/tutorial-feedback/main.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
})
