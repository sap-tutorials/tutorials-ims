import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    include: ['test/**/*.test.{js,ts}', 'scripts/__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'gen', 'hugo']
  }
});
