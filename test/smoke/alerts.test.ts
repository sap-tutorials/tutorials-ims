// test/smoke/alerts.test.ts
//
// Issue #548 — smoke tests for the public alerts endpoints exposed by
// srv/routes/alerts-public.js. Asserts:
//
//   GET /api/alerts        — 200 + public Cache-Control + JSON envelope
//                            { alerts: [], fetchedAt: ISO string }
//   GET /api/alerts/me     — 401 + body exactly { authenticated: false }
//                            when called without authentication
//
// The Cache-Control regex tolerates the full directive set
// (`public, max-age=60, stale-while-revalidate=300`) by matching individual
// tokens rather than the whole string.

import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Alerts smoke (deployed)', () => {
  it('GET /api/alerts → 200 + valid JSON envelope', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/alerts`);
    expect(res.status).toBe(200);

    const cc = res.headers.get('cache-control') || '';
    expect(cc).toMatch(/public/);
    expect(cc).toMatch(/max-age=60/);

    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const body = await res.json();
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(typeof body.fetchedAt).toBe('string');
  });

  it('GET /api/alerts/me unauthenticated → 401 { authenticated: false }', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/alerts/me`);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body).toEqual({ authenticated: false });
  });
});
