// test/hybrid/homepage-videos-1031.test.js
//
// (#1031) Hybrid smoke — runs against real HANA via `cds bind --exec`.
// Verifies the reshuffle cron writes rows against HANA and the merged
// endpoint returns items with the `kind` field.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const NS = 'com.sap.developers.ims';
const NS_EXT = 'com.sap.developers.ims.external';
const TEST_TAG = '__TEST__1031_';

describe.runIf(isSafeForWrites())('Homepage video band on HANA (#1031)', () => {
  let db;
  let seededVideoId;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    // Seed one exclusion-safe video the reshuffle will pick up regardless
    // of what's in the real Videos table.
    seededVideoId = `${TEST_TAG}${Date.now()}`;
    await db.run(INSERT.into(`${NS_EXT}.Videos`).entries({
      slug: `vd-${seededVideoId}`,
      title: `${TEST_TAG}fake title`,
      description: '', url: '',
      youtubeVideoId: seededVideoId,
      publishedAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
      channelTitle: 'test',
      thumbnailUrl: '',
      sourceId: seededVideoId,
      contentHash: `h-${seededVideoId}`,
      viewCount: 999999999,
      likeCount: 0,
      commentCount: 0,
      excludeFromHomepage: false,
    }));
  });

  afterAll(async () => {
    await db.run(DELETE.from(`${NS_EXT}.Videos`).where("slug LIKE '" + `vd-${TEST_TAG}` + "%'"));
  });

  it('reshuffle cron writes rows and endpoint tags them kind=popular', async () => {
    const { runReshuffleVideoRotation } = await import('../../srv/jobs/reshuffle-video-rotation.js');
    const result = await runReshuffleVideoRotation();
    expect(result.inserted).toBeGreaterThanOrEqual(1);

    const rows = await SELECT.from(`${NS}.HomepageVideoRotation`);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const homepage = await cds.connect.to('HomepageService');
    const res = await homepage.send('videos');
    for (const item of res.recent) {
      expect(['anchor', 'popular']).toContain(item.kind);
    }
  });
});
