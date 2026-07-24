import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Feedback endpoints (smoke)', () => {
  it('POST /feedback/submit rejects unknown slug with 400', async (ctx) => {
    const res = await fetchWithRetry(`${BASE_URL}/feedback/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tutorialSlug: 'nonexistent-smoke-' + Date.now(),
        wasAuthenticated: false,
        honeypot: ''
      })
    });
    // The handler short-circuits to 503 when SUBMISSION_SALT_SECRET is not
    // provisioned in the target env (srv/server.js), so slug validation never
    // runs. Skip rather than fail where the secret is absent.
    if (res.status === 503) return ctx.skip();
    expect(res.status).toBe(400);
  });

  it('POST /feedback/submit silently accepts honeypot (200)', async (ctx) => {
    const res = await fetchWithRetry(`${BASE_URL}/feedback/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tutorialSlug: 'nonexistent-smoke-' + Date.now(),
        wasAuthenticated: false,
        honeypot: 'bot'
      })
    });
    // 503 => SUBMISSION_SALT_SECRET unset in this env; honeypot path unreachable.
    if (res.status === 503) return ctx.skip();
    expect(res.status).toBe(200);
  });

  it('GET /admin/TutorialFeedback requires auth', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/TutorialFeedback`);
    expect([401, 403]).toContain(res.status);
  });
});
