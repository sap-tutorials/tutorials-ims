import { describe, it, expect } from 'vitest';

const QA_BASE = process.env.SMOKE_QA_BASE_URL!;
const SRV_QA = process.env.SMOKE_QA_SRV_URL!;
const TOKEN = process.env.SMOKE_QA_TOKEN!; // pre-acquired XSUAA bearer

describe.skipIf(!process.env.SMOKE_QA_BASE_URL || !process.env.SMOKE_QA_SRV_URL || !process.env.SMOKE_QA_TOKEN)('QA endpoints', () => {
  it('GET /tutorials-qa/<known-slug> returns 200 with QA banner', async () => {
    const r = await fetch(`${QA_BASE}/tutorials-qa/__SMOKE__qa`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('QA preview');
  });

  it('GET /tutorials-qa/<slug> without auth returns 401', async () => {
    const r = await fetch(`${QA_BASE}/tutorials-qa/__SMOKE__qa`);
    expect([401, 302]).toContain(r.status); // approuter may redirect to login
  });

  it('GET /qa-search/Tutorials?$search=cap returns search results', async () => {
    const r = await fetch(`${QA_BASE}/qa-search/Tutorials?$search=cap`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(r.status).toBe(200);
  });

  it('GET /tutorials-qa/<slug>/admin returns 404 (admin not exposed)', async () => {
    // Direct hit to QA srv, not approuter
    const r = await fetch(`${SRV_QA}/admin/Events`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(r.status).toBe(404);
  });
});
