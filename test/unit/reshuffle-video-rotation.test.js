// test/unit/reshuffle-video-rotation.test.js
//
// (#1031) Unit tests for the reshuffle-video-rotation cron body.
// Uses an in-memory SQLite backend via cds.test('serve') so the test
// exercises the same CDS QL path as HANA (bounded SELECTs; no LOB columns).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const NS_EXT = 'com.sap.developers.ims.external';
const NS = 'com.sap.developers.ims';
const HOMEPAGE_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ae';

async function seedVideo(db, videoId, publishedDaysAgo, viewCount, opts = {}) {
  const { Videos } = cds.entities(NS_EXT);
  const publishedAt = new Date(Date.now() - publishedDaysAgo * 86400_000).toISOString();
  await INSERT.into(Videos).entries({
    slug: `vd-${videoId}`,
    title: `Video ${videoId}`,
    description: '',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    youtubeVideoId: videoId,
    publishedAt,
    channelTitle: 'SAP Developers',
    thumbnailUrl: '',
    sourceId: videoId,
    contentHash: `hash-${videoId}`,
    viewCount: viewCount,
    likeCount: 0,
    commentCount: 0,
    statsLastFetchedAt: new Date().toISOString(),
    excludeFromHomepage: opts.excluded ?? false,
  });
}

async function seedConfig(db, overrides = {}) {
  const { HomepageConfig } = cds.entities(NS);
  await UPSERT.into(HomepageConfig).entries({
    ID: HOMEPAGE_CONFIG_SINGLETON_ID,
    videoBandEnabled: true,
    videoBandAnchorCount: 3,
    videoBandRotationCount: 3,
    videoBandRotationWindowDays: 90,
    ...overrides,
  });
}

describe('runReshuffleVideoRotation (#1031)', () => {
  let db;
  let runReshuffleVideoRotation;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    ({ runReshuffleVideoRotation } = await import('../../srv/jobs/reshuffle-video-rotation.js'));
  });

  beforeEach(async () => {
    const { HomepageVideoRotation, HomepageConfig } = cds.entities(NS);
    const { Videos } = cds.entities(NS_EXT);
    await db.run(DELETE.from(HomepageVideoRotation));
    await db.run(DELETE.from(Videos));
    await db.run(DELETE.from(HomepageConfig));
    await seedConfig(db);
  });

  it('picks top-N by view velocity (views per day since publishedAt)', async () => {
    await seedVideo(db, 'A', 10, 1000);  // 100/day
    await seedVideo(db, 'B', 10, 500);   // 50/day
    await seedVideo(db, 'C', 10, 5000);  // 500/day  ← top
    await seedVideo(db, 'D', 10, 2000);  // 200/day  ← 2nd
    await seedVideo(db, 'E', 10, 1500);  // 150/day  ← 3rd

    const result = await runReshuffleVideoRotation();
    expect(result.inserted).toBe(3);
    expect(result.poolSize).toBe(5);

    const rows = await SELECT.from(cds.entities(NS).HomepageVideoRotation)
      .columns('video_ID', 'rank')
      .orderBy({ rank: 'asc' });
    const rankedIds = await Promise.all(rows.map(async (r) => {
      const v = await SELECT.one.from(cds.entities(NS_EXT).Videos).columns('youtubeVideoId').where({ ID: r.video_ID });
      return v.youtubeVideoId;
    }));
    expect(rankedIds).toEqual(['C', 'D', 'E']);
  });

  it('filters out excludeFromHomepage=true rows', async () => {
    await seedVideo(db, 'X', 10, 999999, { excluded: true });  // huge velocity but excluded
    await seedVideo(db, 'A', 10, 100);
    const result = await runReshuffleVideoRotation();
    expect(result.poolSize).toBe(1);
    const rows = await SELECT.from(cds.entities(NS).HomepageVideoRotation);
    expect(rows.length).toBe(1);
  });

  it('filters out videos older than videoBandRotationWindowDays', async () => {
    await seedVideo(db, 'OLD', 200, 999999);  // 200 days ago — outside 90d window
    await seedVideo(db, 'NEW', 30, 100);
    const result = await runReshuffleVideoRotation();
    expect(result.poolSize).toBe(1);
  });

  it('deprioritises null-viewCount rows (velocity = 0)', async () => {
    await INSERT.into(cds.entities(NS_EXT).Videos).entries({
      slug: 'vd-NULL', title: 'no stats', description: '', url: '',
      youtubeVideoId: 'NULL', publishedAt: new Date(Date.now() - 10 * 86400_000).toISOString(),
      channelTitle: 'x', thumbnailUrl: '', sourceId: 'NULL', contentHash: 'h',
      excludeFromHomepage: false,
    });
    await seedVideo(db, 'A', 10, 1);  // 0.1/day — beats NULL's 0
    await seedConfig(db, { videoBandRotationCount: 1 });
    const result = await runReshuffleVideoRotation();
    expect(result.inserted).toBe(1);
    const rows = await SELECT.from(cds.entities(NS).HomepageVideoRotation);
    const v = await SELECT.one.from(cds.entities(NS_EXT).Videos).columns('youtubeVideoId').where({ ID: rows[0].video_ID });
    expect(v.youtubeVideoId).toBe('A');
  });

  it('returns { inserted: 0 } when the pool is empty (no crash)', async () => {
    const result = await runReshuffleVideoRotation();
    expect(result.inserted).toBe(0);
    expect(result.poolSize).toBe(0);
  });
});
