// test/unit/admin-tutorials-owner-search.test.js
//
// Spec: docs/superpowers/specs/2026-08-05-admin-tutorials-owner-search-filter-design.md
// Verifies the AdminService.Tutorials projection exposes scalar `owner` +
// `ownerEmail` columns flattened from the meta association, and that $search
// matches owner name and owner email (plus a negative control).

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
      ID: cds.utils.uuid(), tutorial_ID: tut.ID, owner: 'Jane Developer', ownerEmail: 'jane@example.com'
    });

    const rows = await cds.tx({ user: new cds.User(ADMIN) }, tx =>
      tx.run(SELECT.from('AdminService.Tutorials').columns('slug', 'owner', 'ownerEmail').where({ slug: 'hana-basics' }))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBe('Jane Developer');
    expect(rows[0].ownerEmail).toBe('jane@example.com');
  });

  it('$search matches owner name and owner email, and excludes non-matches', async () => {
    const match = { ID: cds.utils.uuid(), slug: 'abap-cloud', title: 'ABAP Cloud', legacyId: 9002 };
    const other = { ID: cds.utils.uuid(), slug: 'unrelated-topic', title: 'Unrelated Topic', legacyId: 9003 };
    await INSERT.into(Tutorials).entries([match, other]);
    await INSERT.into(TutorialMeta).entries([
      { ID: cds.utils.uuid(), tutorial_ID: match.ID, owner: 'Rui Nogueira', ownerEmail: 'rui.nogueira@example.com' },
      { ID: cds.utils.uuid(), tutorial_ID: other.ID, owner: 'Someone Else', ownerEmail: 'else@example.com' }
    ]);

    // by owner name — matches only the intended row (negative control)
    const byName = await cds.tx({ user: new cds.User(ADMIN) }, tx =>
      tx.run(SELECT.from('AdminService.Tutorials').columns('slug', 'owner').search('Nogueira'))
    );
    expect(byName.map(r => r.slug)).toEqual(['abap-cloud']);

    // by owner email — same discrimination
    const byEmail = await cds.tx({ user: new cds.User(ADMIN) }, tx =>
      tx.run(SELECT.from('AdminService.Tutorials').columns('slug', 'ownerEmail').search('rui.nogueira@example.com'))
    );
    expect(byEmail.map(r => r.slug)).toEqual(['abap-cloud']);
  });
});
