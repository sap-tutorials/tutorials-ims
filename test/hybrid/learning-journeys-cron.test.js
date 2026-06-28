// test/hybrid/learning-journeys-cron.test.js
//
// Phase 4.1 (#447) hybrid end-to-end test for the weekly Learning Journeys
// cron job.
//
// BLOCKED-until-deploy: runs against the DEV CF space via `cds bind --exec`.
// The real MCP transport in sap-devs-client.js is currently a TODO-throw
// (the MCP wiring is owned by the project's existing MCP integration —
// out of scope for 4.1). Until the transport ships, this test will see
// `summary.errors > 0` from the MCP-fetch step. Once the transport is
// wired, the assertions below pass against the bound HANA.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/learning-journeys-cron.test.js
//
// SAFETY
//   - Targets the EXTERNAL namespace (LearningJourneys is cron-managed; no
//     other writers). Rows touched by this test are real upserts and will
//     survive the run; they will be picked up by the GC cron (gc-external-
//     content-job.js) when stale. This is by design — the cron itself does
//     not use __TEST__ prefixes, so a hybrid run is effectively a one-off
//     real cron run with the same idempotency the production schedule
//     provides.

import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';
import { runFetchLearningJourneys } from '../../srv/jobs/fetch-learning-journeys-job.js';

describe('fetch-learning-journeys-job (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error(
        'ALLOW_HYBRID_WRITES not set. This hybrid test performs real writes against the bound HANA; ' +
        'set ALLOW_HYBRID_WRITES=true to acknowledge or skip.',
      );
    }
  });

  it('runs end-to-end and produces journeys + (optional) links', async () => {
    const summary = await runFetchLearningJourneys();

    // The MCP call should succeed and return at least some journeys once
    // the transport is wired. Until then, `fetched === 0 && errors > 0`
    // is the expected red state.
    expect(summary.fetched).toBeGreaterThan(0);
    expect(summary.upserted).toBeGreaterThan(0);
    expect(summary.errors).toBe(0);

    // At least one journey persisted.
    const { LearningJourneys, LearningJourneyConceptLinks } =
      cds.entities('com.sap.developers.ims.external');

    const journeyCountRow = await SELECT.from(LearningJourneys).columns('count(*) as n');
    const journeyCount = journeyCountRow?.[0]?.n ?? 0;
    expect(journeyCount).toBeGreaterThan(0);

    // Link count may be 0 on the first run (no overlap with the concept
    // registry yet); we just assert the table is queryable.
    const linkCountRow = await SELECT.from(LearningJourneyConceptLinks).columns('count(*) as n');
    const linkCount = linkCountRow?.[0]?.n ?? 0;
    expect(linkCount).toBeGreaterThanOrEqual(0);
  });
});
