// test/unit/srv/featured-topics-freshness.test.js
//
// #1783 — loose freshness floor for the Featured (PageRank) carousel.
// Genuinely ancient tutorials are dropped from the eligibility set in
// loadInputs; NULL/missing reviewedDate keeps a tutorial (fail-open), and the
// cutoff is admin-configurable via ImsConfig with a generous default.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import {
  applyFreshnessFilter,
  DEFAULT_FRESHNESS_MAX_AGE_DAYS,
} from '../../../srv/lib/featured-topics-snapshot.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('applyFreshnessFilter (pure)', () => {
  const now = Date.UTC(2026, 7, 14); // 2026-08-14
  const daysAgo = (d) => now - d * DAY_MS;

  it('keeps a tutorial with no reviewedDate entry (fail-open on missing meta)', () => {
    const set = new Set(['a', 'b']);
    const { kept, dropped } = applyFreshnessFilter(set, new Map(), 365, now);
    expect([...kept].sort()).toEqual(['a', 'b']);
    expect(dropped).toEqual([]);
  });

  it('keeps a recently-reviewed tutorial and drops an ancient one', () => {
    const set = new Set(['fresh', 'stale']);
    const reviewed = new Map([
      ['fresh', daysAgo(100)],
      ['stale', daysAgo(900)],
    ]);
    const { kept, dropped } = applyFreshnessFilter(set, reviewed, 730, now);
    expect([...kept]).toEqual(['fresh']);
    expect(dropped).toEqual(['stale']);
  });

  it('keeps a tutorial exactly at the cutoff boundary (>= is kept)', () => {
    const set = new Set(['edge']);
    const reviewed = new Map([['edge', daysAgo(365)]]);
    const { kept, dropped } = applyFreshnessFilter(set, reviewed, 365, now);
    expect([...kept]).toEqual(['edge']);
    expect(dropped).toEqual([]);
  });

  it('disables filtering when maxAgeDays <= 0 (returns the original set)', () => {
    const set = new Set(['ancient']);
    const reviewed = new Map([['ancient', daysAgo(5000)]]);
    for (const off of [0, -1]) {
      const { kept, dropped } = applyFreshnessFilter(set, reviewed, off, now);
      expect(kept).toBe(set); // same reference — no work done
      expect(dropped).toEqual([]);
    }
  });

  it('does NOT drop the #1771 case (a ~344-day-old tutorial under a 730d floor)', () => {
    const set = new Set(['es5-ish']);
    const reviewed = new Map([['es5-ish', daysAgo(344)]]);
    const { kept, dropped } = applyFreshnessFilter(set, reviewed, DEFAULT_FRESHNESS_MAX_AGE_DAYS, now);
    expect([...kept]).toEqual(['es5-ish']);
    expect(dropped).toEqual([]);
  });
});

