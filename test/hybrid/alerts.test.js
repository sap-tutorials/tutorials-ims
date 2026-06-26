import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

// Hybrid HANA tests for the Alerts entity (#548).
// Verifies the runtime filter mirrors what /api/alerts (public) and
// /api/alerts/me (authenticated) apply: active=true + audience scoping.
// Also confirms reserved-word safe column names (`active`, `severity`,
// `audience`) round-trip through CDS QL on HANA.
//
// cds.test('serve') boots the project's CDS model so `cds.entities(ns)`
// resolves — mirrors the pattern used by test/hybrid/feedback.test.js.

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = '__TEST__alerts-';

describe.runIf(isSafeForWrites())('Alerts on HANA', () => {
  let db;
  let Alerts;
  const createdIds = [];

  beforeAll(async () => {
    db = await cds.connect.to('db');
    Alerts = cds.entities('com.sap.developers.ims').Alerts;
  });

  afterAll(async () => {
    if (createdIds.length) {
      await db.run(DELETE.from(Alerts).where({ ID: { in: createdIds } }));
    }
  });

  async function insert(extra = {}) {
    const id = cds.utils.uuid();
    createdIds.push(id);
    const now = new Date();
    await db.run(INSERT.into(Alerts).entries({
      ID: id,
      title: TEST_PREFIX + (extra.title || 'row'),
      severity: extra.severity || 'Information',
      audience: extra.audience || 'ALL',
      startsAt: new Date(now.getTime() - 60_000).toISOString(),
      endsAt:   new Date(now.getTime() + 60_000).toISOString(),
      active:   extra.active !== false,
      dismissible: true,
    }));
    return id;
  }

  it('public endpoint returns ALL rows', async () => {
    const id = await insert();
    const rows = await db.run(SELECT.from(Alerts).where({
      ID: id, active: true, audience: 'ALL',
    }));
    expect(rows).toHaveLength(1);
  });

  it('flipping audience=AUTHENTICATED drops from public set', async () => {
    const id = await insert({ audience: 'AUTHENTICATED' });
    const rows = await db.run(SELECT.from(Alerts).where({
      ID: id, audience: 'ALL',
    }));
    expect(rows).toHaveLength(0);
  });

  it('active=false drops the row', async () => {
    const id = await insert({ active: false });
    const rows = await db.run(SELECT.from(Alerts).where({
      ID: id, active: true,
    }));
    expect(rows).toHaveLength(0);
  });

  it('reserved-word safety check — column names round-trip', async () => {
    const id = await insert({ severity: 'Warning' });
    const [row] = await db.run(SELECT.from(Alerts).where({ ID: id }));
    expect(row.severity).toBe('Warning');
    expect(row.audience).toBe('ALL');
    expect(row.active).toBe(true);
  });
});
