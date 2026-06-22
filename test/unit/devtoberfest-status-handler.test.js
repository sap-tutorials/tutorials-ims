// test/unit/devtoberfest-status-handler.test.js
// Tests for GET /api/devtoberfest/status. Built incrementally across
// Tasks 3, 4. Each slice adds one branch of the state machine in
// spec §6.1.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /api/devtoberfest/status', () => {
  let DevtoberfestConfig, Events;

  beforeAll(() => {
    ({ DevtoberfestConfig, Events } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(DevtoberfestConfig);
    await DELETE.from(Events);
  });

  it('returns 503 EVENT_NOT_CONFIGURED when currentEvent is NULL', async () => {
    const res = await project.axios.get('/api/devtoberfest/status', {
      validateStatus: () => true,
    });
    expect(res.status).toBe(503);
    expect(res.data.error).toBe('EVENT_NOT_CONFIGURED');
  });

  it('returns 503 idempotently across repeated calls (singleton race tolerance)', async () => {
    // Two sequential GETs must BOTH return 503 with the same body.
    // Verifies ensureDevtoberfestConfigSingleton's check-then-INSERT
    // doesn't break on the second call (where the row already exists).
    const r1 = await project.axios.get('/api/devtoberfest/status', {
      validateStatus: () => true,
    });
    const r2 = await project.axios.get('/api/devtoberfest/status', {
      validateStatus: () => true,
    });
    expect(r1.status).toBe(503);
    expect(r2.status).toBe(503);
    expect(r1.data.error).toBe('EVENT_NOT_CONFIGURED');
    expect(r2.data.error).toBe('EVENT_NOT_CONFIGURED');
  });

  describe('with event configured', () => {
    let Users;
    const SINGLETON_ID = '00000000-0000-0000-0000-00d0fe57feed';
    const eventId = cds.utils.uuid();

    beforeAll(() => {
      ({ Users } = cds.entities('com.sap.developers.ims'));
    });

    beforeEach(async () => {
      const { EventRegistrations } = cds.entities('com.sap.developers.ims');
      await DELETE.from(EventRegistrations);
      await DELETE.from(Users);
      await DELETE.from(Events);
      await DELETE.from(DevtoberfestConfig);
      await INSERT.into(Events).entries({
        ID: eventId, name: 'Devtoberfest 2026',
        startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-28T00:00:00Z',
        legacyId: 9001,
      });
      await INSERT.into(DevtoberfestConfig).entries({
        ID: SINGLETON_ID,
        currentEvent_ID: eventId,
        termsVersion: 3,
        contentRulesUrl: 'https://example.test/rules',
        faqUrl: '', gameboardUrl: '', activitiesUrl: '',
      });
    });

    it('anonymous → 200 { joined: false, termsRequired: true }', async () => {
      const res = await project.axios.get('/api/devtoberfest/status');
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({
        event: { name: 'Devtoberfest 2026' },
        joined: false,
        termsVersion: 3,
        termsRequired: true,
        contentRulesUrl: 'https://example.test/rules',
      });
    });

    it('authenticated unregistered → joined: false', async () => {
      const res = await project.axios.get('/api/devtoberfest/status', {
        auth: { username: 'C0000001', password: 'password' },
        validateStatus: () => true,
      });
      expect(res.status).toBe(200);
      expect(res.data.joined).toBe(false);
    });

    it('authenticated registered → joined: true, termsRequired: false', async () => {
      const userId = cds.utils.uuid();
      const { EventRegistrations } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Users).entries({ ID: userId, sapId: 'admin', email: 'a@b', legacyId: 2 });
      await INSERT.into(EventRegistrations).entries({
        ID: cds.utils.uuid(),
        user_ID: userId, event_ID: eventId,
        joinedAt: '2026-06-15T00:00:00Z',
        termsVersion: 3,
        termsAcceptedAt: '2026-06-15T00:00:00Z',
        legacyId: 1,
      });
      const res = await project.axios.get('/api/devtoberfest/status', {
        auth: { username: 'admin', password: 'admin' },
      });
      expect(res.status).toBe(200);
      expect(res.data.joined).toBe(true);
      expect(res.data.termsRequired).toBe(false);
    });

    it('authenticated registered for a DIFFERENT event → joined: false', async () => {
      // Discriminator: ensures handler filters by event_ID, not just user_ID.
      // Without the event_ID predicate, a user with any registration would
      // appear joined for every event.
      const userId = cds.utils.uuid();
      const otherEventId = cds.utils.uuid();
      const { EventRegistrations } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Events).entries({
        ID: otherEventId, name: 'Devtoberfest 2025',
        startDate: '2025-10-01T00:00:00Z', endDate: '2025-10-28T00:00:00Z',
        legacyId: 9000,
      });
      await INSERT.into(Users).entries({ ID: userId, sapId: 'admin', email: 'a@b', legacyId: 3 });
      await INSERT.into(EventRegistrations).entries({
        ID: cds.utils.uuid(),
        user_ID: userId, event_ID: otherEventId,   // <-- NOT the current event
        joinedAt: '2025-10-01T00:00:00Z',
        termsVersion: 2,
        termsAcceptedAt: '2025-10-01T00:00:00Z',
        legacyId: 2,
      });
      const res = await project.axios.get('/api/devtoberfest/status', {
        auth: { username: 'admin', password: 'admin' },
      });
      expect(res.status).toBe(200);
      expect(res.data.joined).toBe(false);
    });
  });
});
