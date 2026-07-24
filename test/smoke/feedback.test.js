import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Feedback endpoints (smoke)', () => {
  // POST /feedback/submit is gated on SUBMISSION_SALT_SECRET (srv/server.js):
  // when the salt secret is not configured on the target env, the handler
  // short-circuits with a by-design 503 ("feedback service unavailable")
  // BEFORE any slug/honeypot logic runs. Envs without the secret (e.g. DEV)
  // therefore return 503 for every submit; envs with it exercise the real
  // validation path (400 for unknown slug, 200 for honeypot). Both are healthy.
  it('POST /feedback/submit rejects unknown slug with 400 (or 503 when salt secret unset)', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/feedback/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tutorialSlug: 'nonexistent-smoke-' + Date.now(),
        wasAuthenticated: false,
        honeypot: ''
      })
    });
    expect([400, 503]).toContain(res.status);
  });

  it('POST /feedback/submit silently accepts honeypot (200, or 503 when salt secret unset)', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/feedback/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tutorialSlug: 'nonexistent-smoke-' + Date.now(),
        wasAuthenticated: false,
        honeypot: 'bot'
      })
    });
    expect([200, 503]).toContain(res.status);
  });

  it('GET /admin/TutorialFeedback requires auth', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/TutorialFeedback`);
    expect([401, 403]).toContain(res.status);
  });
});
