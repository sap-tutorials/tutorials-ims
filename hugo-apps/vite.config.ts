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
const MAX_PUZZLE_GZIP = 30 * 1024;
const MAX_ADVOCATE_PROFILE_GZIP = 25 * 1024;
const MAX_RELATED_GRAPH_GZIP = 12 * 1024;
const MAX_TOPICS_MAP_GZIP = 150 * 1024;
const MAX_ALERTS_GZIP = 12 * 1024;
const MAX_HOMEPAGE_EXPLAINERS_GZIP = 12 * 1024;
const MAX_HOMEPAGE_PERSONALIZER_GZIP = 12 * 1024;
const MAX_PETOBERFEST_GZIP = 35 * 1024;

function codeCheckBudget() {
  return {
    name: 'code-check-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'code-check');
      if (!chunk) return;
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
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'validation');
      if (!chunk) return;
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
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'tutorial-branches');
      if (!chunk) return;
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
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'advocates');
      if (!chunk) return;
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

function puzzleBudget() {
  return {
    name: 'puzzle-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'puzzle');
      if (!chunk) return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_PUZZLE_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`puzzle.js is ${gz} bytes gzipped (> ${MAX_PUZZLE_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`puzzle.js: ${gz} bytes gzipped (budget ${MAX_PUZZLE_GZIP}).`);
      }
    }
  };
}

function advocateProfileBudget() {
  return {
    name: 'advocate-profile-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'advocate-profile');
      if (!chunk) return;
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
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'tutorial-prefs');
      if (!chunk) return;
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
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'alerts');
      if (!chunk) return;
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

function homepagePersonalizerBudget() {
  return {
    name: 'homepage-personalizer-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'homepage-personalizer');
      if (!chunk) return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_HOMEPAGE_PERSONALIZER_GZIP) {
        // @ts-ignore
        this.error(`homepage-personalizer.js is ${gz} bytes gzipped (> ${MAX_HOMEPAGE_PERSONALIZER_GZIP}).`);
      } else {
        // @ts-ignore
        this.warn(`homepage-personalizer.js: ${gz} bytes gzipped (budget ${MAX_HOMEPAGE_PERSONALIZER_GZIP}).`);
      }
    },
  };
}

function homepageExplainersBudget() {
  return {
    name: 'homepage-explainers-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'homepage-explainers');
      if (!chunk) return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_HOMEPAGE_EXPLAINERS_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`homepage-explainers.js is ${gz} bytes gzipped (> ${MAX_HOMEPAGE_EXPLAINERS_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`homepage-explainers.js: ${gz} bytes gzipped (budget ${MAX_HOMEPAGE_EXPLAINERS_GZIP}).`);
      }
    }
  };
}

