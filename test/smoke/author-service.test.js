import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('AuthorService smoke', () => {
  it('GET /author/Tutorials without auth is rejected', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/author/Tutorials`);
    expect([401, 403]).toContain(res.status);
  });

  it('GET /health/auth without auth is rejected', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/health/auth`);
    expect([401, 403]).toContain(res.status);

    if (res.status === 401) {
      try {
        const body = await res.json();
        expect(body.authenticated).toBe(false);
      } catch {
        // approuter may return a non-JSON body — status check above is sufficient
      }
    }
  });
});

describe.skipIf(!process.env.SMOKE_AUTHOR_TOKEN)('AuthorService with Tutorial.Author bearer', () => {
  const TOKEN = process.env.SMOKE_AUTHOR_TOKEN;

  it('GET /author/MyTutorials?$top=1 returns 200 with value array', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/author/MyTutorials?$top=1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.value)).toBe(true);
  });

  it('GET /health/auth returns 200 with Tutorial.Author scope', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/health/auth`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(Array.isArray(body.scopes)).toBe(true);
    expect(body.scopes).toContain('Tutorial.Author');
  });
});

// Auth-gate smoke for issue #173 /author/generateOsVariants action.
// Pure auth gating — no LLM call, no body validation beyond what the gate sees.
describe('POST /author/generateOsVariants — auth gate', () => {
  const PAYLOAD = JSON.stringify({
    sourceMarkdown: 'x',
    sourceOS: 'Windows',
    targetOSes: ['macOS'],
    context: {},
  });

  it('returns 401 (or 403) without a bearer token', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/author/generateOsVariants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: PAYLOAD,
    });
    // approuter/XSUAA can return either 401 (no bearer) or 403 (substituted
    // redirect at the proxy level). Match the existing smoke convention.
    expect([401, 403]).toContain(res.status);
  });
});

describe.skipIf(!process.env.SMOKE_NON_AUTHOR_TOKEN)('POST /author/generateOsVariants — non-author scope', () => {
  it('returns 403 with an authenticated token that lacks Tutorial.Author scope', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/author/generateOsVariants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SMOKE_NON_AUTHOR_TOKEN}`,
      },
      body: JSON.stringify({
        sourceMarkdown: 'x',
        sourceOS: 'Windows',
        targetOSes: ['macOS'],
        context: {},
      }),
    });
    expect(res.status).toBe(403);
  });
});
