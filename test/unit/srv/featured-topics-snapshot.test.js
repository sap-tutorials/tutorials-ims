// test/unit/srv/featured-topics-snapshot.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { decodeDescription } from '../../../srv/lib/featured-topics-snapshot.js';
import { instrumentInLimit } from '../../helpers/assert-no-oversized-in.js';

describe('decodeDescription (HANA NCLOB → utf-8 string)', () => {
  // (#1032 followup) On HANA, LargeString/NCLOB columns come back from the
  // node driver as Node Buffer instances. Without decoding, JSON.stringify
  // in the /build/featured-topics and /homepage/featuredTopics() responses
  // would emit `{ "type": "Buffer", "data": [...] }` and the Vue island's
  // v-html card template would render that JSON blob as visible garbage.
  it('decodes a Buffer to its UTF-8 string', () => {
    const buf = Buffer.from('Sign up for a trial account on SAP BTP.', 'utf-8');
    expect(decodeDescription(buf)).toBe('Sign up for a trial account on SAP BTP.');
  });

  it('decodes multi-byte UTF-8 (e.g. accented characters) correctly', () => {
    const buf = Buffer.from('Configuración de SAP BTP · démarrer', 'utf-8');
    expect(decodeDescription(buf)).toBe('Configuración de SAP BTP · démarrer');
  });

  it('passes strings through unchanged', () => {
    expect(decodeDescription('already a string')).toBe('already a string');
  });

  it('normalises null / undefined to empty string', () => {
    expect(decodeDescription(null)).toBe('');
    expect(decodeDescription(undefined)).toBe('');
  });
});

