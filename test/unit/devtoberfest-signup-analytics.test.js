// test/unit/devtoberfest-signup-analytics.test.js
//
// DevtoberfestSignupAnalytics view + AdminService aggregation (spec 2026-08-13;
// week axis reworked to a categorical string for issue #2209). Runs in-memory
// (SQLite) to prove the portable weekIndex bucketing, the DEVTOBERFEST-only
// filter, the region/role left join + 'Not set' coalesce, and that the week axis
// is a real, GROUPABLE ISO-date string (weekStartText) the analytical chart/table
// group + sort on — one discrete category per week, no Edm.Date time axis.
//
// The real-HANA behaviour of days_between/floor/cast + TO_VARCHAR is guarded
// separately in test/hybrid/devtoberfest-signup-analytics-hana.test.js.

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

  it('exposes a real, groupable ISO-date weekStartText on every fact row (issue #2209)', async () => {
    const rows = await SELECT.from(DevtoberfestSignupAnalytics)
      .columns('weekStartText', 'joinedDate').orderBy('joinedDate');
    // Every signup maps to its Mon–Sun week's Monday, rendered as an ISO date
    // string (the discrete category the chart/table group + sort on). The same
    // 'YYYY-MM-DD' shape is produced on HANA (guarded in the hybrid suite).
    expect(rows[0].weekStartText).toBe('2026-09-07'); // 2026-09-07 signup
    expect(rows[2].weekStartText).toBe('2026-09-07'); // 2026-09-13 (Sun) still in that week
    expect(rows[3].weekStartText).toBe('2026-09-14');
    expect(rows[4].weekStartText).toBe('2026-09-21');
    expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.weekStartText))).toBe(true);
  });

  it('chart path: aggregated read grouped by weekStartText returns one row per week, chronologically', async () => {
    const srv = await cds.connect.to('AdminService');
    const rows = await srv.tx({ user: ADMIN }, (tx) => tx.run(
      SELECT.from('DevtoberfestSignupAnalytics')
        .columns('weekStartText', { func: 'sum', args: [{ ref: ['signups'] }], as: 'newSignups' })
        .groupBy('weekStartText')
        .orderBy('weekStartText')
    ));
    // Lexical order on the ISO string == chronological order — no separate sort key.
    expect(rows.map((r) => r.weekStartText)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
    expect(rows.map((r) => r.newSignups)).toEqual([3, 1, 2]);
  });

  it('grand total aggregates all Devtoberfest signups (analytical-table total row)', async () => {
    const srv = await cds.connect.to('AdminService');
    const rows = await srv.tx({ user: ADMIN }, (tx) => tx.run(
      SELECT.from('DevtoberfestSignupAnalytics')
        .columns({ func: 'sum', args: [{ ref: ['signups'] }], as: 'newSignups' })
    ));
    expect(rows[0].newSignups).toBe(6);
  });

  it('slices by a filter dimension (region) without breaking the aggregation', async () => {
    const srv = await cds.connect.to('AdminService');
    const rows = await srv.tx({ user: ADMIN }, (tx) => tx.run(
      SELECT.from('DevtoberfestSignupAnalytics')
        .columns('weekStartText', 'region', { func: 'sum', args: [{ ref: ['signups'] }], as: 'newSignups' })
        .groupBy('weekStartText', 'region')
    ));
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.reduce((sum, r) => sum + r.newSignups, 0)).toBe(6);
    expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.weekStartText))).toBe(true);
  });
});
