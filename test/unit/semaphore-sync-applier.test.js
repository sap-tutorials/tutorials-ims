// test/unit/semaphore-sync-applier.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyTerms } from '../../srv/lib/semaphore-sync/applier.js';

cds.test('serve', '--project', '.', '--in-memory');

// A mapper-shaped row. `classes` carries the raw SES classes used by the Tier-2
// intake gate. `isActualTag`/`isInterestItem` are present on the row but the
// applier deliberately IGNORES them for existing rows (editorial-owned) and
// forces them false on intake inserts.
const ROW = (over = {}) => ({
  semaphoreId: 's1',
  label: 'SAP S/4HANA',
  name: 'sap s 4hana',
  titlePath: 'Software Product : SAP S/4HANA',
  isActualTag: true,
  isInterestItem: false,
  classes: ['Topic'],
  ...over,
});

describe('semaphore applyTerms — two-tier (#2184)', () => {
  let db;
  let Tags;

  beforeEach(async () => {
    db = await cds.connect.to('db');
    ({ Tags } = cds.entities('com.sap.developers.ims'));
    await DELETE.from(Tags);
  });

  // ── Tier 2: intake ────────────────────────────────────────────────────────

  it('does NOT insert an unmatched term when intake is off (no allowlist)', async () => {
    const res = await applyTerms([ROW()], { db });
    expect(res).toEqual({ inserted: 0, updated: 0, unchanged: 0, skippedIntake: 1, total: 1 });
    expect(await SELECT.from(Tags)).toHaveLength(0);
  });

  it('inserts an unmatched term when its class is allowlisted, flags forced inert', async () => {
    const res = await applyTerms([ROW()], { db, intakeClasses: ['Topic'] });
    expect(res).toEqual({ inserted: 1, updated: 0, unchanged: 0, skippedIntake: 0, total: 1 });
    const t = await SELECT.one.from(Tags).where({ semaphoreId: 's1' });
    expect(t).toMatchObject({
      name: 'sap s 4hana', label: 'SAP S/4HANA',
      titlePath: 'Software Product : SAP S/4HANA',
      // New rows land inert regardless of the row's isActualTag:true.
      isActualTag: false, isInterestItem: false,
    });
    expect(t.ID).toBeTruthy();
  });

  it('skips an unmatched term whose class is not in the allowlist', async () => {
    const res = await applyTerms([ROW({ classes: ['SomethingElse'] })], { db, intakeClasses: ['Topic'] });
    expect(res).toEqual({ inserted: 0, updated: 0, unchanged: 0, skippedIntake: 1, total: 1 });
    expect(await SELECT.from(Tags)).toHaveLength(0);
  });

  it('matches allowlist against a full class URI by its leaf', async () => {
    const res = await applyTerms(
      [ROW({ classes: ['http://sap.com/schema#Topic'] })],
      { db, intakeClasses: ['Topic'] },
    );
    expect(res.inserted).toBe(1);
  });

  // ── Tier 1: adopt/update existing ──────────────────────────────────────────

  it('is idempotent: a second run reports everything unchanged', async () => {
    await applyTerms([ROW()], { db, intakeClasses: ['Topic'] });
    const res = await applyTerms([ROW()], { db, intakeClasses: ['Topic'] });
    expect(res).toEqual({ inserted: 0, updated: 0, unchanged: 1, skippedIntake: 0, total: 1 });
    expect(await SELECT.from(Tags)).toHaveLength(1);
  });

  it('updates taxonomy fields in place when a synced term is renamed', async () => {
    await applyTerms([ROW()], { db, intakeClasses: ['Topic'] });
    const res = await applyTerms(
      [ROW({ label: 'SAP S/4HANA Cloud', titlePath: 'Software Product : SAP S/4HANA Cloud' })],
      { db },
    );
    expect(res).toEqual({ inserted: 0, updated: 1, unchanged: 0, skippedIntake: 0, total: 1 });
    const rows = await SELECT.from(Tags).where({ semaphoreId: 's1' });
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0].label).toBe('SAP S/4HANA Cloud');
  });

  it('NEVER overwrites editorial flags on an existing row', async () => {
    // Existing curated row: hand-set isActualTag=true, isInterestItem=true.
    await INSERT.into(Tags).entries({
      ID: 'curated-1', semaphoreId: 's1', name: 'sap s 4hana',
      label: 'SAP S/4HANA', titlePath: 'Software Product : SAP S/4HANA',
      isActualTag: true, isInterestItem: true,
    });
    // Sync row carries the opposite flags — must be ignored.
    const res = await applyTerms(
      [ROW({ isActualTag: false, isInterestItem: false })],
      { db, intakeClasses: ['Topic'] },
    );
    expect(res).toEqual({ inserted: 0, updated: 0, unchanged: 1, skippedIntake: 0, total: 1 });
    const t = await SELECT.one.from(Tags).where({ ID: 'curated-1' });
    expect(t.isActualTag).toBe(true);
    expect(t.isInterestItem).toBe(true);
  });

  it('updates taxonomy fields yet preserves flags when both change', async () => {
    await INSERT.into(Tags).entries({
      ID: 'curated-2', semaphoreId: 's1', name: 'sap s 4hana',
      label: 'Old Label', titlePath: 'old', isActualTag: true, isInterestItem: true,
    });
    const res = await applyTerms([ROW({ isActualTag: false, isInterestItem: false })], { db });
    expect(res.updated).toBe(1);
    const t = await SELECT.one.from(Tags).where({ ID: 'curated-2' });
    expect(t.label).toBe('SAP S/4HANA');            // taxonomy field adopted
    expect(t.titlePath).toBe('Software Product : SAP S/4HANA');
    expect(t.isActualTag).toBe(true);                // flags untouched
    expect(t.isInterestItem).toBe(true);
  });

  it('adopts a legacy row matched by name that lacks a semaphoreId', async () => {
    await INSERT.into(Tags).entries({
      ID: 'legacy-1', name: 'sap s 4hana', titlePath: 'old', legacyId: 42,
      isActualTag: true, isInterestItem: false,
    });
    const res = await applyTerms([ROW()], { db });
    expect(res).toEqual({ inserted: 0, updated: 1, unchanged: 0, skippedIntake: 0, total: 1 });
    const t = await SELECT.one.from(Tags).where({ ID: 'legacy-1' });
    expect(t.semaphoreId).toBe('s1');
    expect(t.titlePath).toBe('Software Product : SAP S/4HANA');
    expect(t.isActualTag).toBe(true); // pre-existing flag preserved through adoption
    expect(await SELECT.from(Tags)).toHaveLength(1); // adopted, not duplicated
  });

  // ── dry run / empty ────────────────────────────────────────────────────────

  it('dryRun computes the intake plan without writing', async () => {
    const res = await applyTerms([ROW()], { db, dryRun: true, intakeClasses: ['Topic'] });
    expect(res).toEqual({ inserted: 1, updated: 0, unchanged: 0, skippedIntake: 0, total: 1 });
    expect(await SELECT.from(Tags)).toHaveLength(0);
  });

  it('handles an empty payload', async () => {
    expect(await applyTerms([], { db })).toEqual({
      inserted: 0, updated: 0, unchanged: 0, skippedIntake: 0, total: 0,
    });
  });
});
