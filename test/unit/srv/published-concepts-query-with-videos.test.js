import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { buildConceptsPayload } from '../../../srv/lib/published-concepts-query.js';

describe('buildConceptsPayload — videos field (Phase 4.4)', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { Videos, VideoConceptLinks } =
      cds.entities('com.sap.developers.ims.external');

    const now = new Date().toISOString();
    await INSERT.into(Concepts).entries([
      { slug: 'cap-handlers', name: 'CAP handlers', description: 'd',
        status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c' },
      { slug: 'no-video', name: 'No Video', description: 'd',
        status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c' },
    ]);
    const conceptRow = await SELECT.one.from(Concepts).columns('ID').where({ slug: 'cap-handlers' });

    await INSERT.into(Videos).entries([
      { slug: 'vd-old00000',
        title: 'Older Video',
        url: 'https://www.youtube.com/watch?v=old00000',
        youtubeVideoId: 'old00000',
        publishedAt: '2026-05-01T10:00:00.000Z',
        channelTitle: 'SAP Developers',
        thumbnailUrl: 'https://i.ytimg.com/vi/old00000/hqdefault.jpg',
        description: 'older desc' },
      { slug: 'vd-new00000',
        title: 'Newer Video',
        url: 'https://www.youtube.com/watch?v=new00000',
        youtubeVideoId: 'new00000',
        publishedAt: '2026-06-15T10:00:00.000Z',
        channelTitle: 'SAP Developers',
        thumbnailUrl: 'https://i.ytimg.com/vi/new00000/hqdefault.jpg',
        description: 'newer desc' },
    ]);
    const v1 = await SELECT.one.from(Videos).columns('ID').where({ slug: 'vd-old00000' });
    const v2 = await SELECT.one.from(Videos).columns('ID').where({ slug: 'vd-new00000' });

    await INSERT.into(VideoConceptLinks).entries([
      { video_ID: v1.ID, concept_ID: conceptRow.ID,
        predicate: 'teaches', confidence: 0.9 },
      { video_ID: v2.ID, concept_ID: conceptRow.ID,
        predicate: 'teaches', confidence: 0.85 },
    ]);
  });

  afterAll(async () => { await cds.disconnect(); });

  it('every concept has a videos array (empty when none)', async () => {
    const payload = await buildConceptsPayload(cds.db);
    for (const c of payload.concepts) {
      expect(Array.isArray(c.videos)).toBe(true);
    }
  });

  it('populates videos sorted by publishedAt desc (newest first), with full shape', async () => {
    const payload = await buildConceptsPayload(cds.db);
    const ch = payload.concepts.find(c => c.slug === 'cap-handlers');
    expect(ch.videos).toHaveLength(2);
    expect(ch.videos[0].slug).toBe('vd-new00000');  // newest first
    expect(ch.videos[1].slug).toBe('vd-old00000');
    expect(ch.videos[0]).toMatchObject({
      slug: 'vd-new00000',
      title: 'Newer Video',
      url: 'https://www.youtube.com/watch?v=new00000',
      thumbnailUrl: 'https://i.ytimg.com/vi/new00000/hqdefault.jpg',
      channelTitle: 'SAP Developers',
    });
    expect(ch.videos[0].publishedAt).toBeTruthy();
  });

  it('returns empty videos[] for concepts with no linked videos', async () => {
    const payload = await buildConceptsPayload(cds.db);
    const nv = payload.concepts.find(c => c.slug === 'no-video');
    expect(nv.videos).toEqual([]);
  });
});
