import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WF = join(__dirname, '..', '..', '.github', 'workflows', 'rebuild-content.yml');

// The `on:` key parses to JS boolean true, but we only read jobs.*.steps here.
const wf = parse(readFileSync(WF, 'utf8')) as {
  jobs: Record<string, { steps: Array<{ name?: string; if?: string; run?: string }> }>;
};

function findStep(name: string) {
  for (const job of Object.values(wf.jobs)) {
    const s = job.steps.find((st) => st.name === name);
    if (s) return s;
  }
  return undefined;
}

describe('rebuild-content.yml — island build runs in slug-targeted mode', () => {
  // These four steps produce the island bundles + manifest that island-src.html
  // needs to bake hashed /js paths. If any is gated against slug-targeted, a
  // single-tutorial rebuild bakes bare /js/<name>.js that 404s on the approuter.
  it.each([
    'Build Vue apps',
    'Build island manifest',
    'Guard - homepage islands fingerprinted',
  ])('step "%s" is not skipped for slug-targeted', (name) => {
    const step = findStep(name);
    expect(step, `step "${name}" not found`).toBeDefined();
    // No condition, or a condition that does NOT exclude slug-targeted.
    if (step!.if) {
      expect(step!.if).not.toMatch(/!=\s*'slug-targeted'/);
      expect(step!.if).not.toMatch(/effective_mode\s*!=\s*'slug-targeted'/);
    }
  });

  it('hugo-apps deps are installed unconditionally (no slug-targeted skip branch)', () => {
    const step = findStep('Install dependencies');
    expect(step, 'Install dependencies step not found').toBeDefined();
    expect(step!.run).toContain('npm --prefix hugo-apps install');
    // the old skip branch keyed on MODE != slug-targeted must be gone
    expect(step!.run).not.toMatch(/!=\s*"slug-targeted"/);
  });

  it('whole-site vendor WASM step is STILL gated against slug-targeted (scope guard)', () => {
    const step = findStep('Build vendor WASM bundles');
    expect(step, 'Build vendor WASM bundles step not found').toBeDefined();
    expect(step!.if).toMatch(/!=\s*'slug-targeted'/);
  });
});

describe('rebuild-content.yml — approuter guard probes islands in slug mode', () => {
  it('the slug-targeted approuter asset guard passes --check-islands', () => {
    const step = findStep('Guard - approuter serves referenced CSS + islands (slug-targeted)');
    expect(step, 'slug approuter guard step not found').toBeDefined();
    expect(step!.run).toContain('check-approuter-assets.cjs');
    expect(step!.run).toContain('--check-islands');
  });
});
