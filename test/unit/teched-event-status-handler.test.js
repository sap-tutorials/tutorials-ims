// test/unit/teched-event-status-handler.test.js
// Tests for GET /api/teched/event-status (issue #2751). The handler reads a
// single production Events row (ID from TECHED_EVENT_ID) and returns its public
// window { name, startDate, endDate }. These slices boot the real CAP app via
// cds.test so the Express route registration in server.js is exercised, not just
// the handler in isolation. A fixed test UUID is injected via TECHED_EVENT_ID so
// the suite does not depend on the real production row existing in SQLite.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const TEST_EVENT_ID = '11111111-2222-3333-4444-555555555555';
process.env.TECHED_EVENT_ID = TEST_EVENT_ID;

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /api/teched/event-status', () => {
  let Events;

  beforeAll(() => {
    ({ Events } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(Events);
  });

  it('returns 503 EVENT_NOT_CONFIGURED when the configured Events row is absent', async () => {
    const res = await project.axios.get('/api/teched/event-status', {
      validateStatus: () => true,
    });
    expect(res.status).toBe(503);
    expect(res.data.error).toBe('EVENT_NOT_CONFIGURED');
  });

  it('returns 200 with the public event window when the row exists', async () => {
    await INSERT.into(Events).entries({
      ID: TEST_EVENT_ID,
      name: 'SAP TechEd 2026',
      startDate: '2026-11-24T00:00:00Z',
      endDate: '2026-11-26T23:59:59Z',
      legacyId: 8001,
    });
    const res = await project.axios.get('/api/teched/event-status');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      event: { name: 'SAP TechEd 2026' },
    });
    expect(res.data.event.startDate).toContain('2026-11-24');
    expect(res.data.event.endDate).toContain('2026-11-26');
  });

  it('does not leak extra Events columns (explicit public projection)', async () => {
    await INSERT.into(Events).entries({
      ID: TEST_EVENT_ID,
      name: 'SAP TechEd 2026',
      startDate: '2026-11-24T00:00:00Z',
      endDate: '2026-11-26T23:59:59Z',
      location: 'Virtual',
      eventUrl: 'https://developers.sap.com/teched',
      legacyId: 8002,
    });
    const res = await project.axios.get('/api/teched/event-status');
    expect(res.status).toBe(200);
    expect(Object.keys(res.data.event).sort()).toEqual(['endDate', 'name', 'startDate']);
  });

  it('ignores other Events rows — only the configured ID is served', async () => {
    await INSERT.into(Events).entries([
      {
        ID: TEST_EVENT_ID,
        name: 'SAP TechEd 2026',
        startDate: '2026-11-24T00:00:00Z',
        endDate: '2026-11-26T23:59:59Z',
        legacyId: 8003,
      },
      {
        ID: '99999999-8888-7777-6666-555555555555',
        name: 'Some Other Event',
        startDate: '2026-01-01T00:00:00Z',
        endDate: '2026-01-02T00:00:00Z',
        legacyId: 8004,
      },
    ]);
    const res = await project.axios.get('/api/teched/event-status');
    expect(res.status).toBe(200);
    expect(res.data.event.name).toBe('SAP TechEd 2026');
  });
});
