// test/build-channel-collections-feed.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);
let colPub, colUnpub, colDraft, chPub, chBroken;

describe('GET /build/channel-collections', () => {
  beforeAll(async () => {
    const { ChannelCollections, ChannelCollectionItems, Channels } = linked();
    chPub = cds.utils.uuid(); chBroken = cds.utils.uuid();
    await INSERT.into(Channels).entries([
      { ID: chPub, sourceId: 'ccf-pub', name: 'Pub', url: 'https://ccf-pub', isPublished: true, linkStatus: 'OK' },
      { ID: chBroken, sourceId: 'ccf-broken', name: 'Broken', url: 'https://ccf-broken', isPublished: true, linkStatus: 'BROKEN' },
    ]);
    colPub = cds.utils.uuid(); colUnpub = cds.utils.uuid(); colDraft = cds.utils.uuid();
    await INSERT.into(ChannelCollections).entries([
      { ID: colPub, slug: 'ccf-live', title: 'Live', intro: 'Intro', sortOrder: 10, isPublished: true, authoringStatus: 'REVIEWED' },
      { ID: colUnpub, slug: 'ccf-unpub', title: 'Unpub', sortOrder: 20, isPublished: false, authoringStatus: 'REVIEWED' },
      { ID: colDraft, slug: 'ccf-draft', title: 'Draft', sortOrder: 30, isPublished: true, authoringStatus: 'AI_SEEDED' },
    ]);
    await INSERT.into(ChannelCollectionItems).entries([
      { ID: cds.utils.uuid(), collection_ID: colPub, channel_ID: chPub, sortOrder: 5, blurb: 'first' },
      { ID: cds.utils.uuid(), collection_ID: colPub, channel_ID: chBroken, sortOrder: 6 },
    ]);
  });
  afterAll(async () => {
    await DELETE.from(linked().ChannelCollectionItems);
    await DELETE.from(linked().ChannelCollections).where({ slug: { in: ['ccf-live', 'ccf-unpub', 'ccf-draft'] } });
    await DELETE.from(linked().Channels).where({ sourceId: { in: ['ccf-pub', 'ccf-broken'] } });
  });

  it('returns only published + REVIEWED collections with published, non-broken items', async () => {
    const { status, data } = await project.get('/build/channel-collections');
    expect(status).toBe(200);
    const slugs = data.collections.map((c) => c.slug);
    expect(slugs).toContain('ccf-live');
    expect(slugs).not.toContain('ccf-unpub');   // not published
    expect(slugs).not.toContain('ccf-draft');   // not REVIEWED
    const live = data.collections.find((c) => c.slug === 'ccf-live');
    expect(live.title).toBe('Live');
    const itemUrls = live.items.map((i) => i.url);
    expect(itemUrls).toContain('https://ccf-pub');
    expect(itemUrls).not.toContain('https://ccf-broken'); // broken item filtered
    expect(live.items[0].blurb).toBe('first');
    expect(typeof data.buildAt).toBe('string');
  });
});
