import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

describe('Next steps recommendations (related tutorials rail)', () => {
  it('GET /tutorials/:slug returns HTML with related-tutorials rail card', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/abap-cloud-ui-from-interface/`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('Related Tutorials');

    // Rail card element exists in the rendered HTML
    const railCardRegex = /ui-rail-card[^>]*data-slug="[^"]*"[^>]*>/i;
    expect(html).toMatch(railCardRegex);
  });
});
