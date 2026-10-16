import { describe, it, expect } from 'vitest';
import { parseSlugs } from '../../scripts/backfill-images.ts';

describe('parseSlugs (#2805)', () => {
  it('splits a comma list from --slug', () => {
    expect(parseSlugs(['--slug', 'a,b,c'])).toEqual(['a', 'b', 'c']);
  });
  it('reads --slugs the same way', () => {
    expect(parseSlugs(['--slugs', 'a,b'])).toEqual(['a', 'b']);
  });
  it('unions --slug and --slugs, de-duping and preserving order', () => {
    expect(parseSlugs(['--slug', 'a', '--slugs', 'b,a,c'])).toEqual(['a', 'b', 'c']);
  });
  it('trims whitespace and drops blanks', () => {
    expect(parseSlugs(['--slug', ' a , , b '])).toEqual(['a', 'b']);
  });
  it('returns [] when neither flag is present', () => {
    expect(parseSlugs([])).toEqual([]);
  });
  it('returns [] for an empty value (whole-catalog default)', () => {
    expect(parseSlugs(['--slug', ''])).toEqual([]);
  });
});

import { collectImageUrls } from '../../scripts/backfill-images.ts';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bf-'));
  const mk = (slug, u) => {
    mkdirSync(join(root, 'tutorials', slug), { recursive: true });
    writeFileSync(join(root, 'tutorials', slug, 'index.html'),
      `<img src="/img-cdn?u=${encodeURIComponent(u)}">`);
  };
  mk('slug-a', 'https://raw.githubusercontent.com/x/a.png');
  mk('slug-b', 'https://raw.githubusercontent.com/x/b.png');
  mk('slug-c', 'https://raw.githubusercontent.com/x/c.png');
  return root;
}

describe('collectImageUrls multi-slug (#2805)', () => {
  it('scans only the requested slugs when given an array', () => {
    const m = collectImageUrls(fixture(), ['slug-a', 'slug-b']);
    expect([...m.values()].sort()).toEqual(['slug-a', 'slug-b']);
  });
  it('scans the whole dir when slugs is empty/undefined', () => {
    expect(collectImageUrls(fixture(), []).size).toBe(3);
    expect(collectImageUrls(fixture()).size).toBe(3);
  });
  it('yields nothing (no throw) for an unknown slug — best-effort warm', () => {
    const m = collectImageUrls(fixture(), ['does-not-exist']);
    expect(m.size).toBe(0);
  });
});
