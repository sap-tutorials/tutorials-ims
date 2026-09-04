// srv/lib/channels/__tests__/seed-collections.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { draftCollections, seedCollections } from '../seed-collections.js';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

// Deterministic fake LLM: clusters by first focus area.
const fakeLlm = async (channels) => {
  const byFocus = {};
  for (const c of channels) {
    const key = (c.focusAreas && c.focusAreas[0]) || 'general';
    (byFocus[key] ||= []).push(c);
  }
  return Object.entries(byFocus).map(([focus, chs], i) => ({
    slug: `auto-${focus}`, title: `All about ${focus}`, intro: `Curated ${focus} channels.`, sortOrder: (i + 1) * 10,
    items: chs.map((c, j) => ({ sourceId: c.sourceId, blurb: `${c.name} matters`, sortOrder: (j + 1) * 10 })),
  }));
};

describe('draftCollections', () => {
  it('turns channels into collection drafts via the injected llm', async () => {
    const drafts = await draftCollections(
      [{ sourceId: 's1', name: 'CAP', focusAreas: ['cap'] }, { sourceId: 's2', name: 'RAP', focusAreas: ['cap'] }],
      { llm: fakeLlm },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].slug).toBe('auto-cap');
    expect(drafts[0].items).toHaveLength(2);
  });
});

describe('seedCollections', () => {
  let s1, s2;
  beforeAll(async () => {
    const { Channels } = linked();
    s1 = cds.utils.uuid(); s2 = cds.utils.uuid();
    await INSERT.into(Channels).entries([
      { ID: s1, sourceId: 'sc-cap', name: 'CAP', url: 'https://sc-cap', isPublished: true, focusAreas: ['cap'] },
      { ID: s2, sourceId: 'sc-ai', name: 'AI', url: 'https://sc-ai', isPublished: true, focusAreas: ['ai'] },
    ]);
  });
  afterAll(async () => {
    await DELETE.from(linked().ChannelCollectionItems);
    await DELETE.from(linked().ChannelCollections).where({ slug: { like: 'auto-%' } });
    await DELETE.from(linked().Channels).where({ sourceId: { in: ['sc-cap', 'sc-ai'] } });
  });

  it('inserts AI_SEEDED collections and is idempotent, preserving REVIEWED', async () => {
    const db = await cds.connect.to('db');
    const first = await seedCollections(db, { commit: true, llm: fakeLlm });
    expect(first.created).toBeGreaterThan(0);
    const { ChannelCollections } = linked();
    const capCol = await SELECT.one.from(ChannelCollections).where({ slug: 'auto-cap' });
    expect(capCol.authoringStatus).toBe('AI_SEEDED');

    // Curator reviews it:
    await UPDATE(ChannelCollections).set({ authoringStatus: 'REVIEWED', title: 'Human title' }).where({ slug: 'auto-cap' });

    // Re-run: reviewed row is preserved untouched, others re-drafted.
    const second = await seedCollections(db, { commit: true, llm: fakeLlm });
    expect(second.skippedReviewed).toBeGreaterThan(0);
    const preserved = await SELECT.one.from(ChannelCollections).where({ slug: 'auto-cap' });
    expect(preserved.title).toBe('Human title');
    expect(preserved.authoringStatus).toBe('REVIEWED');
  });
});
