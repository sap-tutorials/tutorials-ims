// test/unit/homepage-service-endpoints.test.js
// Tests for HomepageService (#639) — verifies each endpoint returns the documented shape.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { _resetForTests as resetHomepageCaches } from '../../srv/homepage-service.js';

cds.test('serve', '--project', '.', '--in-memory');

describe('HomepageService endpoints', () => {
  let svc;
  beforeAll(async () => {
    process.env.YOUTUBE_API_KEY = '';  // exercise the no-key fallback path
    svc = await cds.connect.to('HomepageService');
  });

  it('events() returns array', async () => {
    const out = await svc.send('events', {});
    expect(Array.isArray(out)).toBe(true);
  });

  it('events() queries the Events DB entity and returns mapped rows', async () => {
    // Bust the 60s module cache populated by the previous test (which ran against
    // an empty Events table). Without this the new row is invisible until TTL expiry.
    resetHomepageCaches();

    const db = await cds.connect.to('db');
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    await db.run(INSERT.into('com.sap.developers.ims.Events').entries({
      ID: cds.utils.uuid(),
      name: '__TEST__ Future event',
      startDate: tomorrow,
      eventType: 'CODEJAM',
    }));

    const out = await svc.send('events', {});
    expect(Array.isArray(out)).toBe(true);
    const synthetic = out.find(e => e.title === '__TEST__ Future event');
    // If this assertion fails, the CDS QL .where() syntax in homepage-service.js
    // is broken again — the prior `.where('startDate >= ?', ...)` raw-placeholder
    // form threw at parse time and the catch path silently returned [].
    expect(synthetic).toBeTruthy();
    expect(synthetic.format).toBe('CODEJAM');
  });

  it('videos() returns shape { featured, recent, error }', async () => {
    const out = await svc.send('videos', {});
    expect(out).toHaveProperty('featured');
    expect(out).toHaveProperty('recent');
    expect(out).toHaveProperty('error');
    // With YOUTUBE_API_KEY='', the error should be 'no-api-key'.
    expect(out.error).toBe('no-api-key');
  });

  // (#1007) When the YouTube live path returns error/empty AND ext.Videos has
  // rows, videos() must promote them into `recent` (and lift the newest into
  // `featured`) so the homepage band never renders empty after a srv restart.
  // The in-memory 15-min cache in youtube-fetcher.js dies with the process,
  // so the persistent Videos corpus is the only durable fallback we have.
  it('videos() falls back to ext.Videos when the live YouTube call fails', async () => {
    resetHomepageCaches();
    const db = await cds.connect.to('db');
    const { Videos } = cds.entities('com.sap.developers.ims.external');
    // Seed three rows. Newest publishedAt should end up as `featured`.
    await db.run(INSERT.into(Videos).entries([
      { ID: cds.utils.uuid(), slug: 'vd-fb1', youtubeVideoId: 'fb1', title: 'Fallback newest',
        url: 'https://youtube.com/watch?v=fb1', publishedAt: '2026-07-01T00:00:00Z',
        thumbnailUrl: 'https://yt/fb1.jpg', channelTitle: 'SAP Developers' },
      { ID: cds.utils.uuid(), slug: 'vd-fb2', youtubeVideoId: 'fb2', title: 'Fallback middle',
        url: 'https://youtube.com/watch?v=fb2', publishedAt: '2026-06-15T00:00:00Z',
        thumbnailUrl: 'https://yt/fb2.jpg', channelTitle: 'SAP Developers' },
      { ID: cds.utils.uuid(), slug: 'vd-fb3', youtubeVideoId: 'fb3', title: 'Fallback oldest',
        url: 'https://youtube.com/watch?v=fb3', publishedAt: '2026-06-01T00:00:00Z',
        thumbnailUrl: 'https://yt/fb3.jpg', channelTitle: 'SAP Developers' },
    ]));

    const out = await svc.send('videos', {});
    expect(out.recent).toHaveLength(3);
    // publishedAt DESC ordering — newest first
    expect(out.recent[0].videoId).toBe('fb1');
    expect(out.recent[1].videoId).toBe('fb2');
    expect(out.recent[2].videoId).toBe('fb3');
    // featured promoted from the newest row (live path returned no featured)
    expect(out.featured?.videoId).toBe('fb1');
    // Live error is passed through so the client (and its metrics) can see it
    expect(out.error).toBe('no-api-key');
  });

  it('shelves({ verb: LEARN }) returns shelves for that verb', async () => {
    const out = await svc.send('shelves', { verb: 'LEARN' });
    expect(Array.isArray(out)).toBe(true);
    // In-memory SQLite has no seed data for LEARN verb so result may be empty,
    // but any row that IS returned must have verb === 'LEARN'.
    expect(out.every(s => s.verb === 'LEARN')).toBe(true);
  });

  it('communityBlogs() returns array', async () => {
    const out = await svc.send('communityBlogs', {});
    expect(Array.isArray(out)).toBe(true);
  });

  it('news() returns array', async () => {
    const out = await svc.send('news', {});
    expect(Array.isArray(out)).toBe(true);
  });
});

