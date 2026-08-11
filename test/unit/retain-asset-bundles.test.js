import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectHashedFiles, main } from '../../scripts/retain-asset-bundles.cjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ret-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('collectHashedFiles', () => {
  it('returns only hashed bundle filenames, ignoring unhashed and non-js/css', () => {
    writeFileSync(join(dir, 'embed-Coqc9fp6.js'), '');
    writeFileSync(join(dir, 'consent-trustarc.js'), '');   // unhashed → ignored
    writeFileSync(join(dir, 'notes.txt'), '');             // non-bundle → ignored
    const got = collectHashedFiles(dir).sort();
    expect(got).toEqual(['embed-Coqc9fp6.js']);
  });

  it('returns [] for a missing directory', () => {
    expect(collectHashedFiles(join(dir, 'nope'))).toEqual([]);
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
      { file: 'nav-Ab12Cd34.js', firstSeenMs: 0 },
      { file: 'style-XyZ9wVu8.css', firstSeenMs: 0 },
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
    expect(manifest).toEqual([{ file: 'app-Qw1Er2Ty.js', firstSeenMs: 0 }]);
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
      { file: 'current-Ab12Cd34.js', firstSeenMs: 0 },
      { file: 'prior-Xy12Ab34.js', firstSeenMs: 0 },
    ]);

    // Should warn about the failed download
    const warnText = downloadWarnings.find(w => w.includes('could not fetch carried'));
    expect(warnText).toBeTruthy();
    expect(warnText).toContain('prior-Xy12Ab34.js');

    console.warn = origWarn;
  });
});
