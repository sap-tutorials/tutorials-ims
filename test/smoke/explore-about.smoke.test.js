// test/smoke/explore-about.smoke.test.js
import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.SMOKE_BASE_URL;
if (!BASE_URL) {
  throw new Error('SMOKE_BASE_URL not set — set it to the deployed approuter URL');
}

describe('smoke: /explore/about/', () => {
  it('returns 200 with HTML content-type', async () => {
    const res = await fetch(`${BASE_URL}/explore/about/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('HTML body contains the expected hero title and counter mount node', async () => {
    const res = await fetch(`${BASE_URL}/explore/about/`);
    const html = await res.text();
    expect(html).toContain('The SAP Developer Knowledge Graph');
    expect(html).toContain('id="kg-stats-counter"');
  });
});
