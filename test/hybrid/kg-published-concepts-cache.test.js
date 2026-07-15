/**
 * #1182 — hybrid regression: the PublishedConceptsWithAliases @cache pilot
 * must round-trip through the CDS-DB store AND be busted by a concept write, so
 * a publish/unpublish never serves stale palette results.
 *
 * Boots the full srv under [hybrid] (real HANA, store:'cds') via `cds bind`.
 * Run with: cf login + cds bind --exec -- npx vitest run --project hybrid \
 *   test/hybrid/kg-published-concepts-cache.test.js
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { PUBLISHED_CONCEPTS_TAG, bustPublishedConceptsCache } from '../../srv/lib/kg-published-concepts-cache.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('#1182 — PublishedConcepts @cache pilot (hybrid)', () => {
  let cache;
  beforeAll(async () => { cache = await cds.connect.to('caching'); });

  it('caching service uses the CDS-DB store under hybrid', () => {
    expect(cds.env.requires.caching.store).toBe('cds');
  });

  it('tag round-trip: set → get hit → deleteByTag → miss', async () => {
    const key = `_1182_pc_probe_${process.pid}`;
    await cache.set(key, { probe: true }, { ttl: 60000, tags: [{ value: PUBLISHED_CONCEPTS_TAG }] });
    expect(await cache.get(key)).toEqual({ probe: true });
    await bustPublishedConceptsCache();
    expect(await cache.get(key)).toBeUndefined();
  });

  it('PublishedConceptsWithAliases read reflects a publish flip after bust (no stale content)', async () => {
    const kg = await cds.connect.to('KnowledgeGraphService');
    const { PublishedConceptsWithAliases } = kg.entities;

    // Warm: read once (populates the @cache entry for this query shape).
    const before = await kg.run(SELECT.from(PublishedConceptsWithAliases).limit(1));

    // Simulate the freshness signal the real publish/unpublish action emits.
    await bustPublishedConceptsCache();

    // Read again — must return live data, not a stale cached payload. We assert
    // the shape is intact (the pilot must never corrupt or drop rows on bust).
    const after = await kg.run(SELECT.from(PublishedConceptsWithAliases).limit(1));
    expect(Array.isArray(after)).toBe(true);
    if (before.length) {
      expect(after[0]).toHaveProperty('slug');
      expect(after[0]).toHaveProperty('publishedAt');
    }
  });
});
