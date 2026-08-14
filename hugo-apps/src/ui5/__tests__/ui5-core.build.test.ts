// hugo-apps/src/ui5/__tests__/ui5-core.build.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(__dirname, '../../../../hugo/static/js');

describe('ui5-core Vite entry', () => {
  beforeAll(() => {
    execSync('npm run build', { cwd: resolve(__dirname, '../../..'), stdio: 'inherit' });
  }, 240000);

  it('emits a hashed ui5-core entry', () => {
    const files = readdirSync(OUT);
    expect(files.some(f => /^ui5-core-[A-Za-z0-9_-]{8,}\.js$/.test(f))).toBe(true);
  });

  it('emits exactly one shared ui5-vendor chunk', () => {
    const files = readdirSync(OUT + '/chunks').filter(f => /^ui5-vendor-/.test(f));
    expect(files.length).toBe(1);
  });
});
