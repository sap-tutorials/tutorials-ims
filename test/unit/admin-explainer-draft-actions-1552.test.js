import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';

const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

// #1552 — the OP-header bound actions (regenerate / markReviewed) must work
// when the Object Page is in EDIT mode. In edit mode Fiori Elements binds the
// page to the draft shadow (IsActiveEntity=false) and POSTs the bound action
// to `Entity.drafts`. Before the fix, handlers were registered only on the
// active entity, so CAP returned 501 "no handler for regenerate
// AdminService.HomepageShelves.drafts" — surfaced to the user as
// "The server does not support the functionality required to fulfill the request."
describe('#1552 — bound explainer actions in draft/edit mode', () => {
  const project = cds.test('serve', '--project', '.', '--in-memory');
  const testImpl = vi.fn();

  beforeAll(async () => {
    await project;
    globalThis.__EXPLAINER_GENERATOR_TEST_IMPL__ = testImpl;
  });
  afterAll(() => { delete globalThis.__EXPLAINER_GENERATOR_TEST_IMPL__; });

  beforeEach(async () => {
    testImpl.mockReset();
    testImpl.mockResolvedValue({ tagline: 'Draft tagline', whyItMatters: 'Draft why.', costCents: 7 });
  });

  // Matrix over the three overloaded entities. Each seeds a distinct row and
  // drives edit → bound action on the draft → assert 200 + draft shadow written.
  const CASES = [
    { entity: 'HomepageShelves',  ns: 'com.sap.developers.ims.HomepageShelves',
      seed: (ID) => ({ ID, verb: 'LEARN', shelf: 'START_HERE', title: 't', url: 'https://e.com/x', sortOrder: 1, authoringStatus: 'BLANK' }) },
    { entity: 'VerbDefinitions',  ns: 'com.sap.developers.ims.VerbDefinitions',
      seed: (ID) => ({ ID, verbKey: 'LEARN', label: 'L', authoringStatus: 'BLANK' }) },
    { entity: 'ShelfDefinitions', ns: 'com.sap.developers.ims.ShelfDefinitions',
      seed: (ID) => ({ ID, shelfKey: 'START_HERE', label: 'S', authoringStatus: 'BLANK' }) },
  ];

  for (const c of CASES) {
    it(`${c.entity}: bound regenerate in EDIT mode returns 200 (not 501) and writes the draft`, async () => {
      const ID = '00000000-0000-0000-0000-0000000000' + (CASES.indexOf(c) + 10);
      const db = await cds.connect.to('db');
      await db.run(DELETE.from(c.ns));
      await db.run(INSERT.into(c.ns).entries([c.seed(ID)]));

      const edit = await project.post(
        `/admin/${c.entity}(ID=${ID},IsActiveEntity=true)/AdminService.draftEdit`,
        { PreserveChanges: true }, ADMIN_AUTH).catch(e => e.response);
      expect(edit.status, 'draftEdit').toBe(201);

      const res = await project.post(
        `/admin/${c.entity}(ID=${ID},IsActiveEntity=false)/AdminService.regenerate`,
        {}, ADMIN_AUTH).catch(e => e.response);
      expect(res.status, `regenerate on draft (${c.entity})`).toBe(200);
      expect(res.data.processed).toBe(1);

      // The change must land on the DRAFT shadow (edit-session visibility),
      // not the active row (invisible mid-edit, lost on discard).
      const srv = await cds.connect.to('AdminService');
      const draftRow = await db.run(SELECT.one.from(srv.entities[c.entity].drafts).where({ ID }));
      expect(draftRow.tagline).toBe('Draft tagline');
      expect(draftRow.authoringStatus).toBe('AI_SEEDED');
    });

    it(`${c.entity}: bound markReviewed in EDIT mode returns 200 (not 501) and flips draft status`, async () => {
      const ID = '00000000-0000-0000-0000-0000000000' + (CASES.indexOf(c) + 20);
      const db = await cds.connect.to('db');
      await db.run(DELETE.from(c.ns));
      await db.run(INSERT.into(c.ns).entries([{ ...c.seed(ID), authoringStatus: 'AI_SEEDED' }]));

      const edit = await project.post(
        `/admin/${c.entity}(ID=${ID},IsActiveEntity=true)/AdminService.draftEdit`,
        { PreserveChanges: true }, ADMIN_AUTH).catch(e => e.response);
      expect(edit.status).toBe(201);

      const res = await project.post(
        `/admin/${c.entity}(ID=${ID},IsActiveEntity=false)/AdminService.markReviewed`,
        {}, ADMIN_AUTH).catch(e => e.response);
      expect(res.status, `markReviewed on draft (${c.entity})`).toBe(200);

      const srv = await cds.connect.to('AdminService');
      const draftRow = await db.run(SELECT.one.from(srv.entities[c.entity].drafts).where({ ID }));
      expect(draftRow.authoringStatus).toBe('REVIEWED');
    });
  }

  // Active-mode (Display) still works — regression guard so the draft fix
  // doesn't break the non-edit path.
  it('HomepageShelves: bound regenerate on ACTIVE entity still returns 200', async () => {
    const ID = '00000000-0000-0000-0000-0000000000ff';
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.HomepageShelves'));
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries([
      { ID, verb: 'LEARN', shelf: 'START_HERE', title: 't', url: 'https://e.com/x', sortOrder: 1, authoringStatus: 'BLANK' },
    ]));
    const res = await project.post(
      `/admin/HomepageShelves(ID=${ID},IsActiveEntity=true)/AdminService.regenerate`,
      {}, ADMIN_AUTH).catch(e => e.response);
    expect(res.status).toBe(200);
    expect(res.data.processed).toBe(1);
    const active = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves').where({ ID }));
    expect(active.authoringStatus).toBe('AI_SEEDED');
  });
});

