// test/unit/scripts/seed-community-events.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scriptPath = join(process.cwd(), 'scripts', 'seed-community-events.cjs');

describe('scripts/seed-community-events.cjs', () => {
  it('exists and is executable-shaped', () => {
    const src = readFileSync(scriptPath, 'utf8');
    expect(src).toContain('runFetchCommunityEvents');
    expect(src).toContain('--commit');
    expect(src).toContain('--dry-run');
    expect(src).toContain('sinceIsoOverride');
    expect(src).toContain('manualTrigger');
  });

  it('exits 1 on summary.errors > 0 (shape check via source)', () => {
    const src = readFileSync(scriptPath, 'utf8');
    expect(src).toMatch(/summary\.errors[\s>0!=]+.*process\.exit\(1\)/s);
  });
});
