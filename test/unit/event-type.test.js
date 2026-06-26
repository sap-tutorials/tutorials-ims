import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Boot a tiny in-memory CAP service with the project's full model.
// Same pattern as test/admin-service.test.js:4 — keeps test isolation
// by giving us our own SQLite db with the freshly-deployed schema.
const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('Events.eventType enum', () => {
  let Events;

  beforeAll(() => {
    Events = cds.entities('com.sap.developers.ims').Events;
  });

  it("defaults to 'OTHER' when not specified on INSERT", async () => {
    const ID = 'evt-default-test-0001';
    await INSERT.into(Events).entries({
      ID,
      legacyId: 990001,
      name: 'Default Test Event',
      startDate: '2026-01-01T00:00:00Z',
      endDate: '2026-01-02T00:00:00Z',
      timeZone: '+00:00'
    });
    const row = await SELECT.one.from(Events).where({ ID });
    expect(row.eventType).toBe('OTHER');
  });

  it.each(['DEVTOBERFEST', 'TECHED', 'CODEJAM', 'CHALLENGE', 'OTHER'])(
    'accepts eventType %s on INSERT', async (v) => {
      const values = ['DEVTOBERFEST', 'TECHED', 'CODEJAM', 'CHALLENGE', 'OTHER'];
      const ID = `evt-valid-${v.toLowerCase()}`;
      await INSERT.into(Events).entries({
        ID,
        legacyId: 990100 + values.indexOf(v),
        name: `Valid ${v}`,
        startDate: '2026-01-01T00:00:00Z',
        endDate: '2026-01-02T00:00:00Z',
        timeZone: '+00:00',
        eventType: v
      });
      const row = await SELECT.one.from(Events).where({ ID });
      expect(row.eventType).toBe(v);
    }
  );

  it('rejects an out-of-range value via @assert.range', async () => {
    // @assert.range is enforced at the OData protocol layer. For a draft-enabled
    // entity, validation fires on draftActivate, not on the initial draft POST
    // (draft creation accepts any value). So: create the draft, then attempt to
    // activate it — activation should 400 with an ASSERT_RANGE error.
    // adminAuth satisfies the @requires guard on AdminService.
    const createRes = await project.post(
      '/admin/Events',
      {
        name: 'Bad Range Event',
        startDate: '2026-01-01T00:00:00Z',
        endDate: '2026-01-02T00:00:00Z',
        timeZone: '+00:00',
        eventType: 'NOT_A_REAL_TYPE'
      },
      { ...adminAuth, validateStatus: () => true }
    );
    expect(createRes.status).toBe(201);
    const draftId = createRes.data.ID;

    const activateRes = await project.post(
      `/admin/Events(ID=${draftId},IsActiveEntity=false)/AdminService.draftActivate`,
      {},
      { ...adminAuth, validateStatus: () => true }
    );
    expect(activateRes.status).toBe(400);
    // Error body shape varies slightly across CAP versions; assert the
    // message mentions the range guard.
    const errorMessage = JSON.stringify(activateRes.data);
    expect(errorMessage).toMatch(/ASSERT_RANGE|ASSERT_ENUM|range/i);
  });
});
