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
    const ids = data.channels.map((c) => c.sourceId);
    expect(ids).toContain('feed-pub');
    expect(ids).not.toContain('feed-unpub');
    expect(ids).not.toContain('feed-broken');
    const pub = data.channels.find((c) => c.sourceId === 'feed-pub');
    expect(pub.focusAreas).toEqual(['btp']);
    expect(typeof data.buildAt).toBe('string');
  });
});
