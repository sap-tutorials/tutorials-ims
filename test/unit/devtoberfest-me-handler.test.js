// test/unit/devtoberfest-me-handler.test.js
// GET /api/devtoberfest/me — for the authenticated caller, returns
// their registration state for the current event. Used by the homepage
// island to refresh after a successful POST /join.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /api/devtoberfest/me', () => {
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
  });

  it('401 when anonymous', async () => {
    const res = await project.axios.get('/api/devtoberfest/me', {
      validateStatus: () => true,
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 EVENT_NOT_CONFIGURED when no current event is set', async () => {
    // beforeEach inserts a singleton with currentEvent_ID — wipe it
    // and reinsert without the FK so the handler hits the early-503.
    await DELETE.from(DevtoberfestConfig);
    await INSERT.into(DevtoberfestConfig).entries({
      ID: SINGLETON_ID,
      termsVersion: 3,
      // no currentEvent_ID
    });
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), sapId: 'admin', email: 'a@b', legacyId: 1,
    });
    const res = await project.axios.get('/api/devtoberfest/me', {
      auth: { username: 'admin', password: 'admin' },
      validateStatus: () => true,
    });
    expect(res.status).toBe(503);
    expect(res.data.error).toBe('EVENT_NOT_CONFIGURED');
  });

  it('returns joined:false when authenticated but not registered', async () => {
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), sapId: 'admin', email: 'a@b', legacyId: 1,
    });
    const res = await project.axios.get('/api/devtoberfest/me', {
      auth: { username: 'admin', password: 'admin' },
    });
    expect(res.status).toBe(200);
    expect(res.data.joined).toBe(false);
  });

  it('returns joined:true + joinedAt + termsVersion when registered', async () => {
    const userId = cds.utils.uuid();
    await INSERT.into(Users).entries({
      ID: userId, sapId: 'admin', email: 'a@b', legacyId: 2,
    });
    await INSERT.into(EventRegistrations).entries({
      ID: cds.utils.uuid(),
      user_ID: userId, event_ID: eventId,
      joinedAt: '2026-06-15T12:00:00Z',
      termsVersion: 3,
      termsAcceptedAt: '2026-06-15T12:00:00Z',
      legacyId: 1,
    });
    const res = await project.axios.get('/api/devtoberfest/me', {
      auth: { username: 'admin', password: 'admin' },
    });
    expect(res.status).toBe(200);
    expect(res.data.joined).toBe(true);
    expect(res.data.termsVersion).toBe(3);
    expect(res.data.joinedAt).toContain('2026-06-15');
  });

  it('returns joined:false when registered for a DIFFERENT event', async () => {
    // Discriminator: ensures handler filters by event_ID, not just user_ID.
    // Without the event_ID predicate, a user with any registration would
    // appear joined for every event.
    const userId = cds.utils.uuid();
    const otherEventId = cds.utils.uuid();
    await INSERT.into(Events).entries({
      ID: otherEventId, name: 'Devtoberfest 2025',
      startDate: '2025-10-01T00:00:00Z', endDate: '2025-10-28T00:00:00Z',
      legacyId: 9000,
    });
    await INSERT.into(Users).entries({
      ID: userId, sapId: 'admin', email: 'a@b', legacyId: 2,
    });
    await INSERT.into(EventRegistrations).entries({
      ID: cds.utils.uuid(),
      user_ID: userId, event_ID: otherEventId,   // NOT the current event
      joinedAt: '2025-10-01T00:00:00Z',
      termsVersion: 2,
      termsAcceptedAt: '2025-10-01T00:00:00Z',
      legacyId: 2,
    });
    const res = await project.axios.get('/api/devtoberfest/me', {
      auth: { username: 'admin', password: 'admin' },
    });
    expect(res.status).toBe(200);
    expect(res.data.joined).toBe(false);
  });
});
