// test/unit/srv/featured-topics-snapshot.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

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
});
