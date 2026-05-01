import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['test/**/*.test.{js,ts}', 'scripts/__tests__/**/*.test.ts'],
      exclude: ['node_modules', 'gen', 'hugo', 'test/hybrid/**', 'test/smoke/**'],
      env: { NO_TELEMETRY: 'true' }
    }
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'hybrid',
      include: ['test/hybrid/**/*.test.{js,ts}'],
      testTimeout: 60000
    }
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'smoke',
      include: ['test/smoke/**/*.test.{js,ts}'],
      testTimeout: 30000
    }
  }
]);
