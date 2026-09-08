// test/hybrid/sm-tech-ids.test.js
//
// Hybrid test — verifies /build/tag-semaphore returns a real product-tag map
// from DEV HANA (i.e. Tags.semaphoreId rows are populated and the endpoint
// aggregates them correctly).
//
// Read-only — no fixture writes, no cleanup.
//
// Run with: npm run test:hybrid -- test/hybrid/sm-tech-ids.test.js
// Requires: cf login + cds bind (the npm run test:hybrid wrapper supplies this)

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

// Boot the CAP server bound to hybrid HANA — mirrors build-concepts.test.js.
const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('/build/tag-semaphore (hybrid, real HANA)', () => {
  it('returns 200 with a non-empty product-tag map', async () => {
    const res = await project.get('/build/tag-semaphore');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('map');
    expect(typeof res.data.map).toBe('object');
    const entries = Object.entries(res.data.map);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('at least one entry is a faceted tag (contains ">") with a Semaphore-style numeric ID', async () => {
    const res = await project.get('/build/tag-semaphore');
    expect(res.status).toBe(200);
    const entries = Object.entries(res.data.map);
    // At least one key uses the facet>leaf mdFormat pattern (e.g.
    // "software-product>sap-hana-cloud") and maps to a numeric ID ≥ 4 digits.
    const productEntry = entries.find(([md]) => md.includes('>'));
    expect(productEntry).toBeTruthy();
    expect(String(productEntry[1])).toMatch(/^\d{4,}/);
  });

  it('returns a buildAt ISO timestamp', async () => {
    const res = await project.get('/build/tag-semaphore');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('buildAt');
    expect(typeof res.data.buildAt).toBe('string');
    // ISO 8601 basic check
    expect(res.data.buildAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('serves a cache-control header (ensures CDN / approuter cacheability)', async () => {
    const res = await project.get('/build/tag-semaphore');
    expect(res.status).toBe(200);
    // Unit test asserts max-age=60; hybrid confirms the header survives the
    // real CAP boot path (same expectation, real HANA).
    expect(res.headers['cache-control']).toContain('max-age=60');
  });
});
