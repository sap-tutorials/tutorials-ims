// hugo-apps/src/ui5/__tests__/ui5-split-build.build.test.ts
//
// Build-output assertions for all four ui5 code-split entries (#1777).
// Confirms that each entry emits a hashed file under hugo/static/js/ and that
// exactly one shared ui5-vendor chunk exists in the Vite manifest.
//
// SELF-SKIP: the entire describe is skipped when hugo/static/js/.vite/manifest.json
// is absent — i.e. `npm run build` (or `npm run build:apps`) in the hugo-apps
// workspace has not been run. This keeps the fast `npm test` unit PR gate clean
// on a fresh checkout while still making the assertions available for build-tier
// and local runs.
//
// Run after `npm run build:apps` in the hugo-apps workspace:
//   npx vitest run --project unit hugo-apps/src/ui5/__tests__/ui5-split-build.build.test.ts
//
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(__dirname, '../../../../hugo/static/js');
const MANIFEST_PATH = resolve(OUT, '.vite/manifest.json');

// Skip the whole suite when the manifest (and therefore the build outputs) are absent.
describe.skipIf(!existsSync(MANIFEST_PATH))('ui5 Vite entries — build outputs (build-tier)', () => {
  let manifest: Record<string, { name?: string; file?: string }>;

  beforeAll(() => {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  });

  it('emits a hashed ui5-core entry', () => {
    expect(readdirSync(OUT).some(f => /^ui5-core-[A-Za-z0-9_-]{8,}\.js$/.test(f))).toBe(true);
  });

  it('emits a hashed ui5-tutorial entry', () => {
    expect(readdirSync(OUT).some(f => /^ui5-tutorial-[A-Za-z0-9_-]{8,}\.js$/.test(f))).toBe(true);
  });

  it('emits a hashed ui5-me entry', () => {
    expect(readdirSync(OUT).some(f => /^ui5-me-[A-Za-z0-9_-]{8,}\.js$/.test(f))).toBe(true);
  });

  it('emits a hashed ui5-illustrations entry', () => {
    expect(readdirSync(OUT).some(f => /^ui5-illustrations-[A-Za-z0-9_-]{8,}\.js$/.test(f))).toBe(true);
  });

  it('emits exactly one shared ui5-vendor chunk', () => {
    const vendorChunks = Object.values(manifest).filter((v: any) => v.name === 'ui5-vendor');
    expect(vendorChunks.length).toBe(1);
  });
});
