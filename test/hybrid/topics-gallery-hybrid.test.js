// test/hybrid/topics-gallery-hybrid.test.js
//
// Verifies GET /build/topics-gallery against real HANA (DEV space). Read-only.
// Requires `cds bind` to the DEV space + `npm run test:hybrid`.
// If TopicClusters is empty (nightly job has not yet run), the test self-skips.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('topics-gallery (hybrid)', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const isHana =
      db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'topics-gallery-hybrid.test.js must run against HANA. ' +
          'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  }, 30_000);

  it('GET /build/topics-gallery returns 200 with gallery array', async () => {
    const res = await cds.test.get('/build/topics-gallery');
    expect(res.status).toBe(200);
    expect(res.data.error).toBeNull();
    expect(Array.isArray(res.data.gallery)).toBe(true);
  }, 30_000);

  it('gallery clusters have expected shape when data exists', async () => {
    const res = await cds.test.get('/build/topics-gallery');
    expect(res.status).toBe(200);
    if (res.data.gallery.length === 0) {
      // TopicClusters table is empty — nightly job has not run yet; self-skip.
      console.warn('topics-gallery: TopicClusters empty, skipping shape assertions');
      return;
    }
    const first = res.data.gallery[0];
    expect(typeof first.slug).toBe('string');
    expect(typeof first.label).toBe('string');
    expect(Array.isArray(first.topConcepts)).toBe(true);
    expect(res.data.clusters[first.slug]).toBeTruthy();
    expect(['path', 'ranked']).toContain(res.data.clusters[first.slug].orderMode);
  }, 30_000);
});
