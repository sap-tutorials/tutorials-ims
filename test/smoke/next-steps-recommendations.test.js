import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

describe('Next Steps recommendations', () => {
  it('renders Related Tutorials rail on a known tutorial page', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/abap-cloud-ui-from-interface/`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('Related Tutorials');

    // Rail card element exists in the rendered HTML
    expect(html).toMatch(/next-steps-rail-card[\s\S]*?href=["']?\/tutorials\/[a-z0-9-]+/);
  });

  it('renders 1-3 recommendation cards on a popular tutorial', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/abap-cloud-ui-from-interface/`);
    expect(res.status).toBe(200);

    const html = await res.text();
    const matches = html.match(/class=["']?next-steps-rail-card["']?/g) ?? [];
    // We always cap at 3, but a sparsely-tagged tutorial may produce fewer.
    // Production tutorials should hit the cap; loosen if a fresh tutorial flakes.
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.length).toBeLessThanOrEqual(3);
  });
});
