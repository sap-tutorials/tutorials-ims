// test/admin-published-guard.test.js
//
// Regression for #2111: a non-SuperAdmin Admin/Author editing only the
// description (or title) of an already-published Group/Mission was rejected
// with 403 "Only SuperAdmin can change the published state". The draft
// activation PATCH echoes the unchanged `published: true` flag, and the old
// guard treated the mere *presence* of `published` in the payload as a change.
//
// The guard must reject only when the incoming `published` value actually
// DIFFERS from the currently persisted value.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const superAuth = { auth: { username: 'superadmin', password: 'superadmin' } };
// `admin` has Admin (+ Tutorial.Author) but NOT SuperAdmin — the issue user.
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

const TAG_ID = 'aaaaaaaa-3333-0000-0000-000000000911';

describe('AdminService: published write-guard (#2111)', () => {
  const cleanup = [];

  beforeAll(async () => {
    const { Tags } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 92911, name: '__TEST__ Published Guard Tag' });
  });

  afterAll(async () => {
    for (const url of cleanup) await project.delete(url, superAuth).catch(() => {});
  });

  // Create + activate a Group as SuperAdmin, optionally published.
  const createGroup = async (title, { published = false } = {}) => {
    const created = await project.post('/admin/Groups', {
      title, description: 'initial', experienceTag: 'beginner', primaryTagRef_ID: TAG_ID, published,
    }, { ...superAuth, headers: { Prefer: 'handling=lenient' } });
    expect(created.status).toBe(201);
    const ID = created.data.ID;
    await project.post(
      `/admin/Groups(ID=${ID},IsActiveEntity=false)/tags`, { tag_ID: TAG_ID }, superAuth);
    const activated = await project.post(
      `/admin/Groups(ID=${ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, superAuth);
    expect([200, 201]).toContain(activated.status);
    cleanup.push(`/admin/Groups(ID=${ID},IsActiveEntity=true)`);
    return activated.data;
  };

  const editDescriptionAs = async (auth, ID) => {
    const edit = await project.post(
      `/admin/Groups(ID=${ID},IsActiveEntity=true)/AdminService.draftEdit`, {}, auth);
    expect([200, 201]).toContain(edit.status);
    await project.patch(
      `/admin/Groups(ID=${ID},IsActiveEntity=false)`, { description: 'edited by admin' }, auth);
    return project.post(
      `/admin/Groups(ID=${ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, auth);
  };

  it('lets a non-SuperAdmin edit the description of a PUBLISHED group', async () => {
    const g = await createGroup('__TEST__ Pub Guard Published', { published: true });
    expect(g.published).toBe(true);

    const res = await editDescriptionAs(adminAuth, g.ID);
    expect([200, 201]).toContain(res.status);
    expect(res.data.description).toBe('edited by admin');
    expect(res.data.published).toBe(true); // unchanged
  });

  it('lets a non-SuperAdmin edit the description of an UNPUBLISHED group', async () => {
    const g = await createGroup('__TEST__ Pub Guard Unpublished', { published: false });
    const res = await editDescriptionAs(adminAuth, g.ID);
    expect([200, 201]).toContain(res.status);
    expect(res.data.description).toBe('edited by admin');
  });

  it('STILL rejects a non-SuperAdmin actually flipping published true→false', async () => {
    const g = await createGroup('__TEST__ Pub Guard Flip', { published: true });
    await project.post(
      `/admin/Groups(ID=${g.ID},IsActiveEntity=true)/AdminService.draftEdit`, {}, adminAuth);
    const res = await project.patch(
      `/admin/Groups(ID=${g.ID},IsActiveEntity=false)`, { published: false }, adminAuth)
      .catch(e => e.response ?? e);
    expect(res.status).toBe(403);
  });

  it('lets a SuperAdmin flip published false→true', async () => {
    const g = await createGroup('__TEST__ Pub Guard SA Flip', { published: false });
    await project.post(
      `/admin/Groups(ID=${g.ID},IsActiveEntity=true)/AdminService.draftEdit`, {}, superAuth);
    const patched = await project.patch(
      `/admin/Groups(ID=${g.ID},IsActiveEntity=false)`, { published: true }, superAuth);
    expect(patched.status).toBe(200);
    const activated = await project.post(
      `/admin/Groups(ID=${g.ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, superAuth);
    expect([200, 201]).toContain(activated.status);
    expect(activated.data.published).toBe(true);
  });
});
