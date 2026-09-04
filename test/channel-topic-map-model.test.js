import cds from '@sap/cds';
import { describe, it, expect, afterAll } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

describe('ChannelTopicMap model', () => {
  afterAll(async () => {
    await DELETE.from(linked().ChannelTopicMap);
    await DELETE.from(linked().Channels).where({ sourceId: { like: 'ctm-%' } });
  });

  it('persists a crosswalk row joined to a Channel with an mdFormat topicTag', async () => {
    const { Channels, ChannelTopicMap } = linked();
    const chId = cds.utils.uuid();
    await INSERT.into(Channels).entries({
      ID: chId, sourceId: 'ctm-cap', name: 'CAP Docs', url: 'https://cap.cloud.sap', isPublished: true,
    });
    const rowId = cds.utils.uuid();
    await INSERT.into(ChannelTopicMap).entries({
      ID: rowId, channel_ID: chId, topicTag: 'software-product>sap-btp', relevance: 80, authoringStatus: 'REVIEWED',
    });
    const row = await SELECT.one.from(ChannelTopicMap).where({ ID: rowId });
    expect(row.channel_ID).toBe(chId);
    expect(row.topicTag).toBe('software-product>sap-btp');
    expect(row.relevance).toBe(80);
    expect(row.authoringStatus).toBe('REVIEWED');
  });

  it('defaults relevance=50 and authoringStatus=AI_SEEDED', async () => {
    const { Channels, ChannelTopicMap } = linked();
    const chId = cds.utils.uuid();
    await INSERT.into(Channels).entries({ ID: chId, sourceId: 'ctm-def', name: 'D', url: 'https://d', isPublished: true });
    const rowId = cds.utils.uuid();
    await INSERT.into(ChannelTopicMap).entries({ ID: rowId, channel_ID: chId, topicTag: 'software-product>x' });
    const row = await SELECT.one.from(ChannelTopicMap).where({ ID: rowId });
    expect(row.relevance).toBe(50);
    expect(row.authoringStatus).toBe('AI_SEEDED');
  });
});
