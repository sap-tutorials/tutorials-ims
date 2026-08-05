// test/unit/admin-tutorials-owner-search.test.js
//
// Spec: docs/superpowers/specs/2026-08-05-admin-tutorials-owner-search-filter-design.md
// Verifies the AdminService.Tutorials projection exposes a scalar `owner`
// column flattened from meta.owner, and that $search matches owner text.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const ADMIN = { id: 'admin@test', roles: ['Admin'] };

describe('AdminService.Tutorials owner search', () => {
  let Tutorials, TutorialMeta;

  beforeAll(async () => {
    ({ Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(TutorialMeta);
    await DELETE.from(Tutorials);
  });

  it('exposes a scalar owner column flattened from meta.owner', async () => {
    const tut = { ID: cds.utils.uuid(), slug: 'hana-basics', title: 'HANA Basics', legacyId: 9001 };
    await INSERT.into(Tutorials).entries(tut);
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(), tutorial_ID: tut.ID, owner: 'Jane Developer'
    });

    const rows = await cds.tx({ user: new cds.User(ADMIN) }, tx =>
      tx.run(SELECT.from('AdminService.Tutorials').columns('slug', 'owner').where({ slug: 'hana-basics' }))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBe('Jane Developer');
  });

  it('$search matches owner text', async () => {
    const tut = { ID: cds.utils.uuid(), slug: 'abap-cloud', title: 'ABAP Cloud', legacyId: 9002 };
    await INSERT.into(Tutorials).entries(tut);
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(), tutorial_ID: tut.ID, owner: 'Rui Nogueira'
    });

    const rows = await cds.tx({ user: new cds.User(ADMIN) }, tx =>
      tx.run(SELECT.from('AdminService.Tutorials').columns('slug', 'owner').search('Nogueira'))
    );
    expect(rows.map(r => r.slug)).toContain('abap-cloud');
  });
});
