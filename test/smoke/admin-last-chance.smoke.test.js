import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('admin sendLastChanceEmail smoke', () => {
  it('POST without auth returns 401/403', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/sendLastChanceEmail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorEmail: 'nonexistent-smoke-test@example.com', dryRun: true }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it('POST sendLastChanceEmailsAllDormant without auth returns 401/403', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/sendLastChanceEmailsAllDormant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    expect([401, 403]).toContain(res.status);
  });
});
