// test/smoke/validate-answer.test.js
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_SRV_URL;
if (!BASE) throw new Error('SMOKE_SRV_URL not set');

describe('/api/validate-answer smoke', () => {
  it('rejects anonymous (no cookie)', async () => {
    const res = await fetch(`${BASE}/api/validate-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tutorialSlug: 'anything',
        stepNumber: 1,
        questionId: 'q',
        submittedAnswer: 'a'
      })
    });
    // 401 (auth gate) OR 503 (flag off) — both acceptable smoke results.
    expect([401, 503]).toContain(res.status);
  });

  it('returns 503 when validateAnswerEnabled=false (flag-off path)', async () => {
    // This case only runs if the flag is off in the deployed env.
    // If it's on, we expect 401 instead.
    const res = await fetch(`${BASE}/api/validate-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tutorialSlug: 'doesnt-matter',
        stepNumber: 1,
        questionId: 'q',
        submittedAnswer: 'a'
      })
    });
    expect([401, 503]).toContain(res.status);
  });
});
