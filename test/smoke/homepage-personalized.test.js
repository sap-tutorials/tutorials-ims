import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
const USER = process.env.SMOKE_USER;
const PASS = process.env.SMOKE_PASS;

const canRun = !!(BASE && USER && PASS);
const maybe = canRun ? describe : describe.skip;

maybe('deployed personalization endpoint', () => {
  it('returns X-Personalization: 1 on 200', async () => {
    const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
    const r = await fetch(`${BASE}/homepage/personalized`, {
      headers: { Authorization: auth },
    });
    expect([200, 204]).toContain(r.status);
    if (r.status === 200) {
      expect(r.headers.get('cache-control')).toContain('no-store');
      expect(r.headers.get('x-personalization')).toBe('1');
    }
  });

  it.skipIf(!process.env.SMOKE_HYBRID)('reflects prefs on / after preference change', async () => {
    const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
    // 1. Set role=developer so the endpoint has a non-empty profile to work with.
    const setPrefs = await fetch(`${BASE}/api/setLearningPreferences`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'developer' }),
    });
    expect(setPrefs.ok).toBe(true);
    // 2. Fetch the personalized envelope.
    const r = await fetch(`${BASE}/homepage/personalized`, {
      headers: { Authorization: auth },
    });
    // Kill switch may be off on this environment — either outcome is acceptable.
    expect([200, 204]).toContain(r.status);
    if (r.status === 200) {
      const body = await r.json();
      // Developer tilt puts build first.
      expect(body.verbOrder[0]).toBe('build');
    }
  });
});
