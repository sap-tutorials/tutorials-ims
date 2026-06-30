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

  it('POST /admin/Tutorials(<id>)/AdminService.rebuildContent without auth is rejected', async () => {
    // Any valid-shape UUID; the request should be rejected at the auth layer
    // long before the handler ever runs, so the ID need not exist in DB.
    const url = `${SRV_URL}/admin/Tutorials(ID=00000000-0000-0000-0000-000000000001,IsActiveEntity=true)/AdminService.rebuildContent`;
    const res = await fetchWithRetry(url, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect([401, 403]).toContain(res.status);
  });

  it('GET /display/getLeaderboard without auth is rejected', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/display/getLeaderboard`);
    expect([401, 403]).toContain(res.status);
  });

  it('POST /content/orphan-purge without auth is rejected', async () => {
    // The new orphan-purge endpoint is gated by contentAuthMiddleware
    // (same model as /content/publish). CI uses CONTENT_API_KEY as the
    // bearer; an unauthenticated call must be rejected at the auth layer.
    const res = await fetchWithRetry(`${SRV_URL}/content/orphan-purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slugs: [] })
    });
    expect([401, 403]).toContain(res.status);
  });
});