describe('/homepage/videos merges anchors + rotation (#1031)', () => {
  const NS_EXT = 'com.sap.developers.ims.external';
  const NS = 'com.sap.developers.ims';
  const HOMEPAGE_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ae';

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    await db.run(DELETE.from(`${NS}.HomepageVideoRotation`));
    await db.run(DELETE.from(`${NS_EXT}.Videos`));
    await db.run(DELETE.from(`${NS}.HomepageConfig`));
    await UPSERT.into(`${NS}.HomepageConfig`).entries({
      ID: HOMEPAGE_CONFIG_SINGLETON_ID,
      videoBandEnabled: true,
      videoBandAnchorCount: 3,
      videoBandRotationCount: 3,
    });
  });

  async function seed(videoId, daysAgo) {
    await INSERT.into(`${NS_EXT}.Videos`).entries({
      slug: `vd-${videoId}`, title: `V-${videoId}`, description: '',
      url: '', youtubeVideoId: videoId,
      publishedAt: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
      channelTitle: 'SAP Developers', thumbnailUrl: `https://y/${videoId}.jpg`,
      sourceId: videoId, contentHash: `h-${videoId}`, viewCount: 0,
      excludeFromHomepage: false,
    });
    return SELECT.one.from(`${NS_EXT}.Videos`).columns('ID').where({ youtubeVideoId: videoId });
  }

  it('returns anchors tagged kind=anchor and rotation tagged kind=popular', async () => {
    await seed('newest1', 1);
    await seed('newest2', 2);
    await seed('newest3', 3);
    const pop1 = await seed('pop1', 30);
    const pop2 = await seed('pop2', 60);
    await INSERT.into(`${NS}.HomepageVideoRotation`).entries([
      { video_ID: pop1.ID, rank: 1 },
      { video_ID: pop2.ID, rank: 2 },
    ]);

    const srv = await cds.connect.to('HomepageService');
    const res = await srv.send('videos');
    const anchors = res.recent.filter(r => r.kind === 'anchor');
    const populars = res.recent.filter(r => r.kind === 'popular');
    expect(anchors.map(a => a.videoId)).toEqual(['newest1', 'newest2', 'newest3']);
    expect(populars.map(p => p.videoId)).toEqual(['pop1', 'pop2']);
  });

  it('dedupes rotation entries that are already in anchors', async () => {
    const a = await seed('shared', 1);
    await seed('newest2', 2);
    await seed('newest3', 3);
    await INSERT.into(`${NS}.HomepageVideoRotation`).entries([
      { video_ID: a.ID, rank: 1 },
    ]);

    const srv = await cds.connect.to('HomepageService');
    const res = await srv.send('videos');
    const ids = res.recent.map(r => r.videoId);
    expect(new Set(ids).size).toBe(ids.length);       // no dupes
    expect(ids.filter(x => x === 'shared')).toHaveLength(1);
    expect(res.recent.find(r => r.videoId === 'shared').kind).toBe('anchor');
  });

  it('honors excludeFromHomepage on both anchors and rotation', async () => {
    const db = await cds.connect.to('db');
    const excluded = await seed('excluded', 1);
    await db.run(UPDATE(`${NS_EXT}.Videos`).set({ excludeFromHomepage: true }).where({ ID: excluded.ID }));
    await seed('keep1', 5);

    const srv = await cds.connect.to('HomepageService');
    const res = await srv.send('videos');
    expect(res.recent.find(r => r.videoId === 'excluded')).toBeUndefined();
  });

  it('when videoBandRotationCount = 0, returns anchors only', async () => {
    const db = await cds.connect.to('db');
    await db.run(UPDATE(`${NS}.HomepageConfig`).set({ videoBandAnchorCount: 1, videoBandRotationCount: 0 })
      .where({ ID: HOMEPAGE_CONFIG_SINGLETON_ID }));
    await seed('a', 1);
    const pop = await seed('p', 30);
    await INSERT.into(`${NS}.HomepageVideoRotation`).entries([{ video_ID: pop.ID, rank: 1 }]);

    const srv = await cds.connect.to('HomepageService');
    const res = await srv.send('videos');
    expect(res.recent.map(r => r.videoId)).toEqual(['a']);
    expect(res.recent.every(r => r.kind === 'anchor')).toBe(true);
  });
});

