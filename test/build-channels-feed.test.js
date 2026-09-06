// test/build-channels-feed.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

describe('GET /build/channels', () => {
  beforeAll(async () => {
    const { Channels } = linked();
    await INSERT.into(Channels).entries([
      { ID: cds.utils.uuid(), sourceId: 'feed-pub', name: 'Pub', url: 'https://pub', isPublished: true, linkStatus: 'OK', focusAreas: ['btp'] },
      { ID: cds.utils.uuid(), sourceId: 'feed-unpub', name: 'Unpub', url: 'https://unpub', isPublished: false, linkStatus: 'OK' },
      { ID: cds.utils.uuid(), sourceId: 'feed-broken', name: 'Broken', url: 'https://broken', isPublished: true, linkStatus: 'BROKEN' },
    ]);
  });
  afterAll(async () => {
    await DELETE.from(linked().Channels).where({ sourceId: { in: ['feed-pub', 'feed-unpub', 'feed-broken'] } });
  });

  it('returns only published, non-broken channels with parsed arrays', async () => {
    const { status, data } = await project.get('/build/channels');
    expect(status).toBe(200);
    const urls = data.channels.map((c) => c.url);
    expect(urls).toContain('https://pub');
    expect(urls).not.toContain('https://unpub');
    expect(urls).not.toContain('https://broken');
    const pub = data.channels.find((c) => c.url === 'https://pub');
    expect(pub.focusAreas).toEqual(['btp']);
    expect(typeof data.buildAt).toBe('string');
  });

  it('projects a public whitelist — no audit / internal curation columns', async () => {
    const { data } = await project.get('/build/channels');
    const pub = data.channels.find((c) => c.url === 'https://pub');
    for (const internal of ['sourceId', 'contentHash', 'ingestBatch', 'linkStatusOverride', 'isFeatured', 'notes', 'aliases', 'createdBy', 'modifiedBy', 'createdAt', 'modifiedAt']) {
      expect(pub, `feed leaked internal column "${internal}"`).not.toHaveProperty(internal);
    }
    // consumed public fields are present
    for (const pubfield of ['name', 'url', 'category', 'status', 'ownerType', 'focusAreas']) {
      expect(pub).toHaveProperty(pubfield);
    }
  });
});
