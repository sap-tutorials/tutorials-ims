// test/smoke/author-scope-routes.smoke.test.js
//
// Spec: docs/superpowers/specs/2026-06-25-617-author-tile-design.md
// Plan task 17.
//
// Post-deploy gates for the Tutorial.Author scope routes. Verifies the
// approuter + OData backend chain end-to-end for an author-scoped user:
//
//   1. Admin-shell static (/admin-ui/) is reachable (it gates by login,
//      not by scope — authors land on the shell and the shell decides
//      which tiles to show based on /auth/user).
//   2. Admin OData (/admin/*) is forbidden for author scope (no
//      cds.Admin / IMS_Admin role).
//   3. Author OData (/author/*) is reachable for author scope.
//   4. Analytics UI is reachable (gated by login).
//   5. /auth/user reflects isAuthor: true for the token holder.
//
// The describe.skipIf guard means this suite is silently skipped when
// SMOKE_BASE_URL or SMOKE_AUTHOR_TOKEN is not provided. In CI these are
// set by the post-deploy smoke step; locally, Tom can run them by
// exporting both env vars before `npm run test:smoke`.

import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

const AUTHOR_TOKEN = process.env.SMOKE_AUTHOR_TOKEN;

describe.skipIf(!BASE_URL || !AUTHOR_TOKEN)('#617 author scope routes (smoke)', () => {
  const headers = { Authorization: `Bearer ${AUTHOR_TOKEN}` };

  it('GET /admin-ui/index.html returns 200', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/admin-ui/index.html`, { headers });
    expect(res.status).toBe(200);
  });

  it('GET /admin/Tutorials returns 403 (author scope cannot reach admin OData)', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/Tutorials?$top=1`, { headers });
    expect(res.status).toBe(403);
  });

  it('GET /author/Tutorials returns 200', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/author/Tutorials?$top=1`, { headers });
    expect(res.status).toBe(200);
  });

  it('GET /admin/Missions returns 403 (author scope cannot reach admin OData)', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/Missions?$top=1`, { headers });
    expect(res.status).toBe(403);
  });

  it('GET /analytics-ui/ returns 200', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/analytics-ui/`, { headers });
    expect(res.status).toBe(200);
  });

  it('GET /author/CompletionAnalytics returns 200', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/author/CompletionAnalytics?$top=1`, { headers });
    expect(res.status).toBe(200);
  });

  it('GET /auth/user returns isAuthor:true', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/auth/user`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isAuthor).toBe(true);
  });
});
