// test/unit/media-diet-picks.test.js
//
// Tests the my-picks tag-derivation chain isolated from Express.
// We extract the core logic into a helper so it's testable without
// mounting a full server.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { mediaDietMyPicksLogic } from '../../srv/lib/media-diet-picks.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

describe('mediaDietMyPicksLogic', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { Users, Tags, Tutorials, TutorialTags, Channels, ChannelTopicMap, TaskRecords } = cds.entities(NS);

    // User row
    await db.run(INSERT.into(Users).entries([
      { ID: 'usr1', sapId: 'I000001', uuid: cds.utils.uuid(), legacyId: 9001, email: 'test@test.com', firstName: 'Test', lastName: 'User' },
    ]));

    // Tag + tutorial → Tutorial Tags
    await db.run(INSERT.into(Tags).entries([
      { ID: 'mdtag1', titlePath: 'Software Product : SAP BTP', label: 'SAP BTP', name: 'sap-btp' },
    ]));
    await db.run(INSERT.into(Tutorials).entries([
      { ID: 'mdtut1', slug: 'md-btp-intro', title: 'BTP Intro' },
    ]));
    await db.run(INSERT.into(TutorialTags).entries([
      { tutorial_ID: 'mdtut1', tag_ID: 'mdtag1' },
    ]));

    // TaskRecord: user completed this tutorial
    await db.run(INSERT.into(TaskRecords).entries([
      { ID: cds.utils.uuid(), user_ID: 'usr1', taskType: 'TUTORIAL', taskLegacyId: 1, status: 'COMPLETED' },
    ]));

    // But wait — TaskRecords.taskLegacyId links to Tutorials.legacyId; for simplicity
    // use a direct user_ID + tutorial join path. The logic resolves via Tutorials.ID.
    // We'll also seed via Tutorials.legacyId to match the real code path:
    await db.run(
      UPDATE(Tutorials).where({ ID: 'mdtut1' }).set({ legacyId: 1 }),
    );

    // Channel with REVIEWED ChannelTopicMap for this topic
    await db.run(INSERT.into(Channels).entries([
      {
        ID: 'mdch1', sourceId: 'md-btp-channel',
        slug: 'btp-channel',
        name: 'BTP Channel', url: 'https://btp-channel.example',
        ownerType: 'SAP_Official', isSapOwned: true,
        isPublished: true, linkStatus: 'OK',
        feedUrl: 'https://btp-channel.example/feed.xml',
      },
    ]));
    // titlePathToMdFormat('Software Product : SAP BTP') = 'software-product>sap-btp'
    const { titlePathToMdFormat } = await import('../../srv/lib/tag-md-format.js');
    const md = titlePathToMdFormat('Software Product : SAP BTP');
    await db.run(INSERT.into(ChannelTopicMap).entries([
      { ID: cds.utils.uuid(), channel_ID: 'mdch1', topicTag: md, authoringStatus: 'REVIEWED', relevance: 85 },
    ]));
  });

  it('returns ranked channels for a user with completions', async () => {
    const result = await mediaDietMyPicksLogic(db, 'I000001');
    expect(result.source).toBe('completions');
    expect(result.channels.length).toBeGreaterThanOrEqual(1);
    expect(result.channels[0].name).toBe('BTP Channel');
  });

  it('returns empty + no-data source when user has no completions', async () => {
    const result = await mediaDietMyPicksLogic(db, 'I000002-nonexistent');
    expect(result.channels).toEqual([]);
    expect(result.source).toBe('no-data');
  });

  it('result channel entries have required fields', async () => {
    const result = await mediaDietMyPicksLogic(db, 'I000001');
    const ch = result.channels[0];
    expect(ch).toHaveProperty('ID');
    expect(ch).toHaveProperty('name');
    expect(ch).toHaveProperty('url');
    expect(ch).toHaveProperty('ownerType');
    expect(ch).toHaveProperty('isSapOwned');
    // feedUrl may be null or a string (nullable column)
    expect('feedUrl' in ch).toBe(true);
  });
});
