import { describe, it, expect } from 'vitest';
import { fetchWithRetry } from './smoke.config.js';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:5000';

describe('joule panel smoke', () => {
  it('serves the markdown-it vendor bundle', async () => {
    const r = await fetchWithRetry(`${BASE}/js/vendor/markdown-it.min.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') || '').toMatch(/javascript/);
  });

  it('serves the DOMPurify vendor bundle', async () => {
    const r = await fetchWithRetry(`${BASE}/js/vendor/purify.min.js`);
    expect(r.status).toBe(200);
  });

  it('home page contains the AI Notice button and disclaimer', async () => {
    const r = await fetchWithRetry(`${BASE}/`, { redirect: 'follow' });
    const html = await r.text();
    expect(html).toMatch(/data-overflow=["']?ai-notice["']?/);
    expect(html).toMatch(/Joule uses AI\.\s*Verify results\./);
  });

  it('home page embeds starter prompts JSON', async () => {
    const r = await fetchWithRetry(`${BASE}/`, { redirect: 'follow' });
    const html = await r.text();
    expect(html).toMatch(/<script id=["']?joule-starters["']?/);
  });
});
