import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const OUT = resolve(__dirname, '../../../../hugo/static/js');
describe('ui5-me Vite entry', () => {
  it('emits a hashed ui5-me entry (run after build)', () => {
    expect(readdirSync(OUT).some(f => /^ui5-me-[A-Za-z0-9_-]{8,}\.js$/.test(f))).toBe(true);
  });
});
