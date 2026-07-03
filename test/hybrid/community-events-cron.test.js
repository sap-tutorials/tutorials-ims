// test/hybrid/community-events-cron.test.js
//
// Phase 4.8 (#765) Task 2: hybrid end-to-end for fetch-community-events-job.
// BLOCKED-until-deploy AND BLOCKED-until-seeded (graceful skip when
// CommunityEvents is empty). Same posture as Phase 4.2-4.7 hybrid crons.

import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';
import { runFetchCommunityEvents } from '../../srv/jobs/fetch-community-events-job.js';

describe('fetch-community-events-job (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to write HANA.');
    }
  });

  it('runs end-to-end (requires CommunityEvents seeded first via scripts/seed-community-events.cjs)', async () => {
    const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');
    const pre = await SELECT.one.from(CommunityEvents).columns('count(*) as n');
    if ((pre?.n ?? 0) === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        'CommunityEvents table is empty; cron will hit MAX-or-abort gate. ' +
        'Run scripts/seed-community-events.cjs --commit first (or click "Seed community events" in admin UI).',
      );
      return; // graceful skip
    }
    // Stub embed/extract so the hybrid run doesn't burn AI Core quota.
    const summary = await runFetchCommunityEvents(null, {
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
    });
    expect(summary.errors).toBe(0);
    expect(summary.fetched).toBeGreaterThanOrEqual(0);
    // Per-source breakout is always shape-present with khoros + rss keys.
    expect(summary.perSource).toBeDefined();
    expect(summary.perSource.khoros).toBeDefined();
    expect(summary.perSource.rss).toBeDefined();
  });

  it('upsert is idempotent (#708 crash-safety short-circuits second run)', async () => {
    const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');
    const pre = await SELECT.one.from(CommunityEvents).columns('count(*) as n');
    if ((pre?.n ?? 0) === 0) return; // graceful skip

    const stubs = {
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
    };
    // First run.
    await runFetchCommunityEvents(null, stubs);
    const midCount = await SELECT.one.from(CommunityEvents).columns('count(*) as n');
    // Second run — expect no doubling.
    const second = await runFetchCommunityEvents(null, stubs);
    const endCount = await SELECT.one.from(CommunityEvents).columns('count(*) as n');
    expect(second.errors).toBe(0);
    expect(endCount.n).toBe(midCount.n);
    expect(second.extracted).toBe(0);
  });

  it('MAX-or-abort gate fires on empty CommunityEvents (checked pre-seed)', async () => {
    // This test is intentionally observational — if the table is non-empty
    // it exercises the "not gated" branch which we test in the unit suite.
    // In hybrid, we assert that when the table IS empty, we get errors >= 1
    // and no rows are fetched. It is safe to run alongside a seeded env
    // because we don't mutate anything.
    const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');
    const pre = await SELECT.one.from(CommunityEvents).columns('count(*) as n');
    if ((pre?.n ?? 0) > 0) return; // graceful skip — table is seeded

    const summary = await runFetchCommunityEvents(null, {
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
    });
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(summary.fetched).toBe(0);
  });
});
