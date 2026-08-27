// test/hybrid/devtoberfest-signup-analytics-hana.test.js
// Validates DevtoberfestSignupAnalytics against real HANA — specifically that the
// portable weekIndex calc (floor(days_between(date'2018-01-01', cast(joinedAt as
// Date)) / 7)) and the after-READ enrichment (weekMonday/weekLabel + running
// cumulativeSignups) behave identically to the in-memory SQLite unit test.
// Test data is prefixed __TEST__ per test/hybrid/_guard.js and removed in afterAll.
//
// Run with:
//   ALLOW_HYBRID_WRITES=true npx vitest run test/hybrid/devtoberfest-signup-analytics-hana.test.js --project hybrid

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const ADMIN = { id: 'admin@test', roles: ['Admin'] };

describe('DevtoberfestSignupAnalytics — real HANA', () => {
  let testEventId;
  const testUserIds = [];
  const suffix = '__TEST__dtfsignups_' + Date.now();

  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Set ALLOW_HYBRID_WRITES=true to run this test');
    }
    isSafeForWrites();
    cds.test().in(process.cwd());
    await new Promise((r) => setTimeout(r, 500));

    const { Users, Events, EventRegistrations } = cds.entities('com.sap.developers.ims');
    testEventId = cds.utils.uuid();
    await INSERT.into(Events).entries({
      ID: testEventId, name: '__TEST__Devtoberfest Signups', eventType: 'DEVTOBERFEST',
      startDate: '2026-09-01T00:00:00Z', legacyId: 990001,
    });
    // 3 signups in ISO week of Mon 2026-09-07, 1 in Mon 2026-09-14
    const regs = [
      '2026-09-07T09:00:00Z', '2026-09-08T10:00:00Z', '2026-09-13T23:00:00Z',
      '2026-09-14T08:00:00Z',
    ];
    for (let i = 0; i < regs.length; i++) {
      const uid = cds.utils.uuid();
      testUserIds.push(uid);
      await INSERT.into(Users).entries({ ID: uid, sapId: `${suffix}_${i}`, email: `${suffix}_${i}@example.com`, legacyId: 990100 + i });
      await INSERT.into(EventRegistrations).entries({ ID: cds.utils.uuid(), user_ID: uid, event_ID: testEventId, joinedAt: regs[i] });
    }
  });

  afterAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') return;
    const { Users, Events, EventRegistrations } = cds.entities('com.sap.developers.ims');
    await DELETE.from(EventRegistrations).where({ event_ID: testEventId });
    await DELETE.from(Events).where({ ID: testEventId });
    if (testUserIds.length) await DELETE.from(Users).where({ ID: { in: testUserIds } });
  });

  it('buckets weeks + enriches labels & cumulative on HANA', async () => {
    const srv = await cds.connect.to('AdminService');
    const rows = await srv.tx({ user: ADMIN }, (tx) => tx.run(
      SELECT.from('DevtoberfestSignupAnalytics')
        .columns('weekIndex', { func: 'sum', args: [{ ref: ['signups'] }], as: 'newSignups' })
        .where({ event_ID: testEventId })
        .groupBy('weekIndex')
        .orderBy('weekIndex')
    ));
    expect(rows.length).toBe(2);
    expect(rows[1].weekIndex).toBe(rows[0].weekIndex + 1); // consecutive weeks
    expect(rows.map((r) => Number(r.newSignups))).toEqual([3, 1]);
    expect(rows.map((r) => r.cumulativeSignups)).toEqual([3, 4]);
    expect(rows[0].weekMonday).toBe('2026-09-07');
    expect(rows[0].weekLabel).toBe('2026-W37');
  });

  it('groups on the real weekMonday Date (ADD_DAYS) with readable dates on HANA (#2047)', async () => {
    const srv = await cds.connect.to('AdminService');
    const rows = await srv.tx({ user: ADMIN }, (tx) => tx.run(
      SELECT.from('DevtoberfestSignupAnalytics')
        .columns('weekMonday', { func: 'sum', args: [{ ref: ['signups'] }], as: 'newSignups' })
        .where({ event_ID: testEventId })
        .groupBy('weekMonday')
        .orderBy('weekMonday')
    ));
    expect(rows.length).toBe(2);
    expect(rows.map((r) => String(r.weekMonday).slice(0, 10))).toEqual(['2026-09-07', '2026-09-14']);
    expect(rows.map((r) => Number(r.newSignups))).toEqual([3, 1]);
    expect(rows.map((r) => r.weekLabel)).toEqual(['2026-W37', '2026-W38']);
    expect(rows.map((r) => r.cumulativeSignups)).toEqual([3, 4]);
  });

  it('renders a readable weekStartText label on HANA (TO_VARCHAR, #2047)', async () => {
    const srv = await cds.connect.to('AdminService');
    const rows = await srv.tx({ user: ADMIN }, (tx) => tx.run(
      SELECT.from('DevtoberfestSignupAnalytics')
        .columns('weekMonday', 'weekStartText', { func: 'sum', args: [{ ref: ['signups'] }], as: 'newSignups' })
        .where({ event_ID: testEventId })
        .groupBy('weekMonday', 'weekStartText')
        .orderBy('weekMonday')
    ));
    expect(rows.length).toBe(2);
    // HANA formats "DY DD MON YYYY" → contains the day-of-month, month name, and year
    // for the 2026-09-07 Monday. Case/locale of the names is HANA-controlled; assert
    // structurally rather than on an exact literal.
    expect(rows[0].weekStartText).toBeTruthy();
    expect(String(rows[0].weekStartText)).toMatch(/07/);
    expect(String(rows[0].weekStartText).toUpperCase()).toMatch(/SEP/);
    expect(String(rows[0].weekStartText)).toMatch(/2026/);
  });
});
