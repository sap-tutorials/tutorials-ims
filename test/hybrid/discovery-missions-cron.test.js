// test/hybrid/discovery-missions-cron.test.js
//
// Phase 4.3 (#447) PR-2: end-to-end hybrid test for the weekly cron.
//
// BLOCKED-until-deploy:
//   - runs against the DEV CF space via `cds bind --exec`
//   - depends on the sap-devs MCP being wired and reachable from DEV
//   - if the cron returns errors > 0, surface them but don't auto-skip
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/discovery-missions-cron.test.js

import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';
import { runFetchDiscoveryMissions } from '../../srv/jobs/fetch-discovery-missions-job.js';

describe('fetch-discovery-missions-job (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to write HANA.');
    }
  });

  it('runs end-to-end and produces upserts', async () => {
    const summary = await runFetchDiscoveryMissions();

    expect(summary.errors).toBe(0);
    expect(summary.fetched).toBeGreaterThan(0);
    expect(summary.upserted).toBe(summary.fetched);  // upsert is NOT budget-gated
  });
});
