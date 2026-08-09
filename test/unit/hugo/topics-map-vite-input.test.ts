import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
describe('topics-map island is registered', () => {
  it('has a rollup input entry', () => {
    const cfg = readFileSync('hugo-apps/vite.config.ts', 'utf-8');
    expect(cfg).toMatch(/['"]topics-map['"]\s*:\s*resolve\(__dirname,\s*['"]src\/topics-map\/main\.ts['"]\)/);
  });
});
