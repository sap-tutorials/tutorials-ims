/**
 * bundle-load-guard.test.js
 *
 * Guards against CF boot-crash caused by duplicate top-level `createRequire`
 * declarations (banner vs. esbuild-injected). Regression test for the bug
 * reported on 2026-09-28: content.bundle.mjs and channels.bundle.mjs each had
 * TWO conflicting `import { createRequire }` statements — one from the
 * hand-added banner in scripts/bundle-shared.cjs and one injected by esbuild
 * for CJS interop — causing a SyntaxError at CF runtime.
 *
 * After the fix, the banner uses the alias `__cjsBundleRequire` so its binding
 * does not collide with esbuild's own bare `createRequire` injection.
 *
 * This test:
 *   1. Rebuilds all bundles via `node scripts/bundle-shared.cjs`.
 *   2. For EACH *.bundle.mjs, dynamically imports it and asserts no SyntaxError.
 *   3. For EACH *.bundle.mjs, asserts the bundle does NOT contain a bare
 *      `import { createRequire }` on line 1 (the hand-added banner must use
 *      an alias, e.g. `__cjsBundleRequire`), and that the bare binding does not
 *      appear more than once in the file (esbuild's own injection is acceptable).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Bundle output directories and their expected bundles.
const BUNDLE_DIRS = [
  {
    dir: 'srv/lib/_shared',
    bundles: ['core.bundle.mjs', 'content.bundle.mjs', 'mcp.bundle.mjs', 'kg.bundle.mjs', 'channels.bundle.mjs'],
  },
  {
    dir: 'srv-qa/lib/_shared',
    bundles: ['core.bundle.mjs', 'content.bundle.mjs'],
  },
  {
    dir: 'srv-mcp/lib/_shared',
    bundles: ['core.bundle.mjs', 'mcp.bundle.mjs'],
  },
];

// Matches the bare (un-aliased) `import { createRequire }` pattern.
// After the fix, the banner must NOT use this form (it must alias to
// __cjsBundleRequire).  esbuild may still inject one bare occurrence for its
// own CJS interop; more than one bare occurrence means the banner reverted.
const BARE_CREATE_REQUIRE_RE = /^import \{ createRequire \}/m;
const BANNER_LINE_RE = /^import \{ createRequire \} from ['"]module['"]/;

describe('bundle-load-guard', () => {
  beforeAll(() => {
    // Rebuild all bundles fresh.  This is fast (~3s) and ensures the test
    // reflects the current state of scripts/bundle-shared.cjs.
    // Use try/catch to surface stderr when bundle-shared.cjs fails — without
    // this, execFileSync throws a SpawnError whose message doesn't include
    // the script's stderr, making the failure opaque ("module not found"
    // downstream rather than the actual bundler error).
    let result;
    try {
      result = execFileSync(process.execPath, ['scripts/bundle-shared.cjs'], {
        stdio: 'pipe',
        cwd: process.cwd(),
      });
    } catch (err) {
      const stderr = (err.stderr || Buffer.alloc(0)).toString().trim();
      const stdout = (err.stdout || Buffer.alloc(0)).toString().trim();
      throw new Error(
        `bundle-shared.cjs failed (exit ${err.status ?? 'null'}):\n` +
        (stderr ? `STDERR:\n${stderr}\n` : '') +
        (stdout ? `STDOUT:\n${stdout}\n` : '') +
        'Fix bundle-shared.cjs before running bundle-load-guard tests.'
      );
    }
    void result; // output not needed — failure already throws above
  }, 60_000);

  for (const { dir, bundles } of BUNDLE_DIRS) {
    for (const bundle of bundles) {
      const bundlePath = path.resolve(dir, bundle);
      const label = `${dir}/${bundle}`;

      it(`${label}: loads via dynamic import without SyntaxError`, async () => {
        expect(fs.existsSync(bundlePath), `bundle missing: ${bundlePath}`).toBe(true);
        // This is the crash gate: a SyntaxError caused by a duplicate
        // `createRequire` binding will throw here.
        await expect(import(pathToFileURL(bundlePath).href)).resolves.toBeDefined();
      });

      it(`${label}: banner does not use bare createRequire (must use alias to avoid esbuild collision)`, () => {
        expect(fs.existsSync(bundlePath), `bundle missing: ${bundlePath}`).toBe(true);
        const firstLine = fs.readFileSync(bundlePath, 'utf8').split('\n')[0];
        // The banner on line 1 must NOT contain the bare `createRequire` binding
        // — it must be aliased (e.g. `import { createRequire as __cjsBundleRequire }`).
        expect(BANNER_LINE_RE.test(firstLine), [
          `${label} line 1 still uses bare \`import { createRequire } from 'module'\`.`,
          `This collides with esbuild's own createRequire injection in CJS-heavy bundles.`,
          `Fix: use \`import { createRequire as __cjsBundleRequire } from 'module'\` in the banner.`,
          `Actual line 1: ${firstLine}`,
        ].join('\n')).toBe(false);
      });

      it(`${label}: no duplicate bare createRequire binding (at most one across file)`, () => {
        expect(fs.existsSync(bundlePath), `bundle missing: ${bundlePath}`).toBe(true);
        const text = fs.readFileSync(bundlePath, 'utf8');
        const matches = text.match(new RegExp(BARE_CREATE_REQUIRE_RE.source, 'mg')) ?? [];
        // esbuild may inject at most one bare `import { createRequire }`.
        // If there are TWO or more, the banner reverted and we have a collision.
        expect(
          matches.length,
          `${label} has ${matches.length} bare \`import { createRequire }\` lines — expected at most 1.\nMatches:\n${matches.join('\n')}`
        ).toBeLessThanOrEqual(1);
      });
    }
  }
});
