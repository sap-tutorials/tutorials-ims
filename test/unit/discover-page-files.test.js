// test/unit/discover-page-files.test.js
//
// Unit tests for discoverPageFiles() — the publish-side helper that maps
// in-scope page keys to absolute file paths under a Hugo output dir.
// This covers the publish-pipeline integration that page-publish-serve.test.js
// (a HANA serve-path guard) intentionally does NOT exercise.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverPageFiles, IN_SCOPE_PAGES } from '../../srv/lib/page-key-map.js';

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-page-files-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('discoverPageFiles', () => {
  it('returns an empty map when no in-scope files exist under hugoDir', () => {
    const result = discoverPageFiles(tmpDir);
    expect(result.size).toBe(0);
  });

  it('maps page keys to absolute paths for files that exist', () => {
    // Create two in-scope page files: index.html and sitemap.xml
    const indexSrc = IN_SCOPE_PAGES.find((p) => p.key === 'page-index');
    const sitemapSrc = IN_SCOPE_PAGES.find((p) => p.key === 'page-sitemap.xml');

    fs.writeFileSync(path.join(tmpDir, indexSrc.file), '<!doctype html>');

    const sitemapDir = path.join(tmpDir, path.dirname(sitemapSrc.file));
    fs.mkdirSync(sitemapDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, sitemapSrc.file), '<?xml version="1.0"?>');

    const result = discoverPageFiles(tmpDir);

    expect(result.has('page-index')).toBe(true);
    expect(result.get('page-index')).toBe(path.join(tmpDir, indexSrc.file));

    expect(result.has('page-sitemap.xml')).toBe(true);
    expect(result.get('page-sitemap.xml')).toBe(path.join(tmpDir, sitemapSrc.file));

    // Files not yet written should be absent from the map.
    expect(result.has('page-browse')).toBe(false);
  });

  it('merging into a combined Map with tutorial entries produces no key collision', () => {
    // Simulate how publish-content.ts merges tutorial slugs and page keys into
    // one Map<string, string> (slug/key → abs path).
    const tutorialEntries = new Map([
      ['abap-basics', '/some/hugo/public/tutorials/abap-basics/index.html'],
      ['cap-intro', '/some/hugo/public/tutorials/cap-intro/index.html'],
    ]);

    const pageEntries = discoverPageFiles(tmpDir); // at least page-index + page-sitemap.xml from above

    const combined = new Map([...tutorialEntries, ...pageEntries]);

    // All tutorial entries survived.
    expect(combined.get('abap-basics')).toBe('/some/hugo/public/tutorials/abap-basics/index.html');
    expect(combined.get('cap-intro')).toBe('/some/hugo/public/tutorials/cap-intro/index.html');

    // Page entries survived alongside tutorial entries.
    expect(combined.has('page-index')).toBe(true);
    expect(combined.has('page-sitemap.xml')).toBe(true);

    // No key starts with both 'page-' and a tutorial slug pattern — no collision.
    for (const key of combined.keys()) {
      if (key.startsWith('page-')) {
        expect(tutorialEntries.has(key)).toBe(false);
      }
    }
  });

  it('discovers every in-scope page when all files are present', () => {
    // Write stub files for every entry in IN_SCOPE_PAGES.
    for (const p of IN_SCOPE_PAGES) {
      const abs = path.join(tmpDir, p.file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '');
    }

    const result = discoverPageFiles(tmpDir);

    expect(result.size).toBe(IN_SCOPE_PAGES.length);
    for (const p of IN_SCOPE_PAGES) {
      expect(result.has(p.key)).toBe(true);
      expect(result.get(p.key)).toBe(path.join(tmpDir, p.file));
    }
  });
});
