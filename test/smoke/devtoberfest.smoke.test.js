/**
 * Smoke tests for the Devtoberfest homepage + API endpoints.
 *
 * Runs against the deployed approuter + srv (CF DEV by default).
 * Reads SMOKE_BASE_URL / SMOKE_SRV_URL via the shared smoke.config.js.
 *
 * Wired into `npm run test:smoke`; CI's deploy.yml runs this after every deploy.
 *
 * Spec §10.3 — Refs #397
 */
import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Devtoberfest smoke', () => {
  it('GET /devtoberfest/ returns 200 with the mount script', async () => {
    // fetchWithRetry already sets redirect:'manual' so a 302 to /login
    // surfaces as a clear failure instead of being silently followed.
    const res = await fetchWithRetry(`${BASE_URL}/devtoberfest/`);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('devtoberfest-mount');
  });

  it('GET /api/devtoberfest/status returns 200 or 503', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/devtoberfest/status`);
    expect([200, 503]).toContain(res.status);

    const body = await res.json();
    if (res.status === 503) {
      // No active Devtoberfest event configured yet — acceptable on a fresh DEV.
      expect(body.error).toBe('EVENT_NOT_CONFIGURED');
    } else {
      expect(typeof body.joined).toBe('boolean');
      expect(typeof body.termsVersion).toBe('number');
    }
  });

  it('GET /api/devtoberfest/terms returns 200 with text and version', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/devtoberfest/terms`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body.text).toBe('string');
    expect(typeof body.version).toBe('number');
  });

  it('POST /api/devtoberfest/join without auth returns 401', async () => {
    // Send a valid JSON body so the failure is at the auth gate, not the parser.
    const res = await fetchWithRetry(`${SRV_URL}/api/devtoberfest/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ termsVersion: 1 }),
    });
    expect(res.status).toBe(401);
  });
});
