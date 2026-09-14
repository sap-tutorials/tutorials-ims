// test/unit/hcql-enablement.test.js
//
// #2247 — HCQL re-land on the 5 authenticated services via explicit object-form
// @protocol lists that mount HCQL on distinct /hcql/<svc> paths. Guards the #1004
// regression: OData paths must NOT interpret CQN bodies. Requires @sap/cds >= 10.1.0.
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

// Minimal well-formed CQN SELECT; entity name is irrelevant for the mount/robustness
// assertions (auth + adapter presence are checked before entity resolution).
const CQN = { SELECT: { from: { ref: ['AdminService.Tutorials'] }, limit: { rows: { val: 1 } } } };

describe('HCQL enablement — AdminService', () => {
  const admin = { auth: { username: 'admin', password: 'admin' } };

  it('serves HCQL on its own /hcql/admin path for an authorized principal', async () => {
    const { POST } = project;
    const res = await POST('/hcql/admin', CQN, admin);
    expect([200, 400]).toContain(res.status); // 200 rows or 400 on entity/shape; NOT 404
  });

  it('does NOT mount HCQL on the OData path (POST /admin with CQN is rejected)', async () => {
    const { POST } = project;
    let status;
    try { const r = await POST('/admin', CQN, admin); status = r.status; }
    catch (e) { status = e.response?.status ?? e.status; }
    expect(status).not.toBe(200); // OData path must not accept a CQN body as a query
  });

  it('leaves the OData path clean for a $filter GET', async () => {
    const { GET } = project;
    let status;
    try { const r = await GET("/admin/Tutorials?$filter=slug eq 'x'", admin); status = r.status; }
    catch (e) { status = e.response?.status ?? e.status; }
    expect([200, 404]).toContain(status); // 200 with rows or 404 empty — never a 500 from CQN misparse
  });

  it('survives a malformed CQN body (400, server stays up)', async () => {
    const { POST, GET } = project;
    let status;
    try { const r = await POST('/hcql/admin', { not: 'a query' }, admin); status = r.status; }
    catch (e) { status = e.response?.status ?? e.status; }
    expect([400, 500]).toContain(status);
    // Process must still be alive:
    let alive;
    try { const r = await GET("/admin/Tutorials?$top=1", admin); alive = r.status; }
    catch (e) { alive = e.response?.status ?? e.status; }
    expect(alive).toBeDefined();
  });

  it('rejects an unauthenticated HCQL call', async () => {
    const { POST } = project;
    let status;
    try { const r = await POST('/hcql/admin', CQN); status = r.status; }
    catch (e) { status = e.response?.status ?? e.status; }
    expect([401, 403]).toContain(status);
  });
});

describe.each([
  { svc: 'AuthorService',        odata: '/author',          hcql: '/hcql/author',        user: 'author',        password: '' },
  { svc: 'AnalyticsService',     odata: '/admin/analytics', hcql: '/hcql/analytics',     user: 'admin',         password: 'admin' },
  { svc: 'ExportsService',       odata: '/admin/exports',   hcql: '/hcql/exports',       user: 'admin',         password: 'admin' },
  { svc: 'ConsolidationService', odata: '/api/v1',          hcql: '/hcql/consolidation', user: 'consolidation', password: 'consolidation' },
])('HCQL enablement — $svc', ({ svc, odata, hcql, user, password }) => {
  const auth = { auth: { username: user, password } };
  const cqn = { SELECT: { from: { ref: [`${svc}.dummy`] }, limit: { rows: { val: 1 } } } };

  it('mounts HCQL on its own path (not 404)', async () => {
    const { POST } = project;
    let status;
    try { const r = await POST(hcql, cqn, auth); status = r.status; }
    catch (e) { status = e.response?.status ?? e.status; }
    expect(status).not.toBe(404); // adapter present; 200/400 acceptable
  });

  it('does not accept a CQN body on the OData path', async () => {
    const { POST } = project;
    let status;
    try { const r = await POST(odata, cqn, auth); status = r.status; }
    catch (e) { status = e.response?.status ?? e.status; }
    expect(status).not.toBe(200);
  });

  it('rejects an unauthenticated HCQL call', async () => {
    const { POST } = project;
    let status;
    try { const r = await POST(hcql, cqn); status = r.status; }
    catch (e) { status = e.response?.status ?? e.status; }
    expect([401, 403]).toContain(status);
  });
});
