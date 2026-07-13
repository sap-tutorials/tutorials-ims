// test/hybrid/1170-topic-clusters.test.js
//
// Verifies GET /build/topic-clusters against real HANA (DEV space). Read-only:
// asserts the KgCommunityLabel ⋈ KgCommunity ⋈ Tutorials join resolves labeled
// clusters with live tutorial titles. Runs via `npm run test:hybrid` after
// `cds bind` to the DEV space (which has ~18 labeled communities as of #1163).
//
// Issue: #1170

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe.runIf(isSafeForWrites())('#1170 topic-clusters band (hybrid)', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const isHana =
      db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        '1170-topic-clusters.test.js must run against HANA. ' +
          'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  }, 30_000);

  it('GET /build/topic-clusters returns 200 with clusters array', async () => {
    const res = await cds.test.get('/build/topic-clusters');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.clusters)).toBe(true);
  }, 30_000);

  it('returns at least one qualifying labeled cluster from HANA', async () => {
    const res = await cds.test.get('/build/topic-clusters');
    expect(res.status).toBe(200);
    // DEV has ~18 labeled communities; at least one must qualify (>=3 live tutorials).
    expect(res.data.clusters.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('each cluster satisfies the band contract', async () => {
    const res = await cds.test.get('/build/topic-clusters');
    expect(res.status).toBe(200);

    for (const c of res.data.clusters) {
      // non-empty label
      expect(typeof c.label).toBe('string');
      expect(c.label.length).toBeGreaterThan(0);

      // min-3 gate and 4-per-card cap
      expect(c.tutorials.length).toBeGreaterThanOrEqual(3);
      expect(c.tutorials.length).toBeLessThanOrEqual(4);

      for (const t of c.tutorials) {
        // canonical slug invariant
        expect(t.slug).toBe(t.slug.toLowerCase());
        // url derivation
        expect(t.url).toBe(`/tutorials/${t.slug}`);
        // non-empty title
        expect(typeof t.title).toBe('string');
        expect(t.title.length).toBeGreaterThan(0);
      }

      // titles sorted ASC within a card
      const titles = c.tutorials.map((t) => t.title);
      expect(titles).toEqual([...titles].sort());
    }
  }, 30_000);

  it('clusters are ranked by tutorialCount descending', async () => {
    const res = await cds.test.get('/build/topic-clusters');
    expect(res.status).toBe(200);

    if (res.data.clusters.length < 2) return; // only one cluster — nothing to rank
    const counts = res.data.clusters.map((c) => c.tutorialCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  }, 30_000);
});