describe('featured-topics-snapshot', () => {
  let recomputeSnapshot, readSnapshotForFeed;
  const NS = 'com.sap.developers.ims';

  beforeAll(async () => {
    await cds.deploy(['db/knowledge-graph.cds','db/homepage-featured.cds','db/schema.cds','db/knowledge-graph-communities.cds']).to('sqlite::memory:');
    ({ recomputeSnapshot, readSnapshotForFeed } = await import('../../../srv/lib/featured-topics-snapshot.js'));
  });

  it('produces an empty snapshot when no editorial and no ConceptRank rows', async () => {
    await cds.tx(async (tx) => {
      const res = await recomputeSnapshot(tx);
      expect(res.count).toBe(0);
      const feed = await readSnapshotForFeed(tx);
      expect(feed.slots).toEqual([]);
      expect(feed.etag).toMatch(/^W\/"[0-9a-f]{40}"$/);
    });
  });

  it('materializes 1 editorial slot when concept is published + missions active', async () => {
    await cds.tx(async (tx) => {
      const { Concepts, TutorialRank, TutorialConceptLinks, HomepageFeaturedTopics, Tutorials } = cds.entities(NS);
      const conceptId = cds.utils.uuid();
      const tutorialId = cds.utils.uuid();
      await tx.run(INSERT.into(Concepts).entries({ ID: conceptId, slug: 'cap', name: 'CAP', status: 'ACTIVE', publishedAt: new Date().toISOString() }));
      await tx.run(INSERT.into(Tutorials).entries({ ID: tutorialId, slug: 'cap-t1', title: 'CAP T1' }));
      await tx.run(INSERT.into(TutorialRank).entries({ slug: 'cap-t1', score: 1.0, computedAt: new Date().toISOString() }));
      await tx.run(INSERT.into(TutorialConceptLinks).entries({ ID: cds.utils.uuid(), tutorial_ID: tutorialId, concept_ID: conceptId, predicate: 'teaches' }));
      await tx.run(INSERT.into(HomepageFeaturedTopics).entries({ ID: cds.utils.uuid(), concept_ID: conceptId, sortOrder: 10, isActive: true }));

      const res = await recomputeSnapshot(tx);
      expect(res.count).toBe(1);
      const feed = await readSnapshotForFeed(tx);
      expect(feed.slots).toHaveLength(1);
      expect(feed.slots[0].conceptSlug).toBe('cap');
      expect(feed.slots[0].source).toBe('EDITORIAL');
      const card = feed.slots[0].missions[0];
      expect(card.slug).toBe('cap-t1');
      expect(card.kind).toBe('tutorial');
      expect(card.title).toBe('CAP T1');
      expect(card.href).toBe('/tutorials/cap-t1');
      expect(card.tutorialCount).toBe(1);
      expect(card).toHaveProperty('description');
      expect(card).toHaveProperty('level');
      expect(card.isNew).toBe(false);
    });
  });

  it('is idempotent — running twice produces the same rows', async () => {
    await cds.tx(async (tx) => {
      const first = await recomputeSnapshot(tx);
      const second = await recomputeSnapshot(tx);
      expect(second.count).toBe(first.count);
    });
  });

  it('emits mission card shape with /tutorials/mission-<slug> href', async () => {
    await cds.tx(async (tx) => {
      const { Concepts, HomepageFeaturedTopics, Missions, Tutorials, TutorialConceptLinks, TutorialRank } = cds.entities(NS);
      // Clean up state from prior tests
      await tx.run(DELETE.from(HomepageFeaturedTopics));
      await tx.run(DELETE.from(TutorialConceptLinks));
      await tx.run(DELETE.from(TutorialRank));
      await tx.run(DELETE.from(Tutorials));
      await tx.run(DELETE.from(Missions));
      await tx.run(DELETE.from(Concepts));

      const conceptId = cds.utils.uuid();
      await tx.run(INSERT.into(Concepts).entries({ ID: conceptId, slug: 'mtest', name: 'Mission Test', status: 'ACTIVE', publishedAt: new Date().toISOString() }));
      await tx.run(INSERT.into(Missions).entries({ ID: cds.utils.uuid(), slug: 'my-mission', title: 'My Mission' }));
      await tx.run(INSERT.into(HomepageFeaturedTopics).entries({
        ID: cds.utils.uuid(), concept_ID: conceptId, sortOrder: 5, isActive: true,
        missionSlugs: ['my-mission'],
      }));

      const res = await recomputeSnapshot(tx);
      expect(res.count).toBe(1);
      const feed = await readSnapshotForFeed(tx);
      expect(feed.slots).toHaveLength(1);
      const card = feed.slots[0].missions[0];
      expect(card.kind).toBe('mission');
      expect(card.href).toBe('/tutorials/mission-my-mission');
      expect(card.title).toBe('My Mission');
    });
  });

  // Regression: recomputeSnapshot MUST NOT emit a `slug IN (…)` query over
  // every ConceptRank row — HANA rejects it with "Failed to set parameters,
  // maximum packet size exceeded" once ConceptRank grows past ~a few thousand
  // rows. Fix: fetch all Concepts unbounded and filter in Node. We simulate
  // by seeding many ConceptRank rows and asserting the run completes without
  // any query in the trace carrying that many bound slug params.
  it('does not emit an unbounded slug-IN query over ConceptRank (packet-size regression)', async () => {
    await cds.tx(async (tx) => {
      const { Concepts, HomepageFeaturedTopics, TutorialConceptLinks, TutorialRank, Tutorials, Missions, ConceptRank } = cds.entities(NS);
      // Clean slate
      await tx.run(DELETE.from(HomepageFeaturedTopics));
      await tx.run(DELETE.from(TutorialConceptLinks));
      await tx.run(DELETE.from(TutorialRank));
      await tx.run(DELETE.from(ConceptRank));
      await tx.run(DELETE.from(Tutorials));
      await tx.run(DELETE.from(Missions));
      await tx.run(DELETE.from(Concepts));

      // Seed 3,000 ConceptRank rows — well past HANA's parameter batch ceiling
      // for a single WHERE IN (…) clause, and enough that a regression would
      // fail on real HANA even if SQLite tolerates it.
      const N = 3000;
      const now = new Date().toISOString();
      const conceptRows = [];
      const rankRows = [];
      for (let i = 0; i < N; i++) {
        conceptRows.push({ ID: cds.utils.uuid(), slug: `c-${i}`, name: `C ${i}`, status: 'ACTIVE', publishedAt: now });
        rankRows.push({ slug: `c-${i}`, score: 1 / (i + 1), computedAt: now });
      }
      // batch inserts to stay under SQLite's own bound-param cap
      for (let i = 0; i < N; i += 500) {
        await tx.run(INSERT.into(Concepts).entries(conceptRows.slice(i, i + 500)));
        await tx.run(INSERT.into(ConceptRank).entries(rankRows.slice(i, i + 500)));
      }

      // Instrument tx.run to capture CQN SELECT statements and their bound
      // `in`-list sizes. Any list of ≥500 items would blow HANA's packet cap.
      // Shared helper — see test/helpers/assert-no-oversized-in.js.
      const guard = instrumentInLimit(tx, { limit: 500 });

      try {
        // Should complete without throwing (would fail on HANA if regressed).
        const res = await recomputeSnapshot(tx);
        expect(res.count).toBe(0); // no editorial, no eligible KG candidates without tutorial links
      } finally {
        guard.restore();
      }

      expect(guard.oversized, `emitted oversized IN clause(s): ${JSON.stringify(guard.oversized)}`).toEqual([]);
    });
  });
});
