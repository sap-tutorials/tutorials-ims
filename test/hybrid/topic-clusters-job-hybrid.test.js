// test/hybrid/topic-clusters-job-hybrid.test.js
// Hybrid test: runs the real TopicClusters reconciliation job against HANA DEV.
// Requires cf login + cds bind to the DEV space.
// Self-skips via describe.runIf(isSafeForWrites()) when HANA is unavailable.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe.runIf(isSafeForWrites())('kg-topic-clusters job (hybrid)', () => {
  let isHana = false;

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'topic-clusters-job-hybrid.test.js must run against HANA. ' +
          'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  }, 30_000);

  it('populates TopicClusters with ACTIVE stable slugs', async () => {
    const { runKgTopicClusters } = await import('../../srv/jobs/kg-topic-clusters-job.js');
    const summary = await runKgTopicClusters();
    expect(summary.clusters).toBeGreaterThan(0);
    const { TopicClusters } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TopicClusters).where({ status: 'ACTIVE' });
    expect(rows.length).toBe(summary.clusters);
    for (const r of rows) {
      expect(r.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(r.fingerprint).toHaveLength(64);
    }
  }, 60_000);

  it('is idempotent: a second run keeps the same slugs (Jaccard=1 self-match)', async () => {
    const { runKgTopicClusters } = await import('../../srv/jobs/kg-topic-clusters-job.js');
    const { TopicClusters } = cds.entities('com.sap.developers.ims');
    const before = new Set((await SELECT.from(TopicClusters).where({ status: 'ACTIVE' })).map((r) => r.slug));
    await runKgTopicClusters();
    const after = new Set((await SELECT.from(TopicClusters).where({ status: 'ACTIVE' })).map((r) => r.slug));
    expect([...after]).toEqual(expect.arrayContaining([...before]));
  }, 60_000);
});
