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

// [#655] Task 4: end-to-end contract for POST /preview/render with rulesVr.
// Canonical rules.vr format — see scripts/parsers/__tests__/compose-rules-vr.test.ts
// and test/srv-qa/preview-renderer.test.js: ###Rule + type on the following line,
// MCQ options in ###Match, AI grading opt-in via ###Grading\nai-judged.
//
// Some assertions only turn green once Hugo + Vue island changes (Tasks 5-11)
// ship: the validation banner + data-has-ai attribute + PreviewAINotice text
// come from the preview layout, not the srv. They are still valid acceptance
// checks for the full feature.
describe.skipIf(!PREVIEW_OK)('POST /preview/render with rulesVr', () => {
  const url = `${SRV_QA}/preview/render`;
  const BASE_MD = '---\nparser: v2\ntitle: Test\ndescription: x\ntime: 5\n---\n\n## You will learn\n- thing\n\n## Prerequisites\n- none\n\n### Step 1\nBody of step 1.\n';

  it('rulesVr with [VALIDATE_1] MCQ: HTML contains question text', async () => {
    const rulesVr = '[VALIDATE_1]\n###Rule\nmultiple-choice\n###Question\nWhat is 2+2?\n###Match\n[X] 4\n[ ] 5\n[VALIDATE_END_1]\n';
    const r = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ markdown: BASE_MD, rulesVr }),
    });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('What is 2+2?');
  });

  it('rulesVr with [AUTOAUTHOR_ALL]: HTML contains AI notice text', async () => {
    // [AUTOAUTHOR_ALL] is a directive (not a question block) — canonical syntax
    // documented in CLAUDE.md "AI-authored quizzes" gotcha.
    const rulesVr = '[AUTOAUTHOR_ALL]\n';
    const r = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ markdown: BASE_MD, rulesVr }),
    });
    expect(r.status).toBe(200);
    const html = await r.text();
    // PreviewAINotice text ships with Hugo Tasks 5/6 — assertion is the
    // acceptance criterion for the full feature.
    expect(html).toMatch(/AI[- ]?(authored|generated|involved)|automatically authored/i);
  });

  it('malformed rulesVr (missing [VALIDATE_END_1]): 200 (parser drops the block silently)', async () => {
    const rulesVr = '[VALIDATE_1]\n###Question\nQ\n';
    const r = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ markdown: BASE_MD, rulesVr }),
    });
    expect(r.status).toBe(200);
  });

  it('markdown-only (no rulesVr field): 200 with banner + data-has-ai="false"', async () => {
    const r = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ markdown: BASE_MD }),
    });
    expect(r.status).toBe(200);
    const html = await r.text();
    // Banner + data-has-ai attribute ship via Hugo Tasks 5/6 — assertions are
    // acceptance checks for the full feature, will pass post-deploy.
    expect(html).toMatch(/preview|qa banner/i);
    expect(html).toContain('data-has-ai="false"');
  });

  it('non-string rulesVr (number): 400', async () => {
    const r = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ markdown: BASE_MD, rulesVr: 42 }),
    });
    expect(r.status).toBe(400);
  });
});
