// test/unit/page-fallback.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPageFallback } from '../../srv/lib/page-fallback.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'srv', 'page-fallback');
const fixtureFile = path.join(dir, 'page-index.html');

describe('page-fallback', () => {
  let dirExistedBefore = false;

  beforeAll(() => {
    dirExistedBefore = fs.existsSync(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fixtureFile, '<!doctype html><title>Home fallback</title>');
  });

  afterAll(() => {
    // Remove the fixture file this test created.
    if (fs.existsSync(fixtureFile)) fs.unlinkSync(fixtureFile);
    // Remove the dir only if this test created it and it is now empty.
    if (!dirExistedBefore && fs.existsSync(dir)) {
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) fs.rmdirSync(dir);
    }
  });

  it('loads a baked fallback for a page key', () => {
    const fb = loadPageFallback('page-index');
    expect(fb).not.toBeNull();
    expect(String(fb.buffer)).toContain('Home fallback');
    expect(fb.mimeType).toBe('text/html');
  });
  it('returns null when no snapshot exists', () => {
    expect(loadPageFallback('page-topics')).toBeNull();
  });
});
