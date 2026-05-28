// test/admin-slug-history.test.js
//
// Verifies the slug-redirect history written by the admin slug-derive handler
// when a Group/Mission rename changes the slug. See #91 follow-up.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
// Renaming a published Group/Mission carries the `published: true` flag through
// the activation PATCH, which a `_guardPublished` hook in admin-service.js
// rejects for non-SuperAdmin users. Use superadmin so the rename succeeds and
// we exercise the slug-history side effect.
const adminAuth = { auth: { username: 'superadmin', password: 'superadmin' } };

const TAG_ID = 'aaaaaaaa-3333-0000-0000-000000000001';

describe('AdminService: slug-history redirects on rename', () => {
  const cleanup = [];

  beforeAll(async () => {
    const { Tags } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 92301, name: '__TEST__ Slug History Tag' });
  });

  afterAll(async () => {
    for (const url of cleanup) {
      await project.delete(url, adminAuth).catch(() => {});
    }
  });

  // Helper: create + activate (mirrors test/admin-slug-derivation.test.js).
  const createAndActivate = async (entity, body) => {
    const fullBody = {
      description: 'auto', experienceTag: 'beginner', primaryTagRef_ID: TAG_ID,
      ...body,
    };
    const created = await project.post(`/admin/${entity}`, fullBody, {
      ...adminAuth,
      headers: { Prefer: 'handling=lenient' },
    });
    expect(created.status).toBe(201);
    const ID = created.data.ID;
    await project.post(
      `/admin/${entity}(ID=${ID},IsActiveEntity=false)/tags`,
      { tag_ID: TAG_ID },
      adminAuth,
    );
    const activated = await project.post(
      `/admin/${entity}(ID=${ID},IsActiveEntity=false)/AdminService.draftActivate`,
      {},
      adminAuth,
    );
    expect([200, 201]).toContain(activated.status);
    cleanup.push(`/admin/${entity}(ID=${ID},IsActiveEntity=true)`);
    return activated.data;
  };

  // Helper: edit-draft + activate (mirrors what the admin UI does).
  const renameViaEditDraft = async (entity, ID, newTitle) => {
    const editRes = await project.post(
      `/admin/${entity}(ID=${ID},IsActiveEntity=true)/AdminService.draftEdit`,
      {},
      adminAuth,
    );
    expect([200, 201]).toContain(editRes.status);
    await project.patch(
      `/admin/${entity}(ID=${ID},IsActiveEntity=false)`,
      { title: newTitle },
      adminAuth,
    );
    const activated = await project.post(
      `/admin/${entity}(ID=${ID},IsActiveEntity=false)/AdminService.draftActivate`,
      {},
      adminAuth,
    );
    expect([200, 201]).toContain(activated.status);
    return activated.data;
  };

  it('records prior slug in GroupSlugRedirects on rename', async () => {
    const { GroupSlugRedirects } = cds.entities('com.sap.developers.ims');

    const g = await createAndActivate('Groups', { title: '__TEST__ Test Tow' });
    expect(g.slug).toBe('test-test-tow');

    const renamed = await renameViaEditDraft('Groups', g.ID, '__TEST__ Test Two');
    expect(renamed.slug).toBe('test-test-two');

    const history = await SELECT.from(GroupSlugRedirects)
      .where({ group_ID: g.ID })
      .columns('slug');
    expect(history.map(r => r.slug)).toContain('test-test-tow');
  });

  it('records prior slug in MissionSlugRedirects on rename', async () => {
    const { MissionSlugRedirects } = cds.entities('com.sap.developers.ims');

    const m = await createAndActivate('Missions', { title: '__TEST__ Build a CAP App' });
    expect(m.slug).toBe('test-build-a-cap-app');

    const renamed = await renameViaEditDraft('Missions', m.ID, '__TEST__ Build a CAP Application');
    expect(renamed.slug).toBe('test-build-a-cap-application');

    const history = await SELECT.from(MissionSlugRedirects)
      .where({ mission_ID: m.ID })
      .columns('slug');
    expect(history.map(r => r.slug)).toContain('test-build-a-cap-app');
  });

  it('appends each rename to history (chain of historic slugs)', async () => {
    const { GroupSlugRedirects } = cds.entities('com.sap.developers.ims');

    const g = await createAndActivate('Groups', { title: '__TEST__ Chain Alpha' });
    await renameViaEditDraft('Groups', g.ID, '__TEST__ Chain Beta');
    const renamed = await renameViaEditDraft('Groups', g.ID, '__TEST__ Chain Gamma');
    expect(renamed.slug).toBe('test-chain-gamma');

    const history = await SELECT.from(GroupSlugRedirects)
      .where({ group_ID: g.ID })
      .columns('slug');
    const slugs = history.map(r => r.slug).sort();
    expect(slugs).toEqual(['test-chain-alpha', 'test-chain-beta'].sort());
  });

  it('does NOT record history on initial create (no prior slug)', async () => {
    const { GroupSlugRedirects } = cds.entities('com.sap.developers.ims');

    const g = await createAndActivate('Groups', { title: '__TEST__ Fresh Group' });

    const history = await SELECT.from(GroupSlugRedirects)
      .where({ group_ID: g.ID });
    expect(history).toHaveLength(0);
  });

  it('does NOT record history when title (and slug) unchanged on activation', async () => {
    const { GroupSlugRedirects } = cds.entities('com.sap.developers.ims');

    const g = await createAndActivate('Groups', { title: '__TEST__ Unchanged Group' });

    // Edit-draft without changing title, then activate.
    const editRes = await project.post(
      `/admin/Groups(ID=${g.ID},IsActiveEntity=true)/AdminService.draftEdit`,
      {},
      adminAuth,
    );
    expect([200, 201]).toContain(editRes.status);
    // Patch a non-title field.
    await project.patch(
      `/admin/Groups(ID=${g.ID},IsActiveEntity=false)`,
      { description: 'updated description' },
      adminAuth,
    );
    await project.post(
      `/admin/Groups(ID=${g.ID},IsActiveEntity=false)/AdminService.draftActivate`,
      {},
      adminAuth,
    );

    const history = await SELECT.from(GroupSlugRedirects)
      .where({ group_ID: g.ID });
    expect(history).toHaveLength(0);
  });

  it('drops historic record when its slug is reclaimed by another entity (slug-reuse policy)', async () => {
    // Group A renamed away from "shared", later Group B takes "shared".
    // The historic redirect for Group A pointing at "shared" must be dropped.
    const { GroupSlugRedirects } = cds.entities('com.sap.developers.ims');

    const a = await createAndActivate('Groups', { title: '__TEST__ Reuse Shared' });
    expect(a.slug).toBe('test-reuse-shared');
    await renameViaEditDraft('Groups', a.ID, '__TEST__ Reuse Renamed Away');

    // Confirm history was created for a.
    let history = await SELECT.from(GroupSlugRedirects)
      .where({ group_ID: a.ID })
      .columns('slug');
    expect(history.map(r => r.slug)).toContain('test-reuse-shared');

    // Now Group B is created and renamed to take the slug 'test-reuse-shared'.
    const b = await createAndActivate('Groups', { title: '__TEST__ Other' });
    await renameViaEditDraft('Groups', b.ID, '__TEST__ Reuse Shared');
    // Slug derivation should hand B the slug 'test-reuse-shared' since A no
    // longer holds it.

    // History row pointing at 'test-reuse-shared' should be gone (whoever
    // owns the slug now wins). We only check the slug=newSlug path here —
    // when B activated under that title, the deriver dropped the row for
    // 'test-reuse-shared' before it would have inserted any new history for
    // B's vacated 'test-other'.
    const stale = await SELECT.from(GroupSlugRedirects).where({ slug: 'test-reuse-shared' });
    expect(stale).toHaveLength(0);
  });
});