describe('featured-topics freshness (DB-backed)', () => {
  const NS = 'com.sap.developers.ims';
  let recomputeSnapshot, readSnapshotForFeed, resolveFreshnessMaxAgeDays;
  const CFG_KEY = 'featured.freshness.maxAgeDays';

  beforeAll(async () => {
    await cds.deploy(['db/knowledge-graph.cds', 'db/homepage-featured.cds', 'db/schema.cds', 'db/knowledge-graph-communities.cds']).to('sqlite::memory:');
    ({ recomputeSnapshot, readSnapshotForFeed, resolveFreshnessMaxAgeDays } = await import('../../../srv/lib/featured-topics-snapshot.js'));
  });

  beforeEach(async () => {
    await cds.tx(async (tx) => {
      const { HomepageFeaturedTopics, TutorialConceptLinks, TutorialRank, ConceptRank, Tutorials, Missions, Concepts, TutorialMeta, ImsConfig, FeaturedTopicsSnapshot } = cds.entities(NS);
      await tx.run(DELETE.from(FeaturedTopicsSnapshot));
      await tx.run(DELETE.from(HomepageFeaturedTopics));
      await tx.run(DELETE.from(TutorialConceptLinks));
      await tx.run(DELETE.from(TutorialRank));
      await tx.run(DELETE.from(ConceptRank));
      await tx.run(DELETE.from(TutorialMeta));
      await tx.run(DELETE.from(Tutorials));
      await tx.run(DELETE.from(Missions));
      await tx.run(DELETE.from(Concepts));
      await tx.run(DELETE.from(ImsConfig));
    });
  });

  describe('resolveFreshnessMaxAgeDays', () => {
    it('returns the generous default when the config row is absent', async () => {
      await cds.tx(async (tx) => {
        expect(await resolveFreshnessMaxAgeDays(tx)).toBe(DEFAULT_FRESHNESS_MAX_AGE_DAYS);
      });
    });

    it('returns the default when the value is blank or non-numeric', async () => {
      const { ImsConfig } = cds.entities(NS);
      await cds.tx(async (tx) => {
        await tx.run(INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key: CFG_KEY, value: '   ' }));
        expect(await resolveFreshnessMaxAgeDays(tx)).toBe(DEFAULT_FRESHNESS_MAX_AGE_DAYS);
      });
      await cds.tx(async (tx) => {
        await tx.run(DELETE.from(ImsConfig));
        await tx.run(INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key: CFG_KEY, value: 'soon' }));
        expect(await resolveFreshnessMaxAgeDays(tx)).toBe(DEFAULT_FRESHNESS_MAX_AGE_DAYS);
      });
    });

    it('honours an explicit numeric override (including 0 to disable)', async () => {
      const { ImsConfig } = cds.entities(NS);
      await cds.tx(async (tx) => {
        await tx.run(INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key: CFG_KEY, value: '90' }));
        expect(await resolveFreshnessMaxAgeDays(tx)).toBe(90);
      });
      await cds.tx(async (tx) => {
        await tx.run(DELETE.from(ImsConfig));
        await tx.run(INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key: CFG_KEY, value: '0' }));
        expect(await resolveFreshnessMaxAgeDays(tx)).toBe(0);
      });
    });
  });

  async function seedConceptWithTwoTutorials(tx, { freshReviewed, staleReviewed }) {
    const { Concepts, Tutorials, TutorialRank, TutorialConceptLinks, HomepageFeaturedTopics, TutorialMeta } = cds.entities(NS);
    const conceptId = cds.utils.uuid();
    const freshId = cds.utils.uuid();
    const staleId = cds.utils.uuid();
    const now = new Date().toISOString();
    await tx.run(INSERT.into(Concepts).entries({ ID: conceptId, slug: 'cap', name: 'CAP', status: 'ACTIVE', publishedAt: now }));
    await tx.run(INSERT.into(Tutorials).entries([
      { ID: freshId, slug: 'fresh-t', title: 'Fresh' },
      { ID: staleId, slug: 'stale-t', title: 'Stale' },
    ]));
    await tx.run(INSERT.into(TutorialRank).entries([
      { slug: 'fresh-t', score: 0.9, computedAt: now },
      { slug: 'stale-t', score: 1.0, computedAt: now }, // stale outranks fresh — proves the floor, not the score
    ]));
    await tx.run(INSERT.into(TutorialConceptLinks).entries([
      { ID: cds.utils.uuid(), tutorial_ID: freshId, concept_ID: conceptId, predicate: 'teaches' },
      { ID: cds.utils.uuid(), tutorial_ID: staleId, concept_ID: conceptId, predicate: 'teaches' },
    ]));
    await tx.run(INSERT.into(HomepageFeaturedTopics).entries({ ID: cds.utils.uuid(), concept_ID: conceptId, sortOrder: 10, isActive: true }));
    const meta = [];
    if (freshReviewed !== undefined) meta.push({ ID: cds.utils.uuid(), tutorial_ID: freshId, reviewedDate: freshReviewed });
    if (staleReviewed !== undefined) meta.push({ ID: cds.utils.uuid(), tutorial_ID: staleId, reviewedDate: staleReviewed });
    if (meta.length) await tx.run(INSERT.into(TutorialMeta).entries(meta));
  }

  it('drops an ancient tutorial from the carousel while keeping the fresh one (default floor)', async () => {
    await cds.tx(async (tx) => {
      const fresh = new Date(Date.now() - 100 * DAY_MS).toISOString();
      const stale = new Date(Date.now() - 900 * DAY_MS).toISOString();
      await seedConceptWithTwoTutorials(tx, { freshReviewed: fresh, staleReviewed: stale });

      await recomputeSnapshot(tx);
      const feed = await readSnapshotForFeed(tx);
      expect(feed.slots).toHaveLength(1);
      const slugs = feed.slots[0].missions.map(m => m.slug);
      expect(slugs).toContain('fresh-t');
      expect(slugs).not.toContain('stale-t');
    });
  });

  it('keeps an ancient tutorial when reviewedDate is NULL (fail-open)', async () => {
    await cds.tx(async (tx) => {
      const fresh = new Date(Date.now() - 100 * DAY_MS).toISOString();
      // stale tutorial has a TutorialMeta row but NULL reviewedDate → kept
      await seedConceptWithTwoTutorials(tx, { freshReviewed: fresh, staleReviewed: null });

      await recomputeSnapshot(tx);
      const feed = await readSnapshotForFeed(tx);
      const slugs = feed.slots[0].missions.map(m => m.slug);
      expect(slugs).toContain('stale-t');
    });
  });

  it('keeps the ancient tutorial when the floor is disabled (config = 0)', async () => {
    await cds.tx(async (tx) => {
      const { ImsConfig } = cds.entities(NS);
      await tx.run(INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key: CFG_KEY, value: '0' }));
      const fresh = new Date(Date.now() - 100 * DAY_MS).toISOString();
      const stale = new Date(Date.now() - 5000 * DAY_MS).toISOString();
      await seedConceptWithTwoTutorials(tx, { freshReviewed: fresh, staleReviewed: stale });

      await recomputeSnapshot(tx);
      const feed = await readSnapshotForFeed(tx);
      const slugs = feed.slots[0].missions.map(m => m.slug);
      expect(slugs).toContain('stale-t');
    });
  });
});
