// test/unit/channel-detail-query.test.js
import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';
import { buildChannelDetailPayload } from '../../srv/lib/build-channel-detail.js';
import { titlePathToMdFormat } from '../../srv/lib/tag-md-format.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

describe('buildChannelDetailPayload', () => {
  let db;
  const TITLE_PATH = 'Software Product : SAP CAP';
  const md = titlePathToMdFormat(TITLE_PATH); // 'software-product>sap-cap'

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { Tags, Tutorials, TutorialTags, Channels, ChannelTopicMap } = cds.entities(NS);

    // Tag + tutorial → live tag surfaces for this titlePath
    await db.run(INSERT.into(Tags).entries([
      { ID: 'cdtag1', titlePath: TITLE_PATH, label: 'SAP CAP', name: 'sap-cap' },
    ]));
    await db.run(INSERT.into(Tutorials).entries([
      { ID: 'cdtut1', slug: 'cd-cap-intro', title: 'CAP Intro', experienceTag: 'Beginner' },
      { ID: 'cdtut2', slug: 'cd-cap-advanced', title: 'CAP Advanced', experienceTag: 'Advanced' },
    ]));
    await db.run(INSERT.into(TutorialTags).entries([
      { tutorial_ID: 'cdtut1', tag_ID: 'cdtag1' },
      { tutorial_ID: 'cdtut2', tag_ID: 'cdtag1' },
    ]));

    // Channel with slug (Phase 0 added slug column)
    await db.run(INSERT.into(Channels).entries([
      {
        ID: 'cdch1',
        sourceId: 'cd-test-channel',
        slug: 'sap-cap-channel',
        name: 'SAP CAP Channel',
        url: 'https://cap-channel.example',
        purpose: 'The CAP channel',
        ownerType: 'SAP_Official',
        isSapOwned: true,
        isPublished: true,
        linkStatus: 'OK',
      },
    ]));
    await db.run(INSERT.into(ChannelTopicMap).entries([
      { ID: cds.utils.uuid(), channel_ID: 'cdch1', topicTag: md, authoringStatus: 'REVIEWED', relevance: 90 },
    ]));

    // An unpublished channel — must NOT be resolved
    await db.run(INSERT.into(Channels).entries([
      {
        ID: 'cdch2',
        sourceId: 'cd-unpub-channel',
        slug: 'cd-unpub',
        name: 'Unpublished',
        url: 'https://unpub.example',
        ownerType: 'Community_Member',
        isSapOwned: false,
        isPublished: false,
        linkStatus: 'OK',
      },
    ]));
  });

  it('resolves channel by slug (lowercase) and returns topics with tutorialCount', async () => {
    const payload = await buildChannelDetailPayload(db, 'sap-cap-channel');
    expect(payload.notFound).toBeFalsy();
    expect(payload.slug).toBe('sap-cap-channel');
    expect(payload.name).toBe('SAP CAP Channel');
    expect(payload.topics.length).toBeGreaterThanOrEqual(1);
    const topic = payload.topics[0];
    expect(topic.tutorialCount).toBe(2); // two tutorials tagged with this topic
    expect(topic.slug).toBeTruthy();
    expect(typeof topic.relevance).toBe('number');
    expect(topic.label).toBe('SAP CAP'); // the exact label seeded for cdtag1
  });

  it('resolves channel by slug regardless of input case', async () => {
    const payload = await buildChannelDetailPayload(db, 'SAP-CAP-CHANNEL');
    expect(payload.notFound).toBeFalsy();
    expect(payload.slug).toBe('sap-cap-channel');
  });

  it('returns notFound:true for unknown slug', async () => {
    const payload = await buildChannelDetailPayload(db, 'does-not-exist-xyz');
    expect(payload.notFound).toBe(true);
  });

  it('returns notFound:true for unpublished channel', async () => {
    const payload = await buildChannelDetailPayload(db, 'cd-unpub');
    expect(payload.notFound).toBe(true);
  });

  it('includes buildAt ISO timestamp', async () => {
    const payload = await buildChannelDetailPayload(db, 'sap-cap-channel');
    expect(typeof payload.buildAt).toBe('string');
    expect(isNaN(new Date(payload.buildAt).getTime())).toBe(false);
  });

  it('resolves channel by sourceId fallback when slug is null', async () => {
    const { Channels, ChannelTopicMap } = cds.entities(NS);
    // Seed a channel with slug: null but known sourceId
    await db.run(INSERT.into(Channels).entries([
      {
        ID: 'cdch3',
        sourceId: 'cd-source-only-channel',
        slug: null,
        name: 'Source ID Channel',
        url: 'https://source-only.example',
        purpose: 'Resolved by sourceId',
        ownerType: 'SAP_Official',
        isSapOwned: true,
        isPublished: true,
        linkStatus: 'OK',
      },
    ]));
    await db.run(INSERT.into(ChannelTopicMap).entries([
      { ID: cds.utils.uuid(), channel_ID: 'cdch3', topicTag: md, authoringStatus: 'REVIEWED', relevance: 70 },
    ]));

    const payload = await buildChannelDetailPayload(db, 'cd-source-only-channel');
    expect(payload.notFound).toBeFalsy();
    expect(payload.name).toBe('Source ID Channel');
  });

  it('excludes non-REVIEWED topic mappings from topics array', async () => {
    const { Tags, Tutorials, TutorialTags, ChannelTopicMap } = cds.entities(NS);
    const TITLE_PATH_2 = 'Database : HANA';
    const md2 = titlePathToMdFormat(TITLE_PATH_2);

    // Seed a second tag and tutorial
    await db.run(INSERT.into(Tags).entries([
      { ID: 'cdtag2', titlePath: TITLE_PATH_2, label: 'SAP HANA', name: 'sap-hana' },
    ]));
    await db.run(INSERT.into(Tutorials).entries([
      { ID: 'cdtut3', slug: 'cd-hana-intro', title: 'HANA Intro', experienceTag: 'Beginner' },
    ]));
    await db.run(INSERT.into(TutorialTags).entries([
      { tutorial_ID: 'cdtut3', tag_ID: 'cdtag2' },
    ]));

    // Seed a DRAFT (non-REVIEWED) mapping for the main channel with the second topic
    await db.run(INSERT.into(ChannelTopicMap).entries([
      { ID: cds.utils.uuid(), channel_ID: 'cdch1', topicTag: md2, authoringStatus: 'DRAFT', relevance: 80 },
    ]));

    const payload = await buildChannelDetailPayload(db, 'sap-cap-channel');
    expect(payload.notFound).toBeFalsy();
    // Only REVIEWED rows should be in topics; DRAFT should be filtered out by the WHERE clause
    // So we should only see the REVIEWED row with md (relevance 90), not the DRAFT row with md2
    expect(payload.topics.length).toBe(1);
    expect(payload.topics[0].relevance).toBe(90);
    expect(payload.topics[0].label).toBe('SAP CAP');
  });
});
