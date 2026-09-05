// srv/lib/channels/__tests__/seed-channel-topic-map.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { draftChannelTopicMap, seedChannelTopicMap } from '../seed-channel-topic-map.cjs';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

// Deterministic fake LLM: maps each channel's first focusArea to a topicTag.
const fakeLlm = async (channels /*, topicTags */) =>
  channels.map((c, i) => ({
    sourceId: c.sourceId,
    topicTag: `software-product>${(c.focusAreas && c.focusAreas[0]) || 'general'}`,
    relevance: 90 - i * 10,
  }));

describe('draftChannelTopicMap', () => {
  it('turns channels into crosswalk drafts via the injected llm', async () => {
    const drafts = await draftChannelTopicMap(
      [{ sourceId: 's1', name: 'CAP', focusAreas: ['cap'] }],
      ['software-product>cap'],
      { llm: fakeLlm },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ sourceId: 's1', topicTag: 'software-product>cap', relevance: 90 });
  });
});

describe('seedChannelTopicMap', () => {
  beforeAll(async () => {
    const { Channels } = linked();
    await INSERT.into(Channels).entries([
      { ID: cds.utils.uuid(), sourceId: 'stm-cap', name: 'CAP', url: 'https://stm-cap', isPublished: true, focusAreas: ['cap'] },
      { ID: cds.utils.uuid(), sourceId: 'stm-ai', name: 'AI', url: 'https://stm-ai', isPublished: true, focusAreas: ['ai'] },
    ]);
  });
  afterAll(async () => {
    await DELETE.from(linked().ChannelTopicMap);
    await DELETE.from(linked().Channels).where({ sourceId: { in: ['stm-cap', 'stm-ai'] } });
  });

  it('inserts AI_SEEDED rows, is idempotent, and preserves REVIEWED', async () => {
    const db = await cds.connect.to('db');
    const first = await seedChannelTopicMap(db, { commit: true, llm: fakeLlm });
    expect(first.created).toBeGreaterThan(0);

    const { Channels, ChannelTopicMap } = linked();
    const cap = await SELECT.one.from(Channels).where({ sourceId: 'stm-cap' });
    const row = await SELECT.one.from(ChannelTopicMap).where({ channel_ID: cap.ID });
    expect(row.authoringStatus).toBe('AI_SEEDED');

    // Curator reviews it (and bumps relevance):
    await UPDATE(ChannelTopicMap).set({ authoringStatus: 'REVIEWED', relevance: 100 }).where({ ID: row.ID });

    // Re-run: reviewed row preserved.
    const second = await seedChannelTopicMap(db, { commit: true, llm: fakeLlm });
    expect(second.skippedReviewed).toBeGreaterThan(0);
    const preserved = await SELECT.one.from(ChannelTopicMap).where({ ID: row.ID });
    expect(preserved.authoringStatus).toBe('REVIEWED');
    expect(preserved.relevance).toBe(100);
  });
});
