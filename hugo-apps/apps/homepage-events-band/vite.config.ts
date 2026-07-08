import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue(), cssInjectedByJsPlugin({ relativeCSSInjection: true })],
  base: '/js/',
  build: {
    outDir: '../../../hugo/static/js',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        'homepage-events-band': resolve(__dirname, 'src/main.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.some((n: string) => n.endsWith('.css'))) {
            return 'homepage-events-band.css';
          }
          return '[name][extname]';
        },
      },
    },
  },
})
