// test/unit/devtoberfest-cat-game-award.test.js
// Tests for POST /api/devtoberfest/cat-game/award (issue #2042):
// 5 points/day, once per day, capped at 100 per event, active-event-only.
// Mirrors devtoberfest-join-handler.test.js bootstrap (in-memory serve + basic-auth).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { eventIsLive, awardCatGamePoints, utcDay, MAX_POINTS, DAILY_POINTS }
  from '../../srv/lib/cat-game-award.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

const auth = { username: 'admin', password: 'admin' };
const AWARD_URL = '/api/devtoberfest/cat-game/award';

describe('POST /api/devtoberfest/cat-game/award', () => {
  let Users, Events, DevtoberfestConfig, CatGameAwards;
  const configId = cds.utils.uuid();
  const eventId = cds.utils.uuid();
  let userRowId;

  const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

  beforeAll(() => {
    ({ Users, Events, DevtoberfestConfig, CatGameAwards } =
      cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(CatGameAwards);
    await DELETE.from(Users);
    await DELETE.from(DevtoberfestConfig);
    await DELETE.from(Events);
    // A currently-LIVE event: started yesterday, ends tomorrow.
    await INSERT.into(Events).entries({
      ID: eventId, name: 'Devtoberfest 2026',
      startDate: iso(-86_400_000), endDate: iso(86_400_000), legacyId: 9001,
    });
    await INSERT.into(DevtoberfestConfig).entries({
      ID: configId, isActive: true, currentEvent_ID: eventId,
    });
    userRowId = cds.utils.uuid();
    await INSERT.into(Users).entries({
      ID: userRowId, sapId: 'admin', email: 'a@b', legacyId: 1,
    });
  });

  it('happy path: awards 5 points and writes one ledger row for today', async () => {
    const res = await project.axios.post(AWARD_URL, {}, { auth });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ awarded: true, points: 5, total: 5, cap: 100, reason: 'awarded' });

    const rows = await SELECT.from(CatGameAwards).where({ user_ID: userRowId, event_ID: eventId });
    expect(rows.length).toBe(1);
    expect(rows[0].points).toBe(5);
    expect(String(rows[0].awardDate).slice(0, 10)).toBe(utcDay());
  });

  it('already-today: second call same day does not double-award', async () => {
    const first = await project.axios.post(AWARD_URL, {}, { auth });
    expect(first.data.awarded).toBe(true);
    const second = await project.axios.post(AWARD_URL, {}, { auth });
    expect(second.status).toBe(200);
    expect(second.data).toMatchObject({ awarded: false, reason: 'already-today', total: 5, cap: 100 });
    const rows = await SELECT.from(CatGameAwards).where({ user_ID: userRowId });
    expect(rows.length).toBe(1);
  });

  it('max: declines once the user has 100 points for the event', async () => {
    // 20 prior daily awards (distinct dates) → 100 points already.
    for (let i = 1; i <= 20; i++) {
      await INSERT.into(CatGameAwards).entries({
        user_ID: userRowId, event_ID: eventId,
        awardDate: `2026-09-${String(i).padStart(2, '0')}`, points: 5,
      });
    }
    const res = await project.axios.post(AWARD_URL, {}, { auth });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ awarded: false, reason: 'max', total: 100, cap: 100 });
    const rows = await SELECT.from(CatGameAwards).where({ user_ID: userRowId });
    expect(rows.length).toBe(20); // no new row
  });

  it('inactive: 200 {awarded:false, reason:inactive} when the event has ended', async () => {
    await UPDATE(Events).where({ ID: eventId }).set({ endDate: iso(-3_600_000) }); // ended an hour ago
    const res = await project.axios.post(AWARD_URL, {}, { auth, validateStatus: () => true });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ awarded: false, reason: 'inactive' });
    expect((await SELECT.from(CatGameAwards)).length).toBe(0);
  });

  it('inactive: when no DevtoberfestConfig row is active', async () => {
    await UPDATE(DevtoberfestConfig).where({ ID: configId }).set({ isActive: false });
    const res = await project.axios.post(AWARD_URL, {}, { auth, validateStatus: () => true });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ awarded: false, reason: 'inactive' });
  });

  it('401 when anonymous', async () => {
    const res = await project.axios.post(AWARD_URL, {}, { validateStatus: () => true });
    expect(res.status).toBe(401);
    expect(res.data.error).toBe('UNAUTHENTICATED');
  });
});

describe('cat-game-award pure helpers', () => {
  it('utcDay returns YYYY-MM-DD', () => {
    expect(utcDay(new Date('2026-10-05T23:59:00Z'))).toBe('2026-10-05');
  });

  it('constants match the spec', () => {
    expect(DAILY_POINTS).toBe(5);
    expect(MAX_POINTS).toBe(100);
  });

  it('eventIsLive respects [startDate, endDate] with open bounds', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    expect(eventIsLive({ startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-28T00:00:00Z' }, now)).toBe(true);
    expect(eventIsLive({ startDate: '2026-10-20T00:00:00Z', endDate: '2026-10-28T00:00:00Z' }, now)).toBe(false); // not started
    expect(eventIsLive({ startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-05T00:00:00Z' }, now)).toBe(false); // ended
    expect(eventIsLive({ endDate: '2026-10-28T00:00:00Z' }, now)).toBe(true); // open start
    expect(eventIsLive(null, now)).toBe(false);
  });
});
