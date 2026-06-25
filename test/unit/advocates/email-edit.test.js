import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

// Test-isolated user + advocate fixtures. Created in beforeAll, cleaned
// in afterAll. Keeps the test independent from api.test.js's shared seeds.
let userID;       // a Users row to link to
let userNoEmail;  // a Users row with email=null (anonymized-cascade-style)
let advLinked;    // advocate row linked to userID
let advUnlinked;  // advocate row with no user

beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Users, Advocates } = cds.entities('com.sap.developers.ims');
  userID = randomUUID();
  userNoEmail = randomUUID();
  advLinked = randomUUID();
  advUnlinked = randomUUID();
  await db.run(INSERT.into(Users).entries([
    { ID: userID,      sapId: '__test__I100', firstName: 'Tom', lastName: 'Test', email: 'old@sap.com',  displayName: 'Tom Test' },
    { ID: userNoEmail, sapId: '__test__I101', firstName: 'Una', lastName: 'Test', email: null,           displayName: 'Una Test' },
  ]));
  await db.run(INSERT.into(Advocates).entries([
    { ID: advLinked,   slug: '__test__email-1', firstName: '__TEST__', lastName: 'Linked',   region: 'AMERICAS', isActive: true, user_ID: userID },
    { ID: advUnlinked, slug: '__test__email-2', firstName: '__TEST__', lastName: 'Unlinked', region: 'AMERICAS', isActive: true, user_ID: null   },
  ]));
});

afterAll(async () => {
  const db = await cds.connect.to('db');
  const { Users, Advocates } = cds.entities('com.sap.developers.ims');
  await db.run(DELETE.from(Advocates).where({ ID: { in: [advLinked, advUnlinked] } }));
  await db.run(DELETE.from(Users).where({ ID: { in: [userID, userNoEmail] } }));
});

// Reset Users.email for userID before each test so test ordering / parallel
// mode can't leak state between cases. Also discard any leftover drafts.
beforeEach(async () => {
  const db = await cds.connect.to('db');
  const { Users, Advocates } = cds.entities('com.sap.developers.ims');
  await db.run(UPDATE(Users).where({ ID: userID }).set({ email: 'old@sap.com' }));
  // Clean stale drafts from previous test cases so draftEdit doesn't 409.
  // The draft companion lives on the AdminService projection, not on the
  // base ims model — go through the service to discard properly.
  const adminSrv = await cds.connect.to('AdminService');
  for (const id of [advLinked, advUnlinked]) {
    try {
      await adminSrv.send({
        event: 'CANCEL',
        entity: 'AdminService.Advocates',
        params: [{ ID: id, IsActiveEntity: false }],
      });
    } catch {
      // No draft existed — fine.
    }
  }
  // Belt-and-braces: drop via DB in case CANCEL didn't catch it.
  try {
    if (Advocates.drafts) {
      await db.run(DELETE.from(Advocates.drafts).where({ ID: { in: [advLinked, advUnlinked] } }));
    }
  } catch {
    // ignored
  }
});

/**
 * Helper: run a Fiori draft flow against an Advocates row and return the
 * activateRes so callers can assert on success/failure. Draft-enabled
 * entities reject direct PATCH on IsActiveEntity=true with 501; the OData
 * contract is draftEdit -> patch draft -> draftActivate.
 *
 * On PATCH or activate failure the helper discards the draft so the next
 * test doesn't hit a 409 ("draft already exists") in draftEdit.
 */
async function draftUpdate(advocateID, payload) {
  const editRes = await project.post(
    `/admin/Advocates(ID=${advocateID},IsActiveEntity=true)/AdminService.draftEdit`,
    {},
    { ...adminAuth, validateStatus: () => true },
  );
  if (editRes.status >= 300) return editRes;
  const patchRes = await project.patch(
    `/admin/Advocates(ID=${advocateID},IsActiveEntity=false)`,
    payload,
    { ...adminAuth, validateStatus: () => true },
  );
  if (patchRes.status >= 300) {
    // Discard the draft so the next test isn't blocked by a 409.
    await project.delete(
      `/admin/Advocates(ID=${advocateID},IsActiveEntity=false)`,
      { ...adminAuth, validateStatus: () => true },
    );
    return patchRes;
  }
  const activateRes = await project.post(
    `/admin/Advocates(ID=${advocateID},IsActiveEntity=false)/AdminService.draftActivate`,
    {},
    { ...adminAuth, validateStatus: () => true },
  );
  if (activateRes.status >= 300) {
    await project.delete(
      `/admin/Advocates(ID=${advocateID},IsActiveEntity=false)`,
      { ...adminAuth, validateStatus: () => true },
    );
  }
  return activateRes;
}

describe('Advocates.emailEdit virtual field', () => {
  it('hydrates emailEdit from Users.email on READ for linked advocates', async () => {
    const res = await project.get('/admin/Advocates(ID=' + advLinked + ',IsActiveEntity=true)', adminAuth);
    expect(res.status).toBe(200);
    expect(res.data.emailEdit).toBe('old@sap.com');
  });

  it('emailEdit is null on READ when no user is linked', async () => {
    const res = await project.get('/admin/Advocates(ID=' + advUnlinked + ',IsActiveEntity=true)', adminAuth);
    expect(res.status).toBe(200);
    expect(res.data.emailEdit ?? null).toBeNull();
  });

  it('UPDATE emailEdit propagates to Users.email and re-hydrates on response', async () => {
    const res = await draftUpdate(advLinked, { emailEdit: 'New@SAP.com' });
    expect(res.status).toBeLessThan(300);
    expect(res.data.emailEdit).toBe('new@sap.com');  // lowercased

    const db = await cds.connect.to('db');
    const { Users } = cds.entities('com.sap.developers.ims');
    const row = await db.run(SELECT.one.from(Users).where({ ID: userID }));
    expect(row.email).toBe('new@sap.com');
  });

  it('UPDATE rejects with EMAIL_REQUIRES_LINKED_USER when advocate has no user', async () => {
    const res = await draftUpdate(advUnlinked, { emailEdit: 'x@y.com' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toMatch(/EMAIL_REQUIRES_LINKED_USER/);
  });

  it('UPDATE rejects malformed email with EMAIL_INVALID', async () => {
    const res = await draftUpdate(advLinked, { emailEdit: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toMatch(/EMAIL_INVALID/);
  });

  it('draft-activate propagates emailEdit (SAVE on .drafts)', async () => {
    // 1. PUT (open draft) on the active row
    const draftRes = await project.post(
      "/admin/Advocates(ID=" + advLinked + ",IsActiveEntity=true)/AdminService.draftEdit",
      {},
      adminAuth,
    );
    expect(draftRes.status).toBeLessThan(300);
    // 2. PATCH the draft with a new emailEdit value
    const patchRes = await project.patch(
      '/admin/Advocates(ID=' + advLinked + ',IsActiveEntity=false)',
      { emailEdit: 'draft-saved@sap.com' },
      adminAuth,
    );
    expect(patchRes.status).toBeLessThan(300);
    // 3. Activate (the SAVE-on-drafts path)
    const activateRes = await project.post(
      '/admin/Advocates(ID=' + advLinked + ',IsActiveEntity=false)/AdminService.draftActivate',
      {},
      adminAuth,
    );
    expect(activateRes.status).toBeLessThan(300);
    // 4. Assert Users.email reflects the draft-saved value
    const db = await cds.connect.to('db');
    const { Users } = cds.entities('com.sap.developers.ims');
    const row = await db.run(SELECT.one.from(Users).where({ ID: userID }));
    expect(row.email).toBe('draft-saved@sap.com');
  });
});
