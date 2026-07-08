import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';

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
          environment: 'node',
          include: ['test/**/*.test.{js,ts}', 'scripts/__tests__/**/*.test.ts', 'scripts/**/__tests__/**/*.test.ts', 'srv/**/__tests__/**/*.test.{js,ts}', 'app/analytics-explorer/src/**/__tests__/**/*.test.ts', 'app/explore/src/**/__tests__/**/*.test.ts', 'hugo-apps/src/**/*.{test,spec}.{js,ts}'],
          exclude: ['node_modules', 'gen', 'hugo', 'test/hybrid/**', 'test/hybrid-qa/**', 'test/smoke/**'],
          // testTimeout raised to 30s because the `test/unit/check-*.test.ts`
          // cluster spawns `npx tsx <script>` per-`it` — cold TSX + child process
          // startup on Windows can breach the vitest default (5s). Project
          // configs don't inherit the outer `test.testTimeout`; the value must
          // live here.
          testTimeout: 30_000,
          hookTimeout: 60000,
          env: { NO_TELEMETRY: 'true' }
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
          testTimeout: 30000
        }
      },
      {
        test: {
          name: 'a11y',
          include: ['test/a11y/**/*.test.{js,ts}'],
          testTimeout: 60000
        }
      }
    ]
  }
});
