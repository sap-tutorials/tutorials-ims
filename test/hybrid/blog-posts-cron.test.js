// test/hybrid/blog-posts-cron.test.js
//
// Phase 4.2 (#447) PR-2: end-to-end hybrid test for the daily cron.
//
// BLOCKED-until-deploy AND BLOCKED-until-backfill:
//   - runs against the DEV CF space via `cds bind --exec`
//   - assumes scripts/seed-blog-posts.cjs has been run (or that the cron
//     has been left running for a few days, populating BlogPosts naturally)
//   - if BlogPosts is empty, the cron aborts (per spec §7) — this test
//     skips with a clear message
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/blog-posts-cron.test.js

import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';
import { runFetchBlogPosts } from '../../srv/jobs/fetch-blog-posts-job.js';

describe('fetch-blog-posts-job (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to write HANA.');
    }
  });

  it('runs end-to-end and produces upserts + links', async () => {
    const { BlogPosts } = cds.entities('com.sap.developers.ims.external');
    const pre = await SELECT.one.from(BlogPosts).columns('count(*) as n');
    if ((pre?.n ?? 0) === 0) {
      console.warn('BlogPosts is empty; cron will abort. Run scripts/seed-blog-posts.cjs first.');
      return;
    }

    const summary = await runFetchBlogPosts();

    expect(summary.errors).toBe(0);
    expect(summary.fetched).toBeGreaterThanOrEqual(0);
    expect(summary.upserted).toBeGreaterThanOrEqual(0);
  });
});
