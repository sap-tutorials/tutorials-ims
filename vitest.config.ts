import { defineConfig } from 'vitest/config';

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
          environment: 'happy-dom',
          include: ['test/**/*.test.{js,ts}', 'scripts/__tests__/**/*.test.ts', 'srv/__tests__/**/*.test.{js,ts}'],
          exclude: ['node_modules', 'gen', 'hugo', 'test/hybrid/**', 'test/smoke/**'],
          env: { NO_TELEMETRY: 'true' }
        }
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
