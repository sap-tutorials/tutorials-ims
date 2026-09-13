import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectHashedFiles, main } from '../../scripts/retain-asset-bundles.cjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ret-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('collectHashedFiles', () => {
  it('returns Vite-hashed js/css bundles (dash separator, uppercase/digit in hash)', () => {
    writeFileSync(join(dir, 'embed-Coqc9fp6.js'), '');
    writeFileSync(join(dir, 'style-XyZ9wVu8.css'), '');
    const got = collectHashedFiles(dir).sort();
    expect(got).toEqual(['embed-Coqc9fp6.js', 'style-XyZ9wVu8.css']);
  });

  it('returns Hugo-fingerprinted CSS (dot separator, 32+ char lowercase-hex hash)', () => {
    writeFileSync(join(dir, 'sap-fundamental.9a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9.css'), '');
    writeFileSync(join(dir, 'chroma-light.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.css'), '');
    const got = collectHashedFiles(dir).sort();
    expect(got).toEqual([
      'chroma-light.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.css',
      'sap-fundamental.9a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9.css',
    ]);
  });

  it('ignores bare/committed css files and short hashes', () => {
    writeFileSync(join(dir, 'styles.css'), '');                   // bare css → ignored
    writeFileSync(join(dir, 'consent-trustarc.js'), '');           // lowercase-only hash → ignored
    writeFileSync(join(dir, 'consent.js'), '');                   // no hash → ignored
    writeFileSync(join(dir, 'featured-rail.js'), '');             // no hash → ignored
    writeFileSync(join(dir, 'ui5-bootstrap.js'), '');             // no hash → ignored
    writeFileSync(join(dir, 'short.9a1b2c3d.css'), '');           // < 32 hex chars → ignored
    const got = collectHashedFiles(dir);
    expect(got).toEqual([]);
  });

  it('returns [] for a missing directory', () => {
    expect(collectHashedFiles(join(dir, 'nope'))).toEqual([]);
  });

  it('recurses into chunks/ and returns forward-slash relative paths (the events-band 404 fix)', () => {
    mkdirSync(join(dir, 'chunks'));
    writeFileSync(join(dir, 'homepage-events-band-BX0x3PRG.js'), '');   // top-level entry
    writeFileSync(join(dir, 'chunks', 'csrf-fetch-C6Fpypfx.js'), '');   // shared chunk it imports
    writeFileSync(join(dir, 'chunks', 'format-date-DooLMa2G.js'), '');
    const got = collectHashedFiles(dir).sort();
    expect(got).toEqual([
      'chunks/csrf-fetch-C6Fpypfx.js',
      'chunks/format-date-DooLMa2G.js',
      'homepage-events-band-BX0x3PRG.js',
    ]);
  });
});

