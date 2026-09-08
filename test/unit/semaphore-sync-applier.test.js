// test/unit/semaphore-sync-applier.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyTerms } from '../../srv/lib/semaphore-sync/applier.js';

cds.test('serve', '--project', '.', '--in-memory');

const ROW = (over = {}) => ({
  semaphoreId: 's1',
  label: 'SAP S/4HANA',
  name: 'sap s 4hana',
  titlePath: 'Software Product : SAP S/4HANA',
  isActualTag: true,
  isInterestItem: false,
  ...over,
});

describe('semaphore applyTerms', () => {
  let db;
  let Tags;

  beforeEach(async () => {
    db = await cds.connect.to('db');
    ({ Tags } = cds.entities('com.sap.developers.ims'));
    await DELETE.from(Tags);
  });

  it('inserts a new term with all Semaphore fields', async () => {
    const res = await applyTerms([ROW()], { db });
    expect(res).toEqual({ inserted: 1, updated: 0, unchanged: 0, total: 1 });
    const t = await SELECT.one.from(Tags).where({ semaphoreId: 's1' });
    expect(t).toMatchObject({
      name: 'sap s 4hana', label: 'SAP S/4HANA',
      titlePath: 'Software Product : SAP S/4HANA',
      isActualTag: true, isInterestItem: false,
    });
    expect(t.ID).toBeTruthy();
  });

  it('is idempotent: a second run reports everything unchanged', async () => {
    await applyTerms([ROW()], { db });
    const res = await applyTerms([ROW()], { db });
    expect(res).toEqual({ inserted: 0, updated: 0, unchanged: 1, total: 1 });
    expect(await SELECT.from(Tags)).toHaveLength(1);
  });

  it('updates in place when a synced term is renamed (same semaphoreId)', async () => {
    await applyTerms([ROW()], { db });
    const res = await applyTerms([ROW({ label: 'SAP S/4HANA Cloud', titlePath: 'Software Product : SAP S/4HANA Cloud' })], { db });
    expect(res).toEqual({ inserted: 0, updated: 1, unchanged: 0, total: 1 });
    const rows = await SELECT.from(Tags).where({ semaphoreId: 's1' });
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0].label).toBe('SAP S/4HANA Cloud');
  });

  it('adopts a legacy row matched by name that lacks a semaphoreId', async () => {
    await INSERT.into(Tags).entries({ ID: 'legacy-1', name: 'sap s 4hana', titlePath: 'old', legacyId: 42 });
    const res = await applyTerms([ROW()], { db });
    expect(res).toEqual({ inserted: 0, updated: 1, unchanged: 0, total: 1 });
    const t = await SELECT.one.from(Tags).where({ ID: 'legacy-1' });
    expect(t.semaphoreId).toBe('s1');
    expect(t.titlePath).toBe('Software Product : SAP S/4HANA');
    expect(await SELECT.from(Tags)).toHaveLength(1); // adopted, not duplicated
  });

  it('dryRun computes the plan without writing', async () => {
    const res = await applyTerms([ROW()], { db, dryRun: true });
    expect(res).toEqual({ inserted: 1, updated: 0, unchanged: 0, total: 1 });
    expect(await SELECT.from(Tags)).toHaveLength(0);
  });

  it('handles an empty payload', async () => {
    expect(await applyTerms([], { db })).toEqual({ inserted: 0, updated: 0, unchanged: 0, total: 0 });
  });
});
