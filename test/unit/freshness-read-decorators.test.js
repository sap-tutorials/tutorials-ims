// test/unit/freshness-read-decorators.test.js
// Task 8: after('READ') decorators for freshness worklist virtuals + criticality badges.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const ADMIN = { id: 'admin@test', roles: ['Admin'] };

describe('freshness read decorators', () => {
  let srv;
  beforeAll(async () => { srv = await cds.connect.to('AdminService'); });

  it('sets openHighCount + freshnessCriticality on Tutorials', async () => {
    const { Tutorials, FreshnessReport, FreshnessFinding } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid(); const rid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'w', title: 'W', legacyId: 31 });
    await INSERT.into(FreshnessReport).entries({ ID: rid, tutorial_ID: tid, status: 'DONE', openHighCount: 2 });
    await INSERT.into(FreshnessFinding).entries({ ID: cds.utils.uuid(), report_ID: rid, tutorial_ID: tid, fingerprint: 'a', category: 'obsolete-dep', severity: 'High', confidence: 'High', disposition: 'OPEN' });

    const row = await srv.tx({ user: ADMIN }, tx =>
      tx.run(SELECT.one.from('AdminService.Tutorials').columns('ID', 'openHighCount', 'freshnessCriticality').where({ ID: tid }))
    );
    expect(row.openHighCount).toBe(2);
    expect(row.freshnessCriticality).toBe(1);   // >0 open-high ⇒ red
  });

  it('maps confidence to criticality on findings', async () => {
    const { Tutorials, FreshnessReport, FreshnessFinding } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid(); const rid = cds.utils.uuid(); const fid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'w2', title: 'W2', legacyId: 32 });
    await INSERT.into(FreshnessReport).entries({ ID: rid, tutorial_ID: tid, status: 'DONE' });
    await INSERT.into(FreshnessFinding).entries({ ID: fid, report_ID: rid, tutorial_ID: tid, fingerprint: 'b', category: 'obsolete-dep', severity: 'High', confidence: 'High', disposition: 'OPEN' });
    const f = await srv.tx({ user: ADMIN }, tx =>
      tx.run(SELECT.one.from('AdminService.FreshnessFinding').columns('ID', 'confidence', 'confidenceCriticality').where({ ID: fid }))
    );
    expect(f.confidenceCriticality).toBe(1);   // High confidence ⇒ red
  });
});
