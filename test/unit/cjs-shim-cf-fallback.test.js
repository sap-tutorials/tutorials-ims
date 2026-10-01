/**
 * cjs-shim-cf-fallback.test.js
 *
 * Regression guard for the DEV-deploy blocker found on 2026-09-28:
 * srv/lib/*.cjs shims did `module.exports = require('@tutorials/content/<X>.cjs')`
 * UNCONDITIONALLY.  This works in local dev (workspace symlink) but crashes at
 * CF boot with MODULE_NOT_FOUND because @tutorials/* workspace packages are NOT
 * deployed — only their esbuild bundles + copied .cjs files in _shared/ ship.
 *
 * Fix: wrap the require in try/catch and fall back to `./_shared/<basename>.cjs`.
 *
 * This test has TWO layers:
 *
 *   A. Static guard (fast, always runs): for every srv/lib/*.cjs that references
 *      `@tutorials/`, assert it contains a `catch` block with a `./_shared/`
 *      fallback AND that the referenced _shared file exists on disk.
 *
 *   B. Runtime guard (spawns child process): for each shim, monkey-patch
 *      Module._resolveFilename so that any @tutorials/* specifier throws
 *      MODULE_NOT_FOUND, then require the shim and assert it resolves to a
 *      non-empty object — proving CF-boot resolution via the _shared fallback.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();

// Ensure _shared/ bundles + copied .cjs files exist before any test runs.
// The static guard (layer A) checks that the _shared fallback file exists on
// disk, and the runtime guard (layer B) requires it directly. Without this,
// the test fails in CI (where _shared/ is gitignored and never checked in) if
// bundle-load-guard.test.js hasn't finished its own beforeAll in a parallel
// worker yet.
beforeAll(() => {
  try {
    execFileSync(process.execPath, ['scripts/bundle-shared.cjs'], {
      stdio: 'pipe',
      cwd: ROOT,
    });
  } catch (err) {
    const stderr = (err.stderr || Buffer.alloc(0)).toString().trim();
    const stdout = (err.stdout || Buffer.alloc(0)).toString().trim();
    throw new Error(
      `bundle-shared.cjs failed (exit ${err.status ?? 'null'}):\n` +
      (stderr ? `STDERR:\n${stderr}\n` : '') +
      (stdout ? `STDOUT:\n${stdout}\n` : '') +
      'Fix bundle-shared.cjs so cjs-shim-cf-fallback tests can run.'
    );
  }
}, 60_000);

// The 7 CJS shims that must have the try/catch fallback.
const CJS_SHIMS = [
  'srv/lib/image-store.cjs',
  'srv/lib/image-ingest.cjs',
  'srv/lib/attachment-store.cjs',
  'srv/lib/attachment-ingest.cjs',
  'srv/lib/attachment-mime.cjs',
  'srv/lib/img-cdn-fetch.cjs',
  'srv/lib/img-cdn-retry.cjs',
];

// Helper: extract the @tutorials/ specifier from a shim file's source.
function extractTutorialsRequire(src) {
  const m = src.match(/require\(['"](@tutorials\/[^'"]+)['"]\)/);
  return m ? m[1] : null;
}

// Helper: extract the _shared fallback path from a shim file's source.
function extractSharedFallback(src) {
  const m = src.match(/require\(['"](\.\/_shared\/[^'"]+)['"]\)/);
  return m ? m[1] : null;
}

describe('cjs-shim-cf-fallback: static guard', () => {
  for (const shimRel of CJS_SHIMS) {
    const shimPath = path.resolve(ROOT, shimRel);
    const shimDir = path.dirname(shimPath);

    it(`${shimRel}: file exists`, () => {
      expect(fs.existsSync(shimPath), `shim missing: ${shimPath}`).toBe(true);
    });

    it(`${shimRel}: contains try/catch with MODULE_NOT_FOUND check`, () => {
      const src = fs.readFileSync(shimPath, 'utf8');
      expect(src, `${shimRel} missing try block`).toMatch(/\btry\s*\{/);
      expect(src, `${shimRel} missing catch block`).toMatch(/\bcatch\s*\(/);
      expect(src, `${shimRel} missing MODULE_NOT_FOUND guard`).toMatch(/MODULE_NOT_FOUND/);
    });

    it(`${shimRel}: has a ./_shared/ fallback require`, () => {
      const src = fs.readFileSync(shimPath, 'utf8');
      const fallback = extractSharedFallback(src);
      expect(
        fallback,
        `${shimRel} does not contain a require('./_shared/...') fallback`
      ).toBeTruthy();
    });

    it(`${shimRel}: the _shared fallback file exists on disk`, () => {
      const src = fs.readFileSync(shimPath, 'utf8');
      const fallback = extractSharedFallback(src);
      if (!fallback) return; // caught by previous test
      const fallbackPath = path.resolve(shimDir, fallback);
      expect(
        fs.existsSync(fallbackPath),
        `_shared fallback for ${shimRel} not found at ${fallbackPath}`
      ).toBe(true);
    });
  }
});

describe('cjs-shim-cf-fallback: runtime guard (CF-condition simulation)', () => {
  // The inline script monkey-patches Module._resolveFilename to throw
  // MODULE_NOT_FOUND for any @tutorials/* specifier, then requires the shim.
  // If the fallback is wired correctly, the require must succeed and return
  // a non-empty object (module.exports has at least one own key).
  const HOOK = `
    'use strict';
    const m = require('module');
    const orig = m._resolveFilename;
    m._resolveFilename = function(r, ...a) {
      if (String(r).startsWith('@tutorials/')) {
        throw Object.assign(new Error('MODULE_NOT_FOUND: ' + r), { code: 'MODULE_NOT_FOUND' });
      }
      return orig.call(this, r, ...a);
    };
  `;

  for (const shimRel of CJS_SHIMS) {
    it(`${shimRel}: resolves via _shared fallback when @tutorials/* is absent (CF simulation)`, () => {
      const shimAbsPath = path.resolve(ROOT, shimRel).replace(/\\/g, '/');
      const script = `
        ${HOOK}
        const x = require(${JSON.stringify(shimAbsPath)});
        const keys = Object.keys(x).length;
        if (keys === 0) {
          process.stderr.write('WARNING: ${shimRel} exports empty object\\n');
        }
        // Exiting 0 is success — the require didn't throw.
        process.stdout.write('keys:' + keys + '\\n');
      `;

      let stdout;
      try {
        stdout = execFileSync(process.execPath, ['-e', script], {
          encoding: 'utf8',
          cwd: ROOT,
          timeout: 15_000,
        });
      } catch (err) {
        // execFileSync throws on non-zero exit — include stderr in the message.
        throw new Error(
          `${shimRel} CF-simulation failed (crashed on require):\n${err.stderr ?? err.message}`
        );
      }

      const keysMatch = stdout.match(/keys:(\d+)/);
      expect(
        keysMatch,
        `${shimRel}: child process output did not include key count — stdout: ${stdout}`
      ).toBeTruthy();

      const keyCount = parseInt(keysMatch[1], 10);
      expect(
        keyCount,
        `${shimRel}: fallback resolved but module.exports appears empty (0 keys) — may be a re-export issue`
      ).toBeGreaterThan(0);
    });
  }
});
