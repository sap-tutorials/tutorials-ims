import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import { resolve } from 'path'
import { gzipSync } from 'node:zlib'

const MAX_TUTORIAL_PREFS_GZIP = 8 * 1024;

function tutorialPrefsBudget() {
  return {
    name: 'tutorial-prefs-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['tutorial-prefs.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_TUTORIAL_PREFS_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`tutorial-prefs.js is ${gz} bytes gzipped (> ${MAX_TUTORIAL_PREFS_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`tutorial-prefs.js: ${gz} bytes gzipped (budget ${MAX_TUTORIAL_PREFS_GZIP}).`);
      }
    }
  };
}

export default defineConfig({
  plugins: [vue(), cssInjectedByJsPlugin({ relativeCSSInjection: true }), tutorialPrefsBudget()],
  // Approuter serves these bundles at /js/. Without `base`, Vite emits
  // dynamic-import paths as `./chunks/x.js` which the browser resolves
  // against the *document URL* (e.g. `/` → `/chunks/x.js` → 404). Setting
  // base makes those imports absolute, e.g. `/js/chunks/x.js`. Currently
  // only tutorial-prefs.js code-splits — but anything that adds dynamic
  // imports later will silently break in prod without this. Issue: eye/hand
  // tracking 404s on chunks/* 2026-05-29.
  base: '/js/',
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
        'scanner-vue': resolve(__dirname, 'src/scanner-vue/main.ts'),
        'tutorial-feedback': resolve(__dirname, 'src/tutorial-feedback/main.ts'),
        'tutorial-pip': resolve(__dirname, 'src/tutorial-pip/main.ts'),
        'tutorial-pip-launcher': resolve(__dirname, 'src/tutorial-pip-launcher/main.ts'),
        'tutorial-rating': resolve(__dirname, 'src/tutorial-rating/main.ts'),
        'tutorial-breadcrumbs': resolve(__dirname, 'src/tutorial-breadcrumbs/main.ts'),
        'cmd-palette': resolve(__dirname, 'src/cmd-palette/main.ts'),
        me: resolve(__dirname, 'src/me/main.ts'),
        'tutorial-prefs': resolve(__dirname, 'src/tutorial-prefs/main.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
})
