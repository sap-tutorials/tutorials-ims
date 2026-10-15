// test/unit/url-health-check-job.test.js
//
// #2787 — url-health-check job: probe active targets + honour linkStatusOverride.
//
// Seeds mirror test/unit/health-url-resolver.test.js:
//   - cds.test(cds.root) at module level
//   - beforeEach / afterEach for setup / teardown
//   - INSERT.into(E.*) via CQL globals

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';

cds.test(cds.root);

afterEach(() => vi.restoreAllMocks());

describe('runUrlHealthCheck', () => {
  let db;

  beforeEach(async () => {
    db = await cds.connect.to('db');
    const E = cds.entities(NS);

    // Seed 1: ACTIVE tutorial to probe — fetch will return 200 OK.
    await db.run(INSERT.into(E.Tutorials).entries(
      { ID: 'uhc-probe', legacyId: 8001, slug: 'probe-tut', status: 'ACTIVE' },
    ));

    // Seed 2: ACTIVE tutorial with override 'OK' — fetch will return 404
    // but override must win and row must keep linkStatus='OK'.
    await db.run(INSERT.into(E.Tutorials).entries(
      { ID: 'uhc-pinned', legacyId: 8002, slug: 'pinned-tut', status: 'ACTIVE', linkStatusOverride: 'OK' },
    ));
  });

  afterEach(async () => {
    const E = cds.entities(NS);
    await db.run(DELETE.from(E.Tutorials).where({ ID: { in: ['uhc-probe', 'uhc-pinned'] } }));
  });

  it('probes active targets and writes linkStatus/lastChecked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    const { runUrlHealthCheck } = await import('../../srv/jobs/url-health-check-job.js');
    const res = await runUrlHealthCheck('test-log-1', {});
    expect(res.ok).toBeGreaterThanOrEqual(1);
    const { Tutorials } = cds.entities(NS);
    const [t] = await db.run(SELECT.from(Tutorials).columns('linkStatus', 'lastChecked').where({ slug: 'probe-tut' }));
    expect(t.linkStatus).toBe('OK');
    expect(t.lastChecked).toBeTruthy();
  });

  it('does not re-probe an overridden row', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { runUrlHealthCheck } = await import('../../srv/jobs/url-health-check-job.js');
    await runUrlHealthCheck('test-log-2', {});
    const { Tutorials } = cds.entities(NS);
    const [t] = await db.run(SELECT.from(Tutorials).columns('linkStatus').where({ slug: 'pinned-tut' }));
    expect(t.linkStatus).toBe('OK'); // override wins despite 404
  });
});
