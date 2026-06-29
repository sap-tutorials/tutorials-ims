// test/hybrid/videos-cron.test.js
//
// Phase 4.4 (#447) PR-2: end-to-end hybrid test for the twice-weekly cron.
//
// BLOCKED-until-deploy AND BLOCKED-until-backfill:
//   - runs against the DEV CF space via `cds bind --exec`
//   - depends on YOUTUBE_API_KEY credstore alias being seeded (same as
//     homepage video band)
//   - depends on Videos table being seeded — the cron's MAX-or-abort first-
//     run gate refuses to self-bootstrap. Operator MUST run
//     scripts/seed-videos.cjs first.
//   - when Videos is empty, the test SKIPS gracefully (warns + returns) so
//     the hybrid suite can run pre-backfill without failure.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/videos-cron.test.js

import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';
import { runFetchVideos } from '../../srv/jobs/fetch-videos-job.js';

describe('fetch-videos-job (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to write HANA.');
    }
  });

  it('runs end-to-end (requires Videos seeded first via scripts/seed-videos.cjs)', async () => {
    const { Videos } = cds.entities('com.sap.developers.ims.external');
    const pre = await SELECT.one.from(Videos).columns('count(*) as n');
    if ((pre?.n ?? 0) === 0) {
      console.warn('Videos table is empty; cron will hit MAX-or-abort gate. Run scripts/seed-videos.cjs first.');
      return;  // skip gracefully — same posture as 4.3
    }
    const summary = await runFetchVideos();
    expect(summary.errors).toBe(0);
    expect(summary.fetched).toBeGreaterThanOrEqual(0);
  });
});
