// test/unit/check-ui5-single-copy.test.js
//
// Verifies the manifest-scoped ui5 Theme-copy guard (#1777).
//
// KEY DESIGN: the guard must use hugo/static/js/.vite/manifest.json to scope
// its search to chunks reachable from the four ui5-* entries only. Stale
// chunks retained by `retain:assets` from prior builds may sit on disk with
// the same Theme marker but must NOT be counted — a disk-wide scan would
// false-positive on every retain deploy.
//
// Controller Ruling 3 overrides the brief's original `countThemeCopies(dir)`
// which did a blind recursive scan. The function exported here is
// `countThemeCopiesFromManifest(jsDir)`.

import { describe, it, expect } from 'vitest';
import { countThemeCopiesFromManifest } from '../../scripts/check-ui5-single-copy.cjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Theme marker used by the guard — a DOM attribute literal from
// @ui5/webcomponents-base/dist/config/ThemeRoot.js that survives minification.
const MARKER = 'sap-ui-webcomponents-theme';

/**
 * Build a minimal fake hugo/static/js/ directory layout for testing.
 *
 * @param {Record<string, string>} files  map of relative path → file contents
 * @param {object}                 manifest  the .vite/manifest.json object
 */
function fixture(files, manifest) {
  const d = mkdtempSync(join(tmpdir(), 'ui5copy-'));
  mkdirSync(join(d, '.vite'), { recursive: true });
  mkdirSync(join(d, 'chunks'), { recursive: true });
  writeFileSync(join(d, '.vite', 'manifest.json'), JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(join(d, rel), body);
  }
  return d;
}

/**
 * A minimal manifest that wires four ui5-* entries through a shared vendor chunk.
 * Accepts the filenames so each test can vary whether the marker appears in one
 * or two places.
 */
function makeManifest({ vendorChunk = 'chunks/ui5-vendor-LIVE.js', extraChunk = null } = {}) {
  const vendorKey = '_ui5-vendor-LIVE.js';
  const m = {
    'src/ui5/ui5-core.ts': {
      file: 'ui5-core-a1b2.js', name: 'ui5-core', isEntry: true,
      imports: [vendorKey],
    },
    'src/ui5/ui5-tutorial.ts': {
      file: 'ui5-tutorial-c3d4.js', name: 'ui5-tutorial', isEntry: true,
      imports: [vendorKey],
    },
    'src/ui5/ui5-me.ts': {
      file: 'ui5-me-e5f6.js', name: 'ui5-me', isEntry: true,
      imports: [vendorKey],
    },
    'src/ui5/ui5-illustrations.ts': {
      file: 'ui5-illustrations-g7h8.js', name: 'ui5-illustrations', isEntry: true,
      imports: extraChunk ? [vendorKey, '_extra-chunk.js'] : [vendorKey],
    },
    [vendorKey]: { file: vendorChunk, name: 'ui5-vendor' },
  };
  if (extraChunk) {
    m['_extra-chunk.js'] = { file: extraChunk, name: 'extra-chunk' };
  }
  return m;
}

describe('countThemeCopiesFromManifest', () => {
  it('returns 1 when the Theme marker lives in exactly one shared vendor chunk', () => {
    const manifest = makeManifest();
    const d = fixture({
      'ui5-core-a1b2.js': '/* ui5-core entry, no theme */',
      'ui5-tutorial-c3d4.js': '/* ui5-tutorial entry, no theme */',
      'ui5-me-e5f6.js': '/* ui5-me entry, no theme */',
      'ui5-illustrations-g7h8.js': '/* ui5-illustrations entry, no theme */',
      'chunks/ui5-vendor-LIVE.js': `/* ${MARKER} appears here */var fn=setTheme;`,
    }, manifest);
    expect(countThemeCopiesFromManifest(d)).toBe(1);
  });

  it('returns 2 when the Theme marker is duplicated across two reachable chunks', () => {
    const manifest = makeManifest({ extraChunk: 'chunks/extra-chunk.js' });
    const d = fixture({
      'ui5-core-a1b2.js': '/* no theme */',
      'ui5-tutorial-c3d4.js': '/* no theme */',
      'ui5-me-e5f6.js': '/* no theme */',
      'ui5-illustrations-g7h8.js': '/* no theme */',
      'chunks/ui5-vendor-LIVE.js': `/* ${MARKER} lives here */`,
      'chunks/extra-chunk.js': `/* ${MARKER} duplicate — split vendor */`,
    }, manifest);
    expect(countThemeCopiesFromManifest(d)).toBe(2);
  });

  it('ignores stale chunks on disk that are NOT reachable from the manifest (retain:assets proof)', () => {
    // This is the central regression test: chunks/ui5-vendor-STALE.js sits on
    // disk with the marker (left over from a previous deploy's retain step) but
    // is NOT referenced by the current manifest. A disk-wide scan would return
    // 2; the manifest-scoped guard must return 1.
    const manifest = makeManifest(); // manifest only knows LIVE, not STALE
    const d = fixture({
      'ui5-core-a1b2.js': '/* no theme */',
      'ui5-tutorial-c3d4.js': '/* no theme */',
      'ui5-me-e5f6.js': '/* no theme */',
      'ui5-illustrations-g7h8.js': '/* no theme */',
      'chunks/ui5-vendor-LIVE.js': `/* ${MARKER} — current build */`,
      // STALE chunk: on disk, has the marker, but NOT in the manifest
      'chunks/ui5-vendor-STALE.js': `/* ${MARKER} — old build retained on disk */`,
    }, manifest);
    // Must be 1 (only LIVE), not 2 (LIVE + STALE)
    expect(countThemeCopiesFromManifest(d)).toBe(1);
  });

  it('returns 0 when no reachable chunk contains the Theme marker', () => {
    const manifest = makeManifest();
    const d = fixture({
      'ui5-core-a1b2.js': '/* no theme */',
      'ui5-tutorial-c3d4.js': '/* no theme */',
      'ui5-me-e5f6.js': '/* no theme */',
      'ui5-illustrations-g7h8.js': '/* no theme */',
      'chunks/ui5-vendor-LIVE.js': '/* no theme in this chunk either */',
    }, manifest);
    expect(countThemeCopiesFromManifest(d)).toBe(0);
  });

  it('throws a clear error when the manifest is missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'ui5copy-nomfst-'));
    // No manifest written → should throw
    expect(() => countThemeCopiesFromManifest(d)).toThrow(/manifest/i);
  });
});
