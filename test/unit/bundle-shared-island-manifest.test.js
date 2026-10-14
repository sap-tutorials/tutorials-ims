// test/unit/bundle-shared-island-manifest.test.js
//
// Regression guard for issue #2733: group/mission detail pages are SSR'd LIVE
// in the deployed tutorials-srv process (x-content-source: rendered), where
// catalog-renderer.js's islandSrc() reads `island-manifest.json` from the dir
// of the bundle it ships in (srv/lib/_shared/content.bundle.mjs). No build step
// ever placed that file beside the bundle, so islandSrc() failed open to the
// bare /js/<name>.js path, which 404s against the hashed-only approuter — the
// goal-completion / learning-path islands never loaded.
//
// scripts/bundle-shared.cjs now exports copyIslandManifestBeside(outDirs, src)
// which seeds the hyphenated island-manifest.json next to every bundle. These
// tests pin that contract.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { copyIslandManifestBeside } = require('../../scripts/lib/copy-island-manifest.cjs');

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'bundle-shared-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('copyIslandManifestBeside (issue #2733)', () => {
  it('is exported as a function', () => {
    expect(typeof copyIslandManifestBeside).toBe('function');
  });

  it('copies the manifest to island-manifest.json (hyphenated) in every out dir', () => {
    const src = join(tmp, 'island_manifest.json');
    writeFileSync(src, JSON.stringify({ 'goal-completion': '/js/goal-completion-ABC12345.js' }));
    const a = join(tmp, 'srv', 'lib', '_shared');
    const b = join(tmp, 'srv-qa', 'lib', '_shared');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    copyIslandManifestBeside([a, b], src);

    for (const dir of [a, b]) {
      const dst = join(dir, 'island-manifest.json');
      expect(existsSync(dst)).toBe(true);
      expect(JSON.parse(readFileSync(dst, 'utf8'))['goal-completion'])
        .toBe('/js/goal-completion-ABC12345.js');
    }
  });

  it('skips (fail-open) when the source manifest is entirely ABSENT — CI deploy builds islands out of band', () => {
    // deploy.yml runs bundle-shared with no island build in the same job, so the
    // source legitimately does not exist there; hard-failing would break that
    // deploy. The local build:deploy path always has the source, and deploy-mta
    // Step 2.5 guards that the seed landed.
    const a = join(tmp, 'srv', 'lib', '_shared');
    mkdirSync(a, { recursive: true });
    const res = copyIslandManifestBeside([a], join(tmp, 'does-not-exist.json'));
    expect(res.skipped).toBe(true);
    expect(res.copied).toEqual([]);
    expect(existsSync(join(a, 'island-manifest.json'))).toBe(false);
  });

  it('fails loudly when the source manifest is PRESENT but empty ({}) — would bake bare paths', () => {
    const src = join(tmp, 'island_manifest.json');
    writeFileSync(src, '{}');
    const a = join(tmp, 'srv', 'lib', '_shared');
    mkdirSync(a, { recursive: true });
    expect(() => copyIslandManifestBeside([a], src)).toThrow();
  });
});
