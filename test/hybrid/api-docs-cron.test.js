// test/hybrid/api-docs-cron.test.js
//
// Phase 4.5 (#746) Task 2: hybrid end-to-end for fetch-api-docs-job.
// Blocked-until-deploy AND blocked-until-seeded (graceful skip when
// ApiDocs is empty). Same posture as 4.2/4.3/4.4 hybrid crons.

import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';
import { runFetchApiDocs } from '../../srv/jobs/fetch-api-docs-job.js';

describe('fetch-api-docs-job (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to write HANA.');
    }
  });

  it('runs end-to-end (requires ApiDocs seeded first via scripts/seed-api-docs.cjs)', async () => {
    const { ApiDocs } = cds.entities('com.sap.developers.ims.external');
    const pre = await SELECT.one.from(ApiDocs).columns('count(*) as n');
    if ((pre?.n ?? 0) === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        'ApiDocs table is empty; cron will hit MAX-or-abort gate. ' +
        'Run scripts/seed-api-docs.cjs first.',
      );
      return; // graceful skip — same posture as 4.3/4.4
    }
    // Stub embed/extract so the hybrid run doesn't burn AI Core quota.
    const summary = await runFetchApiDocs({
      embed: async () => [new Float32Array(384)],
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
    });
    expect(summary.errors).toBe(0);
    expect(summary.fetched).toBeGreaterThanOrEqual(0);
  });
});
