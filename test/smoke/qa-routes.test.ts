import { describe, it, expect } from 'vitest';
// @ts-ignore - JS module without types
import { fetchWithRetry } from './smoke.config.js';

const QA_BASE = process.env.SMOKE_QA_BASE_URL!;
const SRV_QA = process.env.SMOKE_QA_SRV_URL!;
const TOKEN = process.env.SMOKE_QA_TOKEN!; // pre-acquired XSUAA bearer

describe.skipIf(!process.env.SMOKE_QA_BASE_URL || !process.env.SMOKE_QA_SRV_URL || !process.env.SMOKE_QA_TOKEN)('QA endpoints', () => {
  it('GET /tutorials-qa/<known-slug> returns 200 with QA banner', async () => {
    const r = await fetchWithRetry(`${QA_BASE}/tutorials-qa/__SMOKE__qa`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('QA preview');
  });

  it('GET /tutorials-qa/<slug> without auth returns 401', async () => {
    const r = await fetchWithRetry(`${QA_BASE}/tutorials-qa/__SMOKE__qa`);
    expect([401, 302]).toContain(r.status); // approuter may redirect to login
  });

  it('GET /qa-search/Tutorials?$search=cap returns search results', async () => {
    const r = await fetchWithRetry(`${QA_BASE}/qa-search/Tutorials?$search=cap`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(r.status).toBe(200);
  });

  it('GET /tutorials-qa/<slug>/admin returns 404 (admin not exposed)', async () => {
    // Direct hit to QA srv, not approuter
    const r = await fetchWithRetry(`${SRV_QA}/admin/Events`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(r.status).toBe(404);
  });
});

// Direct srv-qa scope-bypass guard. The approuter enforces Tutorial.Author on
// /tutorials-qa/*, but the public CF URL of tutorials-srv-qa must independently
// reject anonymous traffic — otherwise an attacker who knows the CF URL pattern
// can bypass the scope gate.  Smoke runs after deploy and is the canonical
// verification (xssec.createSecurityContext requires a real XSUAA-issued JWT;
// faking it locally defeats the test).
describe.skipIf(!process.env.SMOKE_QA_SRV_URL)('QA srv direct (scope bypass guard)', () => {
  it('GET /content/nav without auth returns 401', async () => {
    const r = await fetchWithRetry(`${SRV_QA}/content/nav`);
    expect(r.status).toBe(401);
  });

  it('GET /content/hashes without auth returns 401', async () => {
    const r = await fetchWithRetry(`${SRV_QA}/content/hashes`);
    expect(r.status).toBe(401);
  });

  it('GET /content/tutorials/<slug> without auth returns 401', async () => {
    const r = await fetchWithRetry(`${SRV_QA}/content/tutorials/__SMOKE__qa`);
    expect(r.status).toBe(401);
  });

  it('GET /healthz remains unauthenticated (deploy/probe endpoint)', async () => {
    const r = await fetchWithRetry(`${SRV_QA}/healthz`);
    expect(r.status).toBe(200);
  });
});

const PREVIEW_OK = process.env.SMOKE_QA_SRV_URL && process.env.SMOKE_QA_TOKEN;

describe.skipIf(!PREVIEW_OK)('POST /preview/render', () => {
  const url = `${SRV_QA}/preview/render`;

  it('401 without Authorization', async () => {
    const r = await fetchWithRetry(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"markdown":"### x"}' });
    expect(r.status).toBe(401);
  });

  it('200 + html with valid author markdown', async () => {
    const md = '---\ntitle: Smoke\ndescription: smoke test\nparser: v2\n---\n\n### Smoke Step One\nbody';
    const r = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ markdown: md }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    const html = await r.text();
    expect(html).toMatch(/<title>/i);
    expect(html).toMatch(/Smoke Step One/);
  });

  it('200 + error html on malformed frontmatter', async () => {
    const bad = '---\ntitle: "unclosed\n---\n\n### x\nbody';
    const r = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ markdown: bad }),
    });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toMatch(/yaml|frontmatter/i);
  });

  // 403 (wrong-scope) test omitted: a non-Author token isn't currently in CI secrets.
  // Tracked as a follow-up; see project_qa_channel_smoke_token_scope_gap memory.
  it.todo('403 with bearer token lacking Tutorial.Author scope');
});
