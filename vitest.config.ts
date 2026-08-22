import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';

// Node 24+ (Tom's local runtime is 26.5.0) ships experimental Web Storage
// globals ON by default. Node's native `localStorage` needs
// `--localstorage-file` or it resolves to `undefined`, and — because it's a
// real global — it SHADOWS the one happy-dom installs for
// `@vitest-environment happy-dom` files. Result: every hugo-apps DOM test that
// calls `localStorage.clear()` throws "Cannot read properties of undefined
// (reading 'clear')". `sessionStorage` is in-memory so it survives, which is
// why a test can pass `sessionStorage.clear()` one line above the crash.
// `--no-experimental-webstorage` strips both native globals so happy-dom owns
// them again.
//
// This config module is evaluated in vitest's MAIN process before it forks
// test workers, and forks inherit `process.env`, so appending the flag to
// NODE_OPTIONS here reaches every worker regardless of pool type. We mutate
// process.env programmatically (NOT a shell `NODE_OPTIONS=` export — that
// breaks on Windows cmd, and `poolOptions.forks.execArgv` is silently dropped
// in this multi-project config). Harmless no-op on CI's Node 22, where
// webstorage is off by default and the flag is simply ignored.
const WEBSTORAGE_FLAG = '--no-experimental-webstorage';
if (!(process.env.NODE_OPTIONS ?? '').includes(WEBSTORAGE_FLAG)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${WEBSTORAGE_FLAG}`.trim();
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    exclude: ['node_modules', 'gen', 'hugo'],
    projects: [
      {
        // Vue plugin needed for component tests under app/analytics-explorer/.
        // Cheap when no .vue file is imported, so safe to apply to the whole
        // unit project.
        plugins: [vue()],
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          include: ['test/**/*.test.{js,ts}', 'scripts/__tests__/**/*.test.{js,ts}', 'scripts/**/__tests__/**/*.test.{js,ts}', 'srv/**/__tests__/**/*.test.{js,ts}', 'app/analytics-explorer/src/**/__tests__/**/*.test.ts', 'app/explore/src/**/__tests__/**/*.test.ts', 'hugo-apps/src/**/*.{test,spec}.{js,ts}'],
          // test/e2e/** is the Playwright-driven `e2e` project (below). Its
          // specs launch a real browser against a DEPLOYED approuter and would
          // hang the unit tier (which has no BASE_URL); the broad
          // `test/**/*.test.{js,ts}` include above would otherwise swallow them.
          exclude: ['node_modules', 'gen', 'hugo', 'test/hybrid/**', 'test/hybrid-qa/**', 'test/smoke/**', 'test/e2e/**', 'test/build/**'],
          // testTimeout raised to 30s because the `test/unit/check-*.test.ts`
          // cluster spawns `npx tsx <script>` per-`it` — cold TSX + child process
          // startup on Windows can breach the vitest default (5s). Project
          // configs don't inherit the outer `test.testTimeout`; the value must
          // live here.
          testTimeout: 30_000,
          hookTimeout: 60000,
          // Stamp a stable in-memory cds-caching config for every unit worker
          // via env vars (cds reads `cds_requires_*` natively). This closes
          // the fork-pool boot race (issue #1179 / #1177): several unit files
          // dynamically import a SUT that may `cds.connect.to('caching')` at
          // import time, and the per-file `beforeAll` that set the config
          // could run *after* that connect — leaving an undefined-config
          // window that raced two concurrent boots or stalled (~110s once).
          // Env vars are present before any module loads, so the require entry
          // always exists. Set via env (NOT a setupFiles that imports @sap/cds)
          // because eagerly importing cds installs getter-only SELECT/INSERT/…
          // globals that break tests which assign `globalThis.SELECT = {…}`.
          // Per-file `beforeAll` namespace overrides still work — they narrow
          // an already-valid config. Always `memory` here; the `cds` DB store
          // only activates under [hybrid]/[production], run by the hybrid
          // project, not this one.
          env: {
            NO_TELEMETRY: 'true',
            cds_requires_caching_impl: 'cds-caching',
            cds_requires_caching_namespace: 'unit-default',
            cds_requires_caching_store: 'memory',
          },
        },
        resolve: {
          alias: {
            // Phase 2: same alias as app/analytics-explorer/vite.config.ts so the
            // analytics-explorer SPA's tests can import the isomorphic Phase 1
            // modules. The Vitest unit project does NOT import vite.config.ts, so
            // this alias has to be declared here independently.
            '@srv-lib': fileURLToPath(new URL('./srv/lib', import.meta.url)),
            // Mirror of hugo-apps/vite.config.ts and hugo-apps/tsconfig.json
            // `@shared/*` path. Required by hugo-apps unit tests that mount
            // .vue components which transitively import @shared/Skeleton.vue,
            // @shared/ProgressRing.vue, etc. The unit project doesn't load
            // hugo-apps/vite.config.ts so the alias is redeclared here.
            '@shared': fileURLToPath(new URL('./hugo-apps/src/shared', import.meta.url)),
            // Vite's transform phase resolves @mediapipe/tasks-vision during the
            // parse of eye-tracking.ts (even though import() is dynamic at runtime).
            // Unit tests of computeGazeFrame need this alias to unblock resolution.
            // Scoped to unit project only (not global config).
            '@mediapipe/tasks-vision': fileURLToPath(new URL('./hugo-apps/src/tutorial-prefs/__mocks__/mediapipe.ts', import.meta.url)),
          },
        },
      },
      {
        test: {
          name: 'hybrid',
          include: ['test/hybrid/**/*.test.{js,ts}'],
          testTimeout: 60000,
          // `cds.test('serve')` in hybrid tests boots CAP + HANA in the
          // `beforeAll` hook. Cold boot (with @cap-js/ai `served` hook
          // included, per issue #959 PR 2) can breach vitest's 10s hookTimeout
          // default — measured ~10s locally.
          hookTimeout: 60000
        }
      },
      {
        test: {
          name: 'hybrid-qa',
          include: ['test/hybrid-qa/**/*.test.{js,ts}'],
          setupFiles: ['test/hybrid-qa/_guard.js'],
          pool: 'forks',
          testTimeout: 60_000,
          env: {
            cds_requires_db_kind: 'hana',
            cds_requires_db_credentials_target: 'hana-tutorials-db-qa'
          }
        }
      },
      {
        test: {
          name: 'smoke',
          include: ['test/smoke/**/*.test.{js,ts}'],
          testTimeout: 30000,
          // Several smoke files fetch (and sometimes parse a ~1.5MB page) inside
          // a beforeAll/beforeEach hook. Vitest's DEFAULT hookTimeout is 10s —
          // which the smoke tier previously inherited — and under load, or once
          // fetchWithRetry's backoff adds a few seconds, those hooks breach 10s
          // and fail as "Hook timed out in 10000ms", cascading bogus content-
          // assertion failures. The unit + hybrid tiers already raise this for
          // the same reason; match them at 60s so a slow setup fetch isn't a
          // false red.
          hookTimeout: 60000,
          // Post-deploy readiness gate: poll SRV_URL/health until 200 before any
          // test file runs, so smoke doesn't race the cold start right after
          // `cf deploy`. No-op when SMOKE_SRV_URL is unset (local/unit runs).
          globalSetup: ['test/smoke/_warmup.globalSetup.js'],
          // Smoke hits a LIVE, shared, single-instance (web:1/1) srv/approuter
          // over the network — unlike the unit tier, its subjects are external.
          // Vitest's default fan-out (a worker per CPU, all 80+ files at once)
          // turned the suite into its own load test: the box briefly saturated,
          // 502/503'd, and the failure COUNT swung 9→47→144 run-to-run. Cap the
          // fork pool to 2 concurrent files (low-capped parallel — some speed,
          // well under saturation) and hold each file to 4 concurrent requests.
          // Pairs with fetchWithRetry's 5xx retry (test/smoke/smoke.config.js)
          // and the vitest-level retry below.
          pool: 'forks',
          // Vitest 4: pool sizing is top-level (poolOptions was removed).
          // maxWorkers:2 → at most 2 forked files run concurrently; with
          // maxConcurrency:4 that's ≤8 in-flight requests vs the old unbounded
          // fan-out that OOM-crashed the srv.
          maxWorkers: 2,
          minWorkers: 1,
          maxConcurrency: 4,
          // Safety net over the helper's per-request retry: re-run a failed
          // test ONCE more. Deliberately just 1 (not 2+): the deployed srv can
          // OOM-crash under the suite's own request burst (confirmed heap-limit
          // SIGABRT on the 1-instance box), and each whole-test retry re-issues
          // the requests — too many retries amplify load exactly when the server
          // is already dying (a retry storm). One retry absorbs a lone transient
          // blip without piling on. The real durability comes from the srv-side
          // memory/scale bump, not from retrying harder here.
          retry: 1
        }
      },
      {
        test: {
          name: 'a11y',
          include: ['test/a11y/**/*.test.{js,ts}'],
          testTimeout: 60000
        }
      },
      {
        // Playwright-driven admin-UI smoke tier (#1338, salvaged from #806).
        // Runs post-deploy against a DEPLOYED approuter — every spec self-skips
        // when SMOKE_BASE_URL/PLAYWRIGHT_BASE_URL is absent, so `npm test`
        // (unit tier) and a credential-less local run stay green. Driven by
        // `playwright-core` + `chromium.launch()` inside plain vitest, exactly
        // like the a11y tier above — deliberately NOT `@playwright/test`, to
        // avoid a second test-runner dependency.
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.{js,ts}'],
          pool: 'forks',
          testTimeout: 120000,
          hookTimeout: 60000,
          retry: process.env.CI ? 2 : 0
        }
      }
    ]
  }
});
