// test/hybrid/samples-cron.test.js
//
// Phase 4.6 (#747) Task 2: hybrid end-to-end for fetch-samples-job.
// Blocked-until-deploy AND blocked-until-seeded (graceful skip when
// Samples is empty). Same posture as 4.2/4.3/4.4/4.5 hybrid crons.

import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';
import { runFetchSamples } from '../../srv/jobs/fetch-samples-job.js';

describe('fetch-samples-job (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to write HANA.');
    }
  });

  it('runs end-to-end (requires Samples seeded first via scripts/seed-samples.cjs)', async () => {
    const { Samples } = cds.entities('com.sap.developers.ims.external');
    const pre = await SELECT.one.from(Samples).columns('count(*) as n');
    if ((pre?.n ?? 0) === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        'Samples table is empty; cron will hit MAX-or-abort gate. ' +
        'Run scripts/seed-samples.cjs --commit first (or click "Seed samples" in admin UI).',
      );
      return; // graceful skip — same posture as 4.3/4.4/4.5
    }
    // Stub embed/extract so the hybrid run doesn't burn AI Core quota.
    // Signature: runFetchSamples(logId, opts). logId is null in this manual
    // invocation (no PipelineLog row); opts carries the test stubs.
    const summary = await runFetchSamples(null, {
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
    });
    expect(summary.errors).toBe(0);
    expect(summary.fetched).toBeGreaterThanOrEqual(0);
  });
});
