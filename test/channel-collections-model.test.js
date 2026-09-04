// test/channel-collections-model.test.js
import cds from '@sap/cds';
import { describe, it, expect, afterAll } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

describe('ChannelCollections model', () => {
  afterAll(async () => {
    await DELETE.from(linked().ChannelCollectionItems);
    await DELETE.from(linked().ChannelCollections).where({ slug: { in: ['t-getting-started', 't-empty'] } });
  });

  it('persists a collection with ordered items linked to channels', async () => {
    const { ChannelCollections, ChannelCollectionItems, Channels } = linked();
    const chId = cds.utils.uuid();
    await INSERT.into(Channels).entries([
      { ID: chId, sourceId: 'cc-model-ch', name: 'CAP Docs', url: 'https://cc-model-cap', isPublished: true },
    ]);
    const colId = cds.utils.uuid();
    await INSERT.into(ChannelCollections).entries([
      { ID: colId, slug: 't-getting-started', title: 'Getting Started', intro: 'Start here.', sortOrder: 10, isPublished: true, authoringStatus: 'REVIEWED' },
    ]);
    await INSERT.into(ChannelCollectionItems).entries([
      { ID: cds.utils.uuid(), collection_ID: colId, channel_ID: chId, sortOrder: 5, blurb: 'Read first' },
    ]);

    const col = await SELECT.one.from(ChannelCollections).where({ slug: 't-getting-started' });
    expect(col.title).toBe('Getting Started');
    expect(col.authoringStatus).toBe('REVIEWED');
    const items = await SELECT.from(ChannelCollectionItems).where({ collection_ID: colId });
    expect(items).toHaveLength(1);
    expect(items[0].channel_ID).toBe(chId);
    expect(items[0].blurb).toBe('Read first');

    await DELETE.from(Channels).where({ sourceId: 'cc-model-ch' });
  });

  it('defaults authoringStatus to BLANK and isPublished to false', async () => {
    const { ChannelCollections } = linked();
    const colId = cds.utils.uuid();
    await INSERT.into(ChannelCollections).entries([{ ID: colId, slug: 't-empty', title: 'Empty' }]);
    const col = await SELECT.one.from(ChannelCollections).where({ ID: colId });
    expect(col.authoringStatus).toBe('BLANK');
    expect(col.isPublished).toBe(false);
  });
});
