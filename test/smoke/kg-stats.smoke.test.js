// test/smoke/kg-stats.smoke.test.js
import { describe, it, expect } from 'vitest';

const SRV_URL = process.env.SMOKE_SRV_URL;
if (!SRV_URL) {
  throw new Error('SMOKE_SRV_URL not set — set it to the deployed srv URL before running smoke tests');
}

describe('smoke: GET /build/kg-stats', () => {
  it('returns 200 with the expected shape', async () => {
    const res = await fetch(`${SRV_URL}/build/kg-stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(typeof body.tutorials).toBe('number');
    expect(typeof body.concepts).toBe('number');
    expect(typeof body.relationships).toBe('number');
    expect(typeof body.missionsAndGroups).toBe('number');
    expect(body.tutorials).toBeGreaterThanOrEqual(0);
  });
});
