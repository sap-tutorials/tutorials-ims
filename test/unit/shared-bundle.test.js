import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outFile = 'srv/lib/_shared/core.bundle.mjs';

describe('shared bundle (Task 4)', () => {
  it('bundle script produces a self-contained ESM core bundle', () => {
    execFileSync('node', ['scripts/bundle-shared.cjs'], { stdio: 'pipe' });
    expect(fs.existsSync(outFile)).toBe(true);
  });

  it('bundle exports getNextLegacyId and resetCounters', async () => {
    // Ensure bundle exists
    if (!fs.existsSync(outFile)) {
      execFileSync('node', ['scripts/bundle-shared.cjs'], { stdio: 'pipe' });
    }
    const absPath = path.resolve(outFile);
    const mod = await import(absPath);
    expect(typeof mod.getNextLegacyId).toBe('function');
    expect(typeof mod.resetCounters).toBe('function');
  });

  it('legacy-id shim resolves both named exports', async () => {
    const mod = await import('../../srv/lib/legacy-id.js');
    expect(typeof mod.getNextLegacyId).toBe('function');
    expect(typeof mod.resetCounters).toBe('function');
  });
});
