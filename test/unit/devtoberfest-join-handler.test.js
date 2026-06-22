// test/unit/devtoberfest-join-handler.test.js
// Tests for POST /api/devtoberfest/join. Built incrementally across
// Tasks 7, 8. This task covers the 201 happy path. Task 8 adds the
// 401/403/409/412/503 branches.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('POST /api/devtoberfest/join', () => {
  let Users, Events, DevtoberfestConfig, EventRegistrations;
  const SINGLETON_ID = '00000000-0000-0000-0000-00d0fe57feed';
  const eventId = cds.utils.uuid();

  beforeAll(() => {
    ({ Users, Events, DevtoberfestConfig, EventRegistrations } =
      cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(EventRegistrations);
    await DELETE.from(Users);
    await DELETE.from(DevtoberfestConfig);
    await DELETE.from(Events);
    await INSERT.into(Events).entries({
      ID: eventId, name: 'Devtoberfest 2026',
      startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-28T00:00:00Z',
      legacyId: 9001,
    });
    await INSERT.into(DevtoberfestConfig).entries({
      ID: SINGLETON_ID, currentEvent_ID: eventId, termsVersion: 3,
    });
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), sapId: 'admin', email: 'a@b', legacyId: 1,
    });
  });

  it('happy path: 201 + creates EventRegistration row', async () => {
    const res = await project.axios.post('/api/devtoberfest/join',
      { termsVersion: 3 },
      { auth: { username: 'admin', password: 'admin' } },
    );
    expect(res.status).toBe(201);
    expect(res.data.joined).toBe(true);
    expect(res.data.termsVersion).toBe(3);

    const rows = await SELECT.from(EventRegistrations);
    expect(rows.length).toBe(1);
    expect(rows[0].termsVersion).toBe(3);
    expect(rows[0].event_ID).toBe(eventId);
  });
});
