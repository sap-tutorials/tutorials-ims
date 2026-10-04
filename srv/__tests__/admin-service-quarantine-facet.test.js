// srv/__tests__/admin-service-quarantine-facet.test.js
//
// #2586 — the Tutorials Object Page surfaces an "Active Quarantine" facet so a
// force-rebuild that DROPPED a tutorial at pre-publish validation no longer
// looks like a silent success. The facet binds to the Tutorials.quarantineCurrent
// association (slug → AdminService.QuarantineEventsCurrent, the #2585 live set).
//
// This tests the ACTUAL service surface: read a Tutorial through AdminService
// with $expand=quarantineCurrent and assert the current quarantine row (reason +
// workflowUrl + buildAt) comes back, and that a healthy tutorial expands empty.
// Seeds QuarantineSnapshots/QuarantineEvents the same way as
// srv/__tests__/lib/rebuild-outcome.test.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const auth = { auth: { username: 'admin', password: 'admin' }, validateStatus: () => true };

const NS = 'com.sap.developers.ims';

const QUARANTINED_SLUG = 'btp-transport-management-cpi-01-use-case';
const HEALTHY_SLUG = 'a-perfectly-fine-tutorial';

describe('Tutorials Object Page — Active Quarantine facet (#2586)', () => {
  beforeAll(async () => {
    await cds.connect.to('db');
    const { Tutorials, QuarantineSnapshots, QuarantineEvents } = cds.entities(NS);

    await DELETE.from(QuarantineEvents);
    await DELETE.from(QuarantineSnapshots);
    await DELETE.from(Tutorials).where({ ID: { in: ['tut-q', 'tut-ok'] } });

    await INSERT.into(Tutorials).entries([
      { ID: 'tut-q', title: 'Quarantined one', slug: QUARANTINED_SLUG },
      { ID: 'tut-ok', title: 'Healthy one', slug: HEALTHY_SLUG },
    ]);

    // Current snapshot drops the quarantined slug; healthy slug is absent from it.
    await INSERT.into(QuarantineSnapshots).entries([
      { ID: 'snap-cur', runId: '100', workflowUrl: 'https://gh/runs/100',
        buildMode: 'full', isCurrent: true, eventCount: 1,
        createdAt: '2026-10-04T10:00:00Z' },
    ]);
    await INSERT.into(QuarantineEvents).entries([
      { ID: 'ev-1', snapshot_ID: 'snap-cur', slug: QUARANTINED_SLUG,
        reason: 'missing required frontmatter field: stepCount',
        sourceUrl: 'https://github.com/sap-tutorials/foo/blob/main/x.md' },
    ]);
  });

  afterAll(async () => {
    const { Tutorials, QuarantineSnapshots, QuarantineEvents } = cds.entities(NS);
    await DELETE.from(QuarantineEvents);
    await DELETE.from(QuarantineSnapshots);
    await DELETE.from(Tutorials).where({ ID: { in: ['tut-q', 'tut-ok'] } });
  });

  it('expands the current quarantine row (reason + workflowUrl + buildAt) for a dropped tutorial', async () => {
    const { data, status } = await project.get(
      `/admin/Tutorials(ID=tut-q,IsActiveEntity=true)?$expand=quarantineCurrent`,
      auth,
    );
    expect(status).toBe(200);
    const rows = data.quarantineCurrent;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('missing required frontmatter field: stepCount');
    expect(rows[0].workflowUrl).toBe('https://gh/runs/100');
    expect(rows[0].sourceUrl).toBe('https://github.com/sap-tutorials/foo/blob/main/x.md');
    expect(rows[0].buildAt).toBeTruthy();
  });

  it('expands empty for a healthy (not-quarantined) tutorial', async () => {
    const { data, status } = await project.get(
      `/admin/Tutorials(ID=tut-ok,IsActiveEntity=true)?$expand=quarantineCurrent`,
      auth,
    );
    expect(status).toBe(200);
    expect(data.quarantineCurrent).toEqual([]);
  });
});
