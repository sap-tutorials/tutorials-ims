// test/unit/devtoberfest-signup-analytics.test.js
//
// DevtoberfestSignupAnalytics view + AdminService aggregation + after-READ
// enrichment (spec 2026-08-13). Runs in-memory (SQLite) to prove the portable
// weekIndex bucketing, the DEVTOBERFEST-only filter, the region/role left join +
// 'Not set' coalesce, and that an aggregated service read is enriched with
// weekMonday / weekLabel and a running cumulativeSignups on the by-week series.
//
// The real-HANA behaviour of days_between/floor/cast is guarded separately in
// test/hybrid/devtoberfest-signup-analytics-hana.test.js.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const ADMIN = { id: 'admin@test', roles: ['Admin'] };

describe('DevtoberfestSignupAnalytics', () => {
  let Events, Users, UserLearningPreferences, EventRegistrations, DevtoberfestSignupAnalytics;
  let devEvent, techEdEvent, users;

  beforeAll(() => {
    ({ Events, Users, UserLearningPreferences, EventRegistrations, DevtoberfestSignupAnalytics } =
      cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(EventRegistrations);
    await DELETE.from(UserLearningPreferences);
    await DELETE.from(Events);
    await DELETE.from(Users);

    devEvent = cds.utils.uuid();
    techEdEvent = cds.utils.uuid();
    await INSERT.into(Events).entries([
      { ID: devEvent, name: 'Devtoberfest 2026', eventType: 'DEVTOBERFEST', startDate: '2026-09-01T00:00:00Z' },
      { ID: techEdEvent, name: 'TechEd 2026', eventType: 'TECHED', startDate: '2026-10-01T00:00:00Z' },
    ]);
    users = Array.from({ length: 6 }, () => cds.utils.uuid());
    await INSERT.into(Users).entries(users.map((id, i) => ({ ID: id, uuid: cds.utils.uuid(), displayName: `U${i}`, legacyId: i + 1 })));
    await INSERT.into(UserLearningPreferences).entries([
      { user_ID: users[0], role: 'developer', preferredEventRegion: 'EMEA' },
      { user_ID: users[1], role: 'architect', preferredEventRegion: 'AMERICAS' },
      { user_ID: users[2], role: 'developer', preferredEventRegion: 'EMEA' },
    ]);
    // 3 signups in ISO week of Mon 2026-09-07, 1 in Mon 2026-09-14, 2 in Mon 2026-09-21
    const regs = [
      [0, '2026-09-07T09:00:00Z'], [1, '2026-09-08T10:00:00Z'], [2, '2026-09-13T23:00:00Z'],
      [3, '2026-09-14T08:00:00Z'], [4, '2026-09-21T08:00:00Z'], [5, '2026-09-22T08:00:00Z'],
    ];
    await INSERT.into(EventRegistrations).entries(regs.map(([u, at]) => ({
      ID: cds.utils.uuid(), user_ID: users[u], event_ID: devEvent, joinedAt: at,
    })));
    // A non-Devtoberfest signup that MUST be excluded by the view filter
    await INSERT.into(EventRegistrations).entries({
      ID: cds.utils.uuid(), user_ID: users[0], event_ID: techEdEvent, joinedAt: '2026-10-05T08:00:00Z',
    });
  });

  it('exposes one row per Devtoberfest signup and excludes other event types', async () => {
    const rows = await SELECT.from(DevtoberfestSignupAnalytics);
    expect(rows.length).toBe(6);
    expect(rows.every((r) => r.eventName === 'Devtoberfest 2026')).toBe(true);
  });

  it('buckets same-week signups to one portable weekIndex, consecutive weeks increment by 1', async () => {
    const rows = await SELECT.from(DevtoberfestSignupAnalytics).columns('weekIndex').orderBy('weekIndex');
    const weeks = [...new Set(rows.map((r) => r.weekIndex))];
    expect(weeks.length).toBe(3);
    expect(weeks[1]).toBe(weeks[0] + 1);
    expect(weeks[2]).toBe(weeks[1] + 1);
  });

  it('coalesces missing learning-preferences to the "Not set" bucket', async () => {
    const rows = await SELECT.from(DevtoberfestSignupAnalytics);
    const withPrefs = rows.filter((r) => r.region !== 'Not set');
    const withoutPrefs = rows.filter((r) => r.region === 'Not set');
    expect(withPrefs.length).toBe(3); // users 0,1,2
    expect(withoutPrefs.length).toBe(3); // users 3,4,5
    expect(withoutPrefs.every((r) => r.role === 'Not set')).toBe(true);
  });

  it('aggregated by-week read is enriched with labels + running cumulative', async () => {
    const srv = await cds.connect.to('AdminService');
    const rows = await srv.tx({ user: ADMIN }, (tx) => tx.run(
      SELECT.from('DevtoberfestSignupAnalytics')
        .columns('weekIndex', { func: 'sum', args: [{ ref: ['signups'] }], as: 'newSignups' })
        .groupBy('weekIndex')
        .orderBy('weekIndex')
    ));
    expect(rows.map((r) => r.newSignups)).toEqual([3, 1, 2]);
    expect(rows.map((r) => r.cumulativeSignups)).toEqual([3, 4, 6]);
    expect(rows[0].weekMonday).toBe('2026-09-07');
    expect(rows[0].weekLabel).toBe('2026-W37');
  });

  it('exposes a real, groupable weekMonday Date on every fact row (issue #2047)', async () => {
    const rows = await SELECT.from(DevtoberfestSignupAnalytics).columns('weekMonday', 'joinedDate').orderBy('joinedDate');
    // Every signup maps to its Mon–Sun week's Monday date.
    expect(rows[0].weekMonday).toBe('2026-09-07'); // 2026-09-07 signup
    expect(rows[2].weekMonday).toBe('2026-09-07'); // 2026-09-13 (Sun) still in that week
    expect(rows[3].weekMonday).toBe('2026-09-14');
    expect(rows[4].weekMonday).toBe('2026-09-21');
  });

  it('exposes a groupable weekStartText display label on every fact row (issue #2047)', async () => {
    const rows = await SELECT.from(DevtoberfestSignupAnalytics)
      .columns('weekMonday', 'weekStartText', 'joinedDate').orderBy('joinedDate');
    // SQLite has no month/weekday-name formatter, so the local/test label is the
    // ISO Monday date; production (HANA) renders "Mon 07 Sep 2026" (guarded in the
    // hybrid suite). Either way it is 1:1 with weekMonday and non-null.
    expect(rows.every((r) => typeof r.weekStartText === 'string' && r.weekStartText.length > 0)).toBe(true);
    expect(rows[0].weekStartText).toBe('2026-09-07');
    expect(rows[3].weekStartText).toBe('2026-09-14');
  });

  it('chart path: grouping by weekMonday carries the weekStartText text-arrangement label', async () => {
    const srv = await cds.connect.to('AdminService');
    const rows = await srv.tx({ user: ADMIN }, (tx) => tx.run(
      SELECT.from('DevtoberfestSignupAnalytics')
        .columns('weekMonday', 'weekStartText', { func: 'sum', args: [{ ref: ['signups'] }], as: 'newSignups' })
        .groupBy('weekMonday', 'weekStartText')
        .orderBy('weekMonday')
    ));
    expect(rows.map((r) => r.weekStartText)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
    expect(rows.map((r) => r.newSignups)).toEqual([3, 1, 2]);
  });

  it('chart path: aggregated read grouped by the real weekMonday returns readable dates + enrichment', async () => {
    const srv = await cds.connect.to('AdminService');
    const rows = await srv.tx({ user: ADMIN }, (tx) => tx.run(
      SELECT.from('DevtoberfestSignupAnalytics')
        .columns('weekMonday', { func: 'sum', args: [{ ref: ['signups'] }], as: 'newSignups' })
        .groupBy('weekMonday')
        .orderBy('weekMonday')
    ));
    expect(rows.map((r) => r.weekMonday)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
    expect(rows.map((r) => r.newSignups)).toEqual([3, 1, 2]);
    // enrichment keys off weekMonday even though weekIndex was not grouped
    expect(rows.map((r) => r.weekLabel)).toEqual(['2026-W37', '2026-W38', '2026-W39']);
    expect(rows.map((r) => r.cumulativeSignups)).toEqual([3, 4, 6]);
  });

  it('grand total aggregates all Devtoberfest signups', async () => {
    const srv = await cds.connect.to('AdminService');
    const rows = await srv.tx({ user: ADMIN }, (tx) => tx.run(
      SELECT.from('DevtoberfestSignupAnalytics')
        .columns({ func: 'sum', args: [{ ref: ['signups'] }], as: 'newSignups' })
    ));
    expect(rows[0].newSignups).toBe(6);
  });

  it('omits cumulative when sliced by a second dimension (weeks repeat)', async () => {
    const srv = await cds.connect.to('AdminService');
    const rows = await srv.tx({ user: ADMIN }, (tx) => tx.run(
      SELECT.from('DevtoberfestSignupAnalytics')
        .columns('weekIndex', 'region', { func: 'sum', args: [{ ref: ['signups'] }], as: 'newSignups' })
        .groupBy('weekIndex', 'region')
    ));
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => r.cumulativeSignups === undefined || r.cumulativeSignups === null)).toBe(true);
    // labels still applied
    expect(rows.every((r) => typeof r.weekLabel === 'string')).toBe(true);
  });
});
