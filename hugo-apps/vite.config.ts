import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import { resolve } from 'path'
import { gzipSync } from 'node:zlib'

const MAX_TUTORIAL_PREFS_GZIP = 8 * 1024;
const MAX_CODE_CHECK_GZIP = 8 * 1024;
const MAX_VALIDATION_GZIP = 8 * 1024;
const MAX_TUTORIAL_BRANCHES_GZIP = 12 * 1024;
const MAX_ADVOCATES_GZIP = 30 * 1024;
const MAX_ADVOCATE_PROFILE_GZIP = 25 * 1024;
const MAX_RELATED_GRAPH_GZIP = 12 * 1024;
const MAX_ALERTS_GZIP = 12 * 1024;

function codeCheckBudget() {
  return {
    name: 'code-check-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['code-check.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_CODE_CHECK_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`code-check.js is ${gz} bytes gzipped (> ${MAX_CODE_CHECK_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`code-check.js: ${gz} bytes gzipped (budget ${MAX_CODE_CHECK_GZIP}).`);
      }
    }
  };
}

function validationBudget() {
  return {
    name: 'validation-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['validation.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_VALIDATION_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`validation.js is ${gz} bytes gzipped (> ${MAX_VALIDATION_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`validation.js: ${gz} bytes gzipped (budget ${MAX_VALIDATION_GZIP}).`);
      }
    }
  };
}

function tutorialBranchesBudget() {
  return {
    name: 'tutorial-branches-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['tutorial-branches.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_TUTORIAL_BRANCHES_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`tutorial-branches.js is ${gz} bytes gzipped (> ${MAX_TUTORIAL_BRANCHES_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`tutorial-branches.js: ${gz} bytes gzipped (budget ${MAX_TUTORIAL_BRANCHES_GZIP}).`);
      }
    }
  };
}

function advocatesBudget() {
  return {
    name: 'advocates-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['advocates.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_ADVOCATES_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`advocates.js is ${gz} bytes gzipped (> ${MAX_ADVOCATES_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`advocates.js: ${gz} bytes gzipped (budget ${MAX_ADVOCATES_GZIP}).`);
      }
    }
  };
}

function advocateProfileBudget() {
  return {
    name: 'advocate-profile-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['advocate-profile.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_ADVOCATE_PROFILE_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`advocate-profile.js is ${gz} bytes gzipped (> ${MAX_ADVOCATE_PROFILE_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`advocate-profile.js: ${gz} bytes gzipped (budget ${MAX_ADVOCATE_PROFILE_GZIP}).`);
      }
    }
  };
}

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

function alertsBudget() {
  return {
    name: 'alerts-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['alerts.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_ALERTS_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`alerts.js is ${gz} bytes gzipped (> ${MAX_ALERTS_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore — Rollup plugin context
        this.warn(`alerts.js: ${gz} bytes gzipped (budget ${MAX_ALERTS_GZIP}).`);
      }
    }
  };
}

function relatedGraphBudget() {
  return {
    name: 'related-graph-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['related-graph.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_RELATED_GRAPH_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`related-graph.js is ${gz} bytes gzipped (> ${MAX_RELATED_GRAPH_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`related-graph.js: ${gz} bytes gzipped (budget ${MAX_RELATED_GRAPH_GZIP}).`);
      }
    }
  };
}

export default defineConfig({
  plugins: [vue(), cssInjectedByJsPlugin({ relativeCSSInjection: true }), tutorialPrefsBudget(), codeCheckBudget(), validationBudget(), tutorialBranchesBudget(), advocatesBudget(), relatedGraphBudget(), alertsBudget(), advocateProfileBudget()],
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
        devtoberfest: resolve(__dirname, 'src/devtoberfest/main.ts'),
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
        'code-check': resolve(__dirname, 'src/code-check/main.ts'),
        browse: resolve(__dirname, 'src/browse/main.ts'),
        'validation': resolve(__dirname, 'src/validation/main.ts'),
        'tutorial-branches': resolve(__dirname, 'src/tutorial-branches/main.ts'),
        // [#251] Renamed from `tutorial` → `tutorial-referred` to avoid a path
        // collision with Hugo's `js.Build` output for `hugo/assets/js/tutorial.ts`,
        // which writes to the same /js/tutorial.js URL and would clobber (or be
        // clobbered by) this Vite entry depending on build order.
        'tutorial-referred': resolve(__dirname, 'src/tutorial-referred/main.ts'),
        advocates: resolve(__dirname, 'src/advocates/main.ts'),
        'advocate-profile': resolve(__dirname, 'src/advocate-profile/main.ts'),
        alerts: resolve(__dirname, 'src/alerts/main.ts'),
        'related-graph': resolve(__dirname, 'src/related-graph/main.ts'),
        'tutorial-reset': resolve(__dirname, 'src/tutorial-reset/main.ts'),
        'preview-banner': resolve(__dirname, 'src/validation/preview-banner.ts'),
        'homepage-bands': resolve(__dirname, 'src/homepage-bands/index.ts'),
        'kg-stats-counter': resolve(__dirname, 'src/kg-stats-counter/main.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
})
