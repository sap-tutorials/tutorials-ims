// test/smoke/smoke-homepage-events.test.js
// #1030 — smoke against a deployed CAP srv.

import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_SRV_URL;
const describeMaybe = BASE ? describe : describe.skip;

describeMaybe('smoke /homepage/events', () => {
  it('region=EMEA returns EMEA-or-virtual rows only', async () => {
    const resp = await fetch(`${BASE}/homepage/events?region=EMEA`);
    expect(resp.status).toBe(200);
    const rows = await resp.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(6);
    for (const r of rows) {
      expect(r.region === 'EMEA' || r.isVirtual === true).toBe(true);
    }
  });

  it('region=BOGUS coerces to ALL (does not 400)', async () => {
    const resp = await fetch(`${BASE}/homepage/events?region=BOGUS`);
    expect(resp.status).toBe(200);
  });

  it('response includes eventType, region, isVirtual fields', async () => {
    const resp = await fetch(`${BASE}/homepage/events?region=ALL`);
    const rows = await resp.json();
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty('eventType');
      expect(rows[0]).toHaveProperty('region');
      expect(rows[0]).toHaveProperty('isVirtual');
    }
  });
});
