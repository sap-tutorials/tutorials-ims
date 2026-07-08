// test/unit/homepage-service-endpoints.test.js
// Tests for HomepageService (#639) — verifies each endpoint returns the documented shape.

import { describe, it, expect, beforeAll } from 'vitest';
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

  it('events() queries CommunityEvents and returns mapped rows (#1030)', async () => {
    // Bust the 60s module cache populated by the previous test.
    resetHomepageCaches();

    const db = await cds.connect.to('db');
    const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await db.run(INSERT.into(CommunityEvents).entries({
      ID: cds.utils.uuid(),
      title: '__TEST__ Future CodeJam',
      startDate: tomorrow,
      eventType: 'codejam',
      region: 'EMEA',
      virtualOrInPerson: 'in-person',
    }));

    const out = await svc.send('events', {});
    expect(Array.isArray(out)).toBe(true);
    const synthetic = out.find(e => e.title === '__TEST__ Future CodeJam');
    // If this assertion fails, the CDS QL .where() syntax in homepage-service.js
    // is broken or the CommunityEvents entity is not being queried.
    expect(synthetic).toBeTruthy();
    expect(synthetic.format).toBe('codejam');
    expect(synthetic.region).toBe('EMEA');
    expect(synthetic.isVirtual).toBe(false);
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

