import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WF = join(__dirname, '..', '..', '.github', 'workflows', 'rebuild-content.yml');

// The `on:` key parses to JS boolean true, but we only read jobs.*.steps here.
const wf = parse(readFileSync(WF, 'utf8')) as {
  jobs: Record<string, { steps: Array<{ name?: string; if?: string; run?: string; env?: Record<string, string> }> }>;
};

function findStep(name: string) {
  for (const job of Object.values(wf.jobs)) {
    const s = job.steps.find((st) => st.name === name);
    if (s) return s;
  }
  return undefined;
}

// #1659 C.3+C.4 cutover: content rebuilds are HANA-only. Islands (and all static
// assets) are rendered against the CURRENTLY-DEPLOYED hashes — the island manifest
// is SEEDED from the approuter's /_island-manifest.json, never rebuilt locally
// (Vite hashes are non-deterministic) — and the /admin/rebuild static push is
// retired. This test encodes that contract (it previously asserted the inverse:
// that the local island build ran in every mode to feed the now-removed push).
describe('rebuild-content.yml — islands are SEEDED from deployed, not built', () => {
  it('seeds the island manifest from the deployed approuter in ALL modes', () => {
    const step = findStep('Seed island manifest from deployed');
    expect(step, 'seed step not found').toBeDefined();
    expect(step!.run).toContain('seed-island-manifest-from-deployed.ts');
    // Every mode renders pages that reference hashed islands, so the seed must NOT
    // be gated against slug-targeted / catalog-only.
    if (step!.if) {
      expect(step!.if).not.toMatch(/slug-targeted/);
      expect(step!.if).not.toMatch(/catalog-only/);
    }
    // It fetches from the deployed approuter.
    expect(step!.env?.APPROUTER_URL, 'seed step must set APPROUTER_URL').toBeTruthy();
  });

  it.each([
    'Build Vue apps',
    'Build island manifest',
    'Build vendor WASM bundles',
    'Build explore bundle + manifest',
    'Copy Joule vendor bundles',
    'Build display app',
    'Build admin SPAs',
  ])('local asset-build step "%s" is REMOVED (rebuilds no longer ship assets)', (name) => {
    expect(findStep(name), `step "${name}" should have been removed by the C.3/C.4 cutover`).toBeUndefined();
  });

  it.each([
    'Assemble static content',
    'Create content tarball',
    'Push content to AppRouter',
  ])('push step "%s" is REMOVED (/admin/rebuild retired)', (name) => {
    expect(findStep(name), `push step "${name}" should have been removed`).toBeUndefined();
  });
});

describe('rebuild-content.yml — approuter asset guard runs in ALL modes', () => {
  // With no push, this guard is the sole safety net: it verifies the deployed
  // approuter serves every referenced CSS + hashed-island asset BEFORE the HANA
  // publish, in EVERY mode (previously it was gated to slug-targeted only).
  it('the approuter asset guard probes islands and is not slug-targeted-gated', () => {
    const step = findStep('Guard - approuter serves referenced CSS + islands');
    expect(step, 'approuter asset guard step not found').toBeDefined();
    expect(step!.run).toContain('check-approuter-assets.cjs');
    expect(step!.run).toContain('--check-islands');
    if (step!.if) {
      expect(step!.if).not.toMatch(/==\s*'slug-targeted'/);
    }
  });
});
