// test/unit/page-fallback.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPageFallback } from '../../srv/lib/page-fallback.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'srv', 'page-fallback');

describe('page-fallback', () => {
  beforeAll(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'page-index.html'), '<!doctype html><title>Home fallback</title>');
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
