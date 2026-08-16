// test/unit/scripts/seed-island-manifest-from-deployed.test.ts
// #1659 Phase C.3 — validate the deployed island-manifest parser (fail-closed).
import { describe, it, expect } from 'vitest';
import { parseIslandManifest } from '../../../scripts/seed-island-manifest-from-deployed.ts';

describe('parseIslandManifest', () => {
  it('accepts a valid name→/js/<hash> map', () => {
    const json = JSON.stringify({
      navigator: '/js/navigator-BqX3k_2a.js',
      alerts: '/js/alerts-CMUM_6iz.js',
    });
    const out = parseIslandManifest(json);
    expect(out.navigator).toBe('/js/navigator-BqX3k_2a.js');
    expect(Object.keys(out)).toHaveLength(2);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseIslandManifest('{not json')).toThrow(/not valid JSON/);
  });

  it('throws on an empty object (nothing to bake)', () => {
    expect(() => parseIslandManifest('{}')).toThrow(/empty/);
  });

  it('throws on a non-object (array / null)', () => {
    expect(() => parseIslandManifest('[]')).toThrow(/did not parse to an object/);
    expect(() => parseIslandManifest('null')).toThrow(/did not parse to an object/);
  });

  it('throws when an entry path is not a /js/ path (would 404 / bare fallback)', () => {
    expect(() => parseIslandManifest(JSON.stringify({ navigator: 'navigator.js' }))).toThrow(/unexpected path/);
    expect(() => parseIslandManifest(JSON.stringify({ navigator: 42 }))).toThrow(/unexpected path/);
  });
});
