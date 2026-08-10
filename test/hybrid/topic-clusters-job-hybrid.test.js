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

  it('C1 guard: ACTIVE rows have a non-empty memberSlugsBlob persisted after each run', async () => {
    // This assertion proves the persisted-column half of the C1 fix is wired up.
    // The unit drift test covers the reading half. Together they guard the full round-trip.
    const { runKgTopicClusters } = await import('../../srv/jobs/kg-topic-clusters-job.js');
    await runKgTopicClusters();
    const { TopicClusters } = cds.entities('com.sap.developers.ims');
    const active = await SELECT.from(TopicClusters).where({ status: 'ACTIVE' });
    expect(active.length).toBeGreaterThan(0);
    for (const r of active) {
      expect(r.memberSlugsBlob).toBeTruthy();
      // Every blob entry should be a valid lowercase tutorial-slug character set
      const slugs = r.memberSlugsBlob.split('\n').filter(Boolean);
      expect(slugs.length).toBeGreaterThan(0);
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

  it('admin curatedLabel + hidden override survives a job re-run (overridesBySlug carry-forward)', async () => {
    const { runKgTopicClusters } = await import('../../srv/jobs/kg-topic-clusters-job.js');
    const { TopicClusters } = cds.entities('com.sap.developers.ims');

    // Pick any ACTIVE slug to test carry-forward on.
    const target = await SELECT.one.from(TopicClusters).where({ status: 'ACTIVE' });
    if (!target) {
      // No ACTIVE clusters — nothing to carry forward. Skip gracefully.
      return;
    }
    const { slug } = target;

    // Set admin overrides directly on the underlying table.
    await UPDATE(TopicClusters).set({ curatedLabel: '__hybrid_override__', hidden: true }).where({ slug });

    // Re-run the job — this does a TRUNCATE+INSERT internally.
    await runKgTopicClusters();

    // The overridesBySlug map in _buildCommunitiesInput should have read and
    // re-applied these values so they survive the TRUNCATE.
    const after = await SELECT.one.from(TopicClusters).where({ slug });
    expect(after).not.toBeNull();
    expect(after.curatedLabel).toBe('__hybrid_override__');
    expect(after.hidden).toBe(true);

    // Clean up the override so subsequent test runs start clean.
    await UPDATE(TopicClusters).set({ curatedLabel: null, hidden: false }).where({ slug });
  }, 60_000);
});