describe('main() network fail-open', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('(a) with no APPROUTER_URL and no fetch, writes manifest of only current hashed files', async () => {
    const jsDir = join(dir, 'js');
    const cssDir = join(dir, 'css');
    const manifestOut = join(dir, 'manifest.json');

    mkdirSync(jsDir);
    mkdirSync(cssDir);

    // Create hashed files
    writeFileSync(join(jsDir, 'nav-Ab12Cd34.js'), '');
    writeFileSync(join(cssDir, 'style-XyZ9wVu8.css'), '');

    // Stub fetch to ensure it's never called
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('fetch should not be called')));

    await main({
      jsDir,
      cssDir,
      manifestOut,
      approuterUrl: '',  // no approuter
      nowMs: 0,
    });

    const manifest = JSON.parse(readFileSync(manifestOut, 'utf8'));
    // Should contain only current files
    expect(manifest).toEqual([
      { file: 'nav-Ab12Cd34.js', firstSeenMs: 0, lastSeenMs: 0 },
      { file: 'style-XyZ9wVu8.css', firstSeenMs: 0, lastSeenMs: 0 },
    ]);
    expect(manifest.length).toBe(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('(b) when prior-manifest fetch rejects, completes and writes current-files manifest without throwing', async () => {
    const jsDir = join(dir, 'js');
    const cssDir = join(dir, 'css');
    const manifestOut = join(dir, 'manifest.json');

    mkdirSync(jsDir);
    mkdirSync(cssDir);

    writeFileSync(join(jsDir, 'app-Qw1Er2Ty.js'), '');

    // Stub fetch to reject on manifest fetch
    globalThis.fetch = vi.fn(async (url) => {
      throw new Error('network timeout');
    });

    // Should not throw
    await main({
      jsDir,
      cssDir,
      manifestOut,
      approuterUrl: 'https://approuter.example.com',
      nowMs: 0,
    });

    const manifest = JSON.parse(readFileSync(manifestOut, 'utf8'));
    expect(manifest).toEqual([{ file: 'app-Qw1Er2Ty.js', firstSeenMs: 0, lastSeenMs: 0 }]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://approuter.example.com/_retained-assets.json',
      expect.any(Object)
    );
  });

  it('(c) when bundle download returns non-OK response, completes fail-open with warning', async () => {
    const jsDir = join(dir, 'js');
    const cssDir = join(dir, 'css');
    const manifestOut = join(dir, 'manifest.json');

    mkdirSync(jsDir);
    mkdirSync(cssDir);

    writeFileSync(join(jsDir, 'current-Ab12Cd34.js'), '');

    const priorManifest = [{ file: 'prior-Xy12Ab34.js', firstSeenMs: 0 }];
    const downloadWarnings = [];
    const origWarn = console.warn;
    console.warn = vi.fn((msg) => {
      if (msg && msg.includes('[retain-assets]')) downloadWarnings.push(msg);
      origWarn(msg);
    });

    let callCount = 0;
    globalThis.fetch = vi.fn(async (url) => {
      callCount++;
      if (url.includes('_retained-assets.json')) {
        // Return prior manifest on first call
        return {
          ok: true,
          json: async () => priorManifest,
        };
      } else if (url.includes('prior-Xy12Ab34')) {
        // Return 404 for the prior bundle download
        return { ok: false, status: 404 };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await main({
      jsDir,
      cssDir,
      manifestOut,
      approuterUrl: 'https://approuter.example.com',
      nowMs: 0,
      windowMs: 48 * 3600_000,
    });

    const manifest = JSON.parse(readFileSync(manifestOut, 'utf8'));
    // Should contain current file + failed prior (still in manifest, just not downloaded)
    expect(manifest).toEqual([
      { file: 'current-Ab12Cd34.js', firstSeenMs: 0, lastSeenMs: 0 },
      { file: 'prior-Xy12Ab34.js', firstSeenMs: 0, lastSeenMs: 0 },
    ]);

    // Should warn about the failed download
    const warnText = downloadWarnings.find(w => w.includes('could not fetch carried'));
    expect(warnText).toBeTruthy();
    expect(warnText).toContain('prior-Xy12Ab34.js');

    console.warn = origWarn;
  });

  it('(d) carries forward a prior chunk into chunks/ via the /js/chunks/ URL (events-band regression)', async () => {
    const jsDir = join(dir, 'js');
    const cssDir = join(dir, 'css');
    const manifestOut = join(dir, 'manifest.json');

    mkdirSync(jsDir);
    mkdirSync(cssDir);
    // Current build ships a fresh csrf-fetch chunk hash; the old one dropped out.
    mkdirSync(join(jsDir, 'chunks'));
    writeFileSync(join(jsDir, 'homepage-events-band-NEWENTRY.js'), '');
    writeFileSync(join(jsDir, 'chunks', 'csrf-fetch-NEWHASH0.js'), '');

    // Prior manifest recorded the OLD entry + OLD chunk (still referenced by
    // already-published HTML). Both must carry forward.
    const priorManifest = [
      { file: 'homepage-events-band-OLDENTRY.js', firstSeenMs: 0, lastSeenMs: 0 },
      { file: 'chunks/csrf-fetch-C6Fpypfx.js', firstSeenMs: 0, lastSeenMs: 0 },
    ];

    const requested = [];
    globalThis.fetch = vi.fn(async (url) => {
      requested.push(url);
      if (url.includes('_retained-assets.json')) return { ok: true, json: async () => priorManifest };
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    });

    await main({
      jsDir, cssDir, manifestOut,
      approuterUrl: 'https://approuter.example.com',
      nowMs: 0,
      windowMs: 48 * 3600_000,
    });

    // The chunk was fetched from its /js/chunks/ URL and written under chunks/.
    expect(requested).toContain('https://approuter.example.com/js/chunks/csrf-fetch-C6Fpypfx.js');
    expect(existsSync(join(jsDir, 'chunks', 'csrf-fetch-C6Fpypfx.js'))).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestOut, 'utf8'));
    expect(manifest.map(e => e.file).sort()).toEqual([
      'chunks/csrf-fetch-C6Fpypfx.js',
      'chunks/csrf-fetch-NEWHASH0.js',
      'homepage-events-band-NEWENTRY.js',
      'homepage-events-band-OLDENTRY.js',
    ]);
  });
});
