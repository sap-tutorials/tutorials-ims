// test/unit/topics-query-channels.test.js
// Surface C (P3) — relatedChannels in the topic detail payload.
import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';
import { buildTopicDetailPayload } from '../../srv/lib/topics-query.js';
import { titlePathToMdFormat } from '../../srv/lib/tag-md-format.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

describe('topics-query — relatedChannels (Surface C)', () => {
  let db;
  const TITLE_PATH = 'Software Product : SAP HANA Cloud';
  // titlePathToMdFormat('Software Product : SAP HANA Cloud') → 'software-product>sap-hana-cloud'
  const md = titlePathToMdFormat(TITLE_PATH);

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { Tags, Tutorials, TutorialTags, Channels, ChannelTopicMap } = cds.entities(NS);

    // Seed tag + tutorial so loadLiveTags surfaces this topic slug.
    await db.run(INSERT.into(Tags).entries([
      { ID: 'ctag1', titlePath: TITLE_PATH, label: 'SAP HANA Cloud', name: 'sap-hana-cloud' },
    ]));
    await db.run(INSERT.into(Tutorials).entries([
      { ID: 'ctut1', slug: 'ch-hana-intro', title: 'CH HANA Intro', experienceTag: 'Beginner' },
    ]));
    await db.run(INSERT.into(TutorialTags).entries([
      { tutorial_ID: 'ctut1', tag_ID: 'ctag1' },
    ]));

    // Channel 1: REVIEWED + published + non-broken → MUST appear in relatedChannels.
    const ch1Id = cds.utils.uuid();
    await db.run(INSERT.into(Channels).entries([
      {
        ID: ch1Id, sourceId: 'test-reviewed-ch',
        name: 'Reviewed Channel', url: 'https://reviewed-ch',
        ownerType: 'Community_Member', isSapOwned: false,
        isPublished: true, linkStatus: 'OK',
      },
    ]));
    await db.run(INSERT.into(ChannelTopicMap).entries([
      { ID: cds.utils.uuid(), channel_ID: ch1Id, topicTag: md, authoringStatus: 'REVIEWED', relevance: 80 },
    ]));

    // Channel 2: AI_SEEDED → must NOT appear (wrong authoringStatus).
    const ch2Id = cds.utils.uuid();
    await db.run(INSERT.into(Channels).entries([
      {
        ID: ch2Id, sourceId: 'test-ai-ch',
        name: 'AI Channel', url: 'https://ai-ch',
        ownerType: 'Community_Member', isSapOwned: false,
        isPublished: true, linkStatus: 'OK',
      },
    ]));
    await db.run(INSERT.into(ChannelTopicMap).entries([
      { ID: cds.utils.uuid(), channel_ID: ch2Id, topicTag: md, authoringStatus: 'AI_SEEDED', relevance: 90 },
    ]));

    // Channel 3: REVIEWED but isPublished: false → must NOT appear (unpublished channel).
    const ch3Id = cds.utils.uuid();
    await db.run(INSERT.into(Channels).entries([
      {
        ID: ch3Id, sourceId: 'test-unpub-ch',
        name: 'Unpublished Channel', url: 'https://unpublished-ch',
        ownerType: 'SAP_Official', isSapOwned: true,
        isPublished: false, linkStatus: 'OK',
      },
    ]));
    await db.run(INSERT.into(ChannelTopicMap).entries([
      { ID: cds.utils.uuid(), channel_ID: ch3Id, topicTag: md, authoringStatus: 'REVIEWED', relevance: 70 },
    ]));
  });

  it('relatedChannels contains only REVIEWED + published + non-broken channels', async () => {
    const payload = await buildTopicDetailPayload(db, 'software-product-sap-hana-cloud');
    expect(payload.error).toBeFalsy();
    expect(payload.relatedChannels.map((c) => c.url)).toEqual(['https://reviewed-ch']);
    expect(payload.relatedChannels[0]).toMatchObject({ ownerType: 'Community_Member', relevance: 80 });
  });

  it('relatedChannels is an empty array on notFound topic', async () => {
    const payload = await buildTopicDetailPayload(db, 'does-not-exist-channels-test');
    expect(payload.notFound).toBe(true);
    expect(payload.relatedChannels).toEqual([]);
  });
});

describe('topics-query — Direction 1 dark-code regression net', () => {
  // Uses the same fixtures seeded in the outer beforeAll above.
  // Purpose: ensure relatedChannels lights up in the topic payload once REVIEWED
  // rows are present, so future refactors can't silently darken it again.
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  it('returns at least one relatedChannel entry when REVIEWED ChannelTopicMap rows exist', async () => {
    const payload = await buildTopicDetailPayload(db, 'software-product-sap-hana-cloud');
    expect(payload.relatedChannels.length).toBeGreaterThanOrEqual(1);
  });

  it('relatedChannels entries include name, url, ownerType, isSapOwned, relevance fields', async () => {
    const payload = await buildTopicDetailPayload(db, 'software-product-sap-hana-cloud');
    const ch = payload.relatedChannels[0];
    expect(ch).toHaveProperty('name');
    expect(ch).toHaveProperty('url');
    expect(ch).toHaveProperty('ownerType');
    expect(ch).toHaveProperty('isSapOwned');
    expect(ch).toHaveProperty('relevance');
  });
});
