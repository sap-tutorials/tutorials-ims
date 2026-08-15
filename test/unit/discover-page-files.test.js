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
import { discoverPageFiles, discoverAuthorPages, isAuthorKey, discoverAdvocatePages, isAdvocateKey, IN_SCOPE_PAGES } from '../../srv/lib/page-key-map.js';

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

// #1659 Phase C — dynamic author-page discovery (unbounded logins, NOT the
// fixed allow-list).
describe('discoverAuthorPages', () => {
  let authorsRoot;
  beforeAll(() => {
    authorsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-authors-'));
    const mk = (login) => {
      const dir = path.join(authorsRoot, 'authors', login);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
    };
    mk('mervey45');
    mk('sap-hoangvu');
    // A mixed-case dir name (some filesystems allow it) → key lowercased.
    mk('CamelUser');
    // Non-slug dirs that must be skipped.
    fs.mkdirSync(path.join(authorsRoot, 'authors', '_index'), { recursive: true });
    fs.writeFileSync(path.join(authorsRoot, 'authors', '_index', 'index.html'), '');
  });
  afterAll(() => fs.rmSync(authorsRoot, { recursive: true, force: true }));

  it('returns an empty map when there is no authors dir', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-authors-'));
    expect(discoverAuthorPages(empty).size).toBe(0);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('maps authors/<login>/index.html → author-<login> (lowercased), skipping non-slug dirs', () => {
    const result = discoverAuthorPages(authorsRoot);
    expect(result.has('author-mervey45')).toBe(true);
    expect(result.has('author-sap-hoangvu')).toBe(true);
    expect(result.has('author-cameluser')).toBe(true); // lowercased
    expect(result.get('author-mervey45')).toBe(path.join(authorsRoot, 'authors', 'mervey45', 'index.html'));
    // _index (underscore) is not slug-shaped → skipped.
    expect([...result.keys()].some((k) => k.includes('_index'))).toBe(false);
    // Every key is an author key.
    for (const k of result.keys()) expect(isAuthorKey(k)).toBe(true);
  });
});

// #1659 Phase C.2a — per-advocate detail discovery (subdirs of
// developer-advocates/; the top-level index.html is the separate index page).
describe('discoverAdvocatePages', () => {
  let advRoot;
  beforeAll(() => {
    advRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-adv-'));
    const mk = (slug) => {
      const dir = path.join(advRoot, 'developer-advocates', slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
    };
    mk('dj-adams');
    mk('antonio-maradiaga');
    // The index page is a top-level FILE, not a dir → must be ignored.
    fs.writeFileSync(path.join(advRoot, 'developer-advocates', 'index.html'), '<!doctype html>index');
  });
  afterAll(() => fs.rmSync(advRoot, { recursive: true, force: true }));

  it('returns an empty map when there is no developer-advocates dir', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-adv-'));
    expect(discoverAdvocatePages(empty).size).toBe(0);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('maps developer-advocates/<slug>/index.html → advocate-<slug>, ignoring the top-level index file', () => {
    const result = discoverAdvocatePages(advRoot);
    expect(result.has('advocate-dj-adams')).toBe(true);
    expect(result.has('advocate-antonio-maradiaga')).toBe(true);
    expect(result.get('advocate-dj-adams')).toBe(path.join(advRoot, 'developer-advocates', 'dj-adams', 'index.html'));
    expect(result.size).toBe(2); // top-level index.html (a file) is not counted
    for (const k of result.keys()) expect(isAdvocateKey(k)).toBe(true);
  });
});
