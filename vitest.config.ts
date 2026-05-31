import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    exclude: ['node_modules', 'gen', 'hugo'],
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/**/*.test.{js,ts}', 'scripts/__tests__/**/*.test.ts', 'srv/**/__tests__/**/*.test.{js,ts}', 'app/analytics-explorer/src/**/__tests__/**/*.test.ts', 'hugo-apps/src/**/*.test.{js,ts}'],
          exclude: ['node_modules', 'gen', 'hugo', 'test/hybrid/**', 'test/hybrid-qa/**', 'test/smoke/**'],
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
          },
        },
      },
      {
        test: {
          name: 'hybrid',
          include: ['test/hybrid/**/*.test.{js,ts}'],
          testTimeout: 60000
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
