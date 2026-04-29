import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Auth enforcement', () => {
  it('GET /api/getProgress without auth is rejected', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/getProgress`);
    expect([401, 403]).toContain(res.status);
  });

  it('GET /admin/Tutorials without auth is rejected', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/Tutorials`);
    expect([401, 403]).toContain(res.status);
  });

  it('GET /display/getLeaderboard without auth is rejected', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/display/getLeaderboard`);
    expect([401, 403]).toContain(res.status);
  });
});
