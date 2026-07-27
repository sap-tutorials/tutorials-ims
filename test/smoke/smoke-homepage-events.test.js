// test/smoke/smoke-homepage-events.test.js
// #1030 — smoke against a deployed CAP srv.

import { describe, it, expect } from 'vitest';
import { fetchWithRetry } from './smoke.config.js';

const BASE = process.env.SMOKE_SRV_URL;
const describeMaybe = BASE ? describe : describe.skip;

describeMaybe('smoke /homepage/events', () => {
  it('region=EMEA returns EMEA-or-virtual rows only', async () => {
    const resp = await fetchWithRetry(`${BASE}/homepage/events?region=EMEA`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    const rows = Array.isArray(body) ? body : body.value;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(6);
    for (const r of rows) {
      // #1030: only codejams honor the region filter; manual Events + Devtoberfest
      // are always included region-agnostically (region 'UNKNOWN').
      if (String(r.eventType).toLowerCase() === 'codejam') {
        expect(r.region === 'EMEA' || r.isVirtual === true).toBe(true);
      }
    }
  });

  it('region=BOGUS coerces to ALL (does not 400)', async () => {
    const resp = await fetchWithRetry(`${BASE}/homepage/events?region=BOGUS`);
    expect(resp.status).toBe(200);
  });

  it('response includes eventType, region, isVirtual fields', async () => {
    const resp = await fetchWithRetry(`${BASE}/homepage/events?region=ALL`);
    const body = await resp.json();
    const rows = Array.isArray(body) ? body : body.value;
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty('eventType');
      expect(rows[0]).toHaveProperty('region');
      expect(rows[0]).toHaveProperty('isVirtual');
    }
  });
});