function relatedGraphBudget() {
  return {
    name: 'related-graph-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'related-graph');
      if (!chunk) return;
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

function topicsMapBudget() {
  return {
    name: 'topics-map-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'topics-map');
      if (!chunk) return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_TOPICS_MAP_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`topics-map.js is ${gz} bytes gzipped (> ${MAX_TOPICS_MAP_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`topics-map.js: ${gz} bytes gzipped (budget ${MAX_TOPICS_MAP_GZIP}).`);
      }
    }
  };
}

function petoberfestBudget() {
  return {
    name: 'petoberfest-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = Object.values(bundle).find((c: any) => c.type === 'chunk' && c.name === 'petoberfest');
      if (!chunk) return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_PETOBERFEST_GZIP) {
        // @ts-ignore
        this.error(`petoberfest.js is ${gz} bytes gzipped (> ${MAX_PETOBERFEST_GZIP}).`);
      } else {
        // @ts-ignore
        this.warn(`petoberfest.js: ${gz} bytes gzipped (budget ${MAX_PETOBERFEST_GZIP}).`);
      }
    }
  };
}

export default defineConfig({
  plugins: [vue(), cssInjectedByJsPlugin({ relativeCSSInjection: true }), tutorialPrefsBudget(), codeCheckBudget(), validationBudget(), tutorialBranchesBudget(), advocatesBudget(), puzzleBudget(), relatedGraphBudget(), alertsBudget(), homepageExplainersBudget(), advocateProfileBudget(), homepagePersonalizerBudget(), petoberfestBudget(), topicsMapBudget()],
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
    // Emit hugo/static/js/.vite/manifest.json so the post-Vite build step
    // (scripts/build-island-manifest.cjs, run in postbuild:apps) can map each
    // entry name to its content-hashed filename for Hugo to resolve.
    manifest: true,
    outDir: '../hugo/static/js',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        navigator: resolve(__dirname, 'src/navigator/main.ts'),
        'app-space': resolve(__dirname, 'src/app-space/main.ts'),
        devtoberfest: resolve(__dirname, 'src/devtoberfest/main.ts'),
        gameboard: resolve(__dirname, 'src/gameboard/main.ts'),
        arcade: resolve(__dirname, 'src/arcade/main.ts'),
        selfie: resolve(__dirname, 'src/selfie/main.ts'),
        embed: resolve(__dirname, 'src/embed/main.ts'),
        'event-display': resolve(__dirname, 'src/event-display/main.ts'),
        'nav-dropdown': resolve(__dirname, 'src/nav-dropdown/main.ts'),
        'scanner-vue': resolve(__dirname, 'src/scanner-vue/main.ts'),
        'tutorial-feedback': resolve(__dirname, 'src/tutorial-feedback/main.ts'),
        'tutorial-pip': resolve(__dirname, 'src/tutorial-pip/main.ts'),
        'tutorial-pip-launcher': resolve(__dirname, 'src/tutorial-pip-launcher/main.ts'),
        'tutorial-rating': resolve(__dirname, 'src/tutorial-rating/main.ts'),
        'tutorial-breadcrumbs': resolve(__dirname, 'src/tutorial-breadcrumbs/main.ts'),
        'tutorial-group-nav': resolve(__dirname, 'src/tutorial-group-nav/main.ts'),
        'cmd-palette': resolve(__dirname, 'src/cmd-palette/main.ts'),
        me: resolve(__dirname, 'src/me/main.ts'),
        tokens: resolve(__dirname, 'src/tokens/main.ts'),
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
        'concepts-filter': resolve(__dirname, 'src/concepts-filter/main.ts'),
        'topics-map': resolve(__dirname, 'src/topics-map/main.ts'),
        'homepage-explainers': resolve(__dirname, 'src/homepage-explainers/index.ts'),
        'homepage-personalizer': resolve(__dirname, 'src/homepage-personalizer/index.ts'),
        'featured-topics-carousel': resolve(__dirname, 'src/featured-topics-carousel/main.ts'),
        'topic-clusters-band': resolve(__dirname, 'src/topic-clusters-band/main.ts'),
        'homepage-events-band': resolve(__dirname, 'src/homepage-events-band/main.ts'),
        puzzle: resolve(__dirname, 'src/puzzle/main.ts'),
        petoberfest: resolve(__dirname, 'src/petoberfest/main.ts'),
        'devtoberfest-schedule': resolve(__dirname, 'src/devtoberfest-schedule/main.ts'),
        'devtoberfest-sessions-grid': resolve(__dirname, 'src/devtoberfest-sessions-grid/main.ts'),
        'devtoberfest-sessions-calendar': resolve(__dirname, 'src/devtoberfest-sessions-calendar/main.ts'),
        'devtoberfest-rules': resolve(__dirname, 'src/devtoberfest-rules/main.ts'),
        'devtoberfest-faq': resolve(__dirname, 'src/devtoberfest-faq/main.ts'),
        'ui5-core': resolve(__dirname, 'src/ui5/ui5-core.ts'),
        'ui5-tutorial': resolve(__dirname, 'src/ui5/ui5-tutorial.ts'),
        'ui5-me': resolve(__dirname, 'src/ui5/ui5-me.ts'),
        'ui5-illustrations': resolve(__dirname, 'src/ui5/ui5-illustrations.ts'),
      },
      output: {
        // Content-hash entry bundles so a changed bundle gets a new URL the
        // CDN edge (Akamai on PROD) has never cached — fresh HTML can no
        // longer pair with a stale cached bundle (#1604, the JS analog of the
        // 2026-08-10 giant-logo CSS incident, PR #1601/#1603).
        //
        // All entry bundles are content-hashed. The CAP runtime renderers
        // (srv/lib/catalog-renderer.js, srv/lib/concept-list-page.js) that
        // inline <script> tags for nav-dropdown and concepts-filter now read
        // the hashed path from srv/lib/island-manifest.json (written by
        // scripts/build-island-manifest.cjs alongside hugo/data/island_manifest.json)
        // with a fail-open fallback to the bare path for local cds watch.
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        manualChunks(id) {
          // Force the UI5 base (the Theme singleton) into ONE shared chunk so
          // every ui5-* entry references the same Theme instance. Single-copy
          // invariant — see spec. Do NOT widen this to all of @ui5 (that would
          // pull every component into the shared chunk, defeating the split).
          if (id.includes('@ui5/webcomponents-base')) return 'ui5-vendor';
        },
      },
    },
  },
})