// #1552 — compile-time guards for the display-mode refresh + missing labels.
describe('#1552 — SideEffects + field labels (compile-time)', () => {
  let csn;
  beforeAll(async () => { csn = await cds.load(['srv', 'app', 'db']); });

  const ENTITIES = ['AdminService.HomepageShelves', 'AdminService.VerbDefinitions', 'AdminService.ShelfDefinitions'];

  // Without @Common.SideEffects, invoking regenerate/markReviewed in DISPLAY
  // mode returns 200 but the OP keeps showing stale content until reload — the
  // "nothing happened" symptom in #1552. The annotation makes FE re-fetch.
  for (const entityName of ENTITIES) {
    it(`${entityName}: regenerate + markReviewed carry @Common.SideEffects.TargetProperties`, () => {
      const entity = csn.definitions[entityName];
      expect(entity, entityName).toBeTruthy();
      for (const action of ['regenerate', 'markReviewed']) {
        const def = entity.actions?.[action];
        expect(def, `${entityName}.${action}`).toBeTruthy();
        // CSN flattens @Common.SideEffects.TargetProperties to a dotted key.
        const targets = def['@Common.SideEffects.TargetProperties'];
        expect(Array.isArray(targets) && targets.length > 0,
          `${entityName}.${action} @Common.SideEffects.TargetProperties`).toBe(true);
        expect(targets).toContain('_it/authoringStatus');
      }
    });
  }

  // Fields that previously rendered with technical element names on the OP
  // edit screen must now have a friendly @Common.Label.
  const LABEL_EXPECTATIONS = {
    'AdminService.HomepageShelves': ['sortOrder', 'title', 'url', 'description', 'isExternal', 'isActive', 'tagline', 'whyItMatters'],
    'AdminService.VerbDefinitions': ['label', 'iconName', 'sortOrder', 'tagline', 'whyItMatters'],
    'AdminService.ShelfDefinitions': ['label', 'iconName', 'sortOrder', 'tagline', 'whyItMatters'],
  };
  for (const [entityName, fields] of Object.entries(LABEL_EXPECTATIONS)) {
    it(`${entityName}: form fields have @Common.Label`, () => {
      const entity = csn.definitions[entityName];
      for (const f of fields) {
        const el = entity.elements?.[f];
        expect(el, `${entityName}.${f} element`).toBeTruthy();
        expect(el['@Common.Label'], `${entityName}.${f} @Common.Label`).toBeTruthy();
      }
    });
  }
});
