// test/smoke/explore-about.smoke.test.js
import { describe, it, expect } from 'vitest';
import { fetchWithRetry } from './smoke.config.js';

const BASE_URL = process.env.SMOKE_BASE_URL;
if (!BASE_URL) {
  throw new Error('SMOKE_BASE_URL not set — set it to the deployed approuter URL');
}

describe('smoke: /explore/about/', () => {
  it('returns 200 with HTML content-type', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/explore/about/`, { redirect: 'follow' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('HTML body contains the expected hero title and counter mount node', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/explore/about/`, { redirect: 'follow' });
    const html = await res.text();
    expect(html).toContain('The SAP Developer Knowledge Graph');
    // Hugo's production minifier strips quotes from safe attribute values,
    // so the counter mount ships as id=kg-stats-counter (unquoted).
    expect(html).toMatch(/id=["']?kg-stats-counter["']?/);
  });
});
