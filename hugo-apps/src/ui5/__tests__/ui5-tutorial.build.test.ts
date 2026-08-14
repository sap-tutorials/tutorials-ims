// hugo-apps/src/ui5/__tests__/ui5-tutorial.build.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const OUT = resolve(__dirname, '../../../../hugo/static/js');
describe('ui5-tutorial Vite entry', () => {
  it('emits a hashed ui5-tutorial entry (run after build)', () => {
    const files = readdirSync(OUT);
    expect(files.some(f => /^ui5-tutorial-[A-Za-z0-9_-]{8,}\.js$/.test(f))).toBe(true);
  });
});
