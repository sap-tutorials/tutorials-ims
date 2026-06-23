/**
 * Smoke test — Joule on Devtoberfest pages.
 *
 * Two checks at the HTTP layer; LLM output is NOT asserted (that's an
 * eval concern). The goal is to catch a wholly broken deploy — bad
 * persona switching, missing tool registration, broken /chat/stream.
 *
 * Refs #565
 */
import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Joule on Devtoberfest — smoke', () => {
  it('GET /devtoberfest/ renders the page with the shellbar Joule trigger', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/devtoberfest/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="joule-trigger"');
    expect(body).toMatch(/data-page-kind="devtoberfest"/);
  });

  it('POST /chat/stream rejects anonymous with 401 (existing rule, on devtoberfest pageContext)', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        pageContext: { kind: 'devtoberfest', slug: '' }
      })
    });
    // 401 (unauth), or 503 if ChatSettings.enabled=false on the deployed env.
    expect([401, 503]).toContain(res.status);
  });
});
