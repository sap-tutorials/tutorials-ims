// test/unit/seed-sapphire-2026-concepts.test.js
//
// Static validation of the SAPPHIRE_2026_CONCEPTS list shipped in
// scripts/seed-sapphire-2026-concepts.js. Runs at unit-test speed with
// no DB — catches slug typos, over-length descriptions, and dupes
// before a HANA insert would surface them.
//
// Schema constraints validated here mirror db/knowledge-graph.cds
// Concepts entity: slug String(80) unique, name String(120),
// description String(500).

import { describe, it, expect } from 'vitest';
import { SAPPHIRE_2026_CONCEPTS } from '../../scripts/seed-sapphire-2026-concepts.js';

describe('SAPPHIRE_2026_CONCEPTS (#858)', () => {
  it('has the expected 14 concepts', () => {
    expect(SAPPHIRE_2026_CONCEPTS).toHaveLength(14);
  });

  it('slugs are kebab-case, lowercase, ≤80 chars', () => {
    for (const c of SAPPHIRE_2026_CONCEPTS) {
      expect(c.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(c.slug.length).toBeLessThanOrEqual(80);
    }
  });

  it('slugs are unique across the list', () => {
    const slugs = SAPPHIRE_2026_CONCEPTS.map(c => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('names are ≤120 chars', () => {
    for (const c of SAPPHIRE_2026_CONCEPTS) {
      expect(c.name).toBeTypeOf('string');
      expect(c.name.length).toBeLessThanOrEqual(120);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  it('descriptions are ≤500 chars (Concepts.description column limit)', () => {
    for (const c of SAPPHIRE_2026_CONCEPTS) {
      expect(c.description).toBeTypeOf('string');
      expect(c.description.length).toBeLessThanOrEqual(500);
      // Guard against accidental empty descriptions.
      expect(c.description.length).toBeGreaterThan(20);
    }
  });

  it('covers the four Sapphire 2026 headline concepts by exact slug', () => {
    const slugs = new Set(SAPPHIRE_2026_CONCEPTS.map(c => c.slug));
    expect(slugs.has('business-data-cloud')).toBe(true);
    expect(slugs.has('business-ai-platform')).toBe(true);
    expect(slugs.has('joule-studio')).toBe(true);
    expect(slugs.has('agentic-ai')).toBe(true);
  });

  it('module is frozen so callers can\'t mutate the shipped list', () => {
    expect(Object.isFrozen(SAPPHIRE_2026_CONCEPTS)).toBe(true);
  });
});
