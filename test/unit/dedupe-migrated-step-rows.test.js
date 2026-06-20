import { describe, it, expect } from 'vitest';
import { pairMigratedSteps, planTaskRecordOps, titlesAreSame } from '../../scripts/lib/pair-migrated-steps.cjs';

// Pure unit tests of the dedupe pairing logic. No DB access. Mirrors the
// shape of HANA result rows (uppercase keys).

const mig = (over, props = {}) => ({
  ID: `mig-id-${over}`,
  LEGACYID: 100 + over,
  STEPORDER: over,
  STATUS: null,
  TITLE: `Step ${over + 1}: Do thing`,
  ...props,
});

const nat = (over, props = {}) => ({
  ID: `nat-id-${over}`,
  LEGACYID: 200 + over,
  STEPORDER: over,
  STATUS: 'ACTIVE',
  TITLE: `Do thing`,
  ...props,
});

describe('titlesAreSame', () => {
  it('exact (case-insensitive trimmed) equality matches', () => {
    expect(titlesAreSame('Install ABAP', '  install abap  ')).toBe(true);
  });

  it('"Step N: <title>" prefix matches', () => {
    expect(titlesAreSame('Step 1: Install ABAP Development Tools', 'Install ABAP Development Tools')).toBe(true);
  });

  it('"Step N - <title>" / "Step N. <title>" prefix matches', () => {
    expect(titlesAreSame('Step 3 - Configure', 'Configure')).toBe(true);
    expect(titlesAreSame('Step 4. Verify', 'Verify')).toBe(true);
  });

  it('completely different titles do NOT match', () => {
    expect(titlesAreSame('Install ABAP', 'Build a Fiori app')).toBe(false);
  });

  it('empty/null titles do NOT match', () => {
    expect(titlesAreSame(null, 'x')).toBe(false);
    expect(titlesAreSame('', 'x')).toBe(false);
  });
});

describe('pairMigratedSteps', () => {
  it('pairs migrated stepOrder=N with native stepOrder=N+1 on title-exact match', () => {
    const rows = [
      mig(0, { TITLE: 'Install ABAP Development Tools' }),
      nat(1, { TITLE: 'Install ABAP Development Tools' }),
    ];
    const r = pairMigratedSteps(rows, 1);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0].migrated.LEGACYID).toBe(100);
    expect(r.pairs[0].native.LEGACYID).toBe(201);
    expect(r.orphans).toHaveLength(0);
  });

  it('pairs on Step-prefix title match', () => {
    const rows = [
      mig(0, { TITLE: 'Step 1: Install ABAP Development Tools' }),
      nat(1, { TITLE: 'Install ABAP Development Tools' }),
    ];
    const r = pairMigratedSteps(rows, 5);
    expect(r.pairs).toHaveLength(1);
    expect(r.orphans).toHaveLength(0);
  });

  it('handles multiple migrated steps in one tutorial (canonical case)', () => {
    const rows = [
      mig(0, { TITLE: 'Step 1: Install ABAP' }),
      mig(1, { TITLE: 'Step 2: Configure' }),
      mig(2, { TITLE: 'Step 3: Verify' }),
      nat(1, { TITLE: 'Install ABAP' }),
      nat(2, { TITLE: 'Configure' }),
      nat(3, { TITLE: 'Verify' }),
      // A native row with no migrated counterpart (e.g. recently added "Test yourself")
      nat(4, { TITLE: 'Test yourself' }),
    ];
    const r = pairMigratedSteps(rows, 4);
    expect(r.pairs).toHaveLength(3);
    expect(r.pairs.map(p => p.migrated.STEPORDER).sort()).toEqual([0, 1, 2]);
    expect(r.pairs.map(p => p.native.STEPORDER).sort()).toEqual([1, 2, 3]);
    expect(r.orphans).toHaveLength(0);
    // The unmatched native row (stepOrder=4) survives in `kept`, not pairs.
    expect(r.kept.find(k => k.STEPORDER === 4)).toBeDefined();
  });

  it('does NOT pair when native title is unrelated', () => {
    const rows = [
      mig(0, { TITLE: 'Install ABAP' }),
      nat(1, { TITLE: 'Build a Fiori app' }),
    ];
    const r = pairMigratedSteps(rows, 1);
    expect(r.pairs).toHaveLength(0);
    // Migrated becomes an orphan because no title-matching native exists.
    expect(r.orphans).toHaveLength(1);
  });

  it('flags migrated row at stepOrder >= stepCount as orphan when no native pair exists', () => {
    const rows = [
      // Migrated stepOrder=5 on a 5-step tutorial — the publish path emitted
      // 1..5, so there is no native at stepOrder=6 to pair with.
      mig(5, { LEGACYID: 999, TITLE: 'Step 6: Removed' }),
      nat(1, { TITLE: 'A' }),
      nat(2, { TITLE: 'B' }),
      nat(3, { TITLE: 'C' }),
      nat(4, { TITLE: 'D' }),
      nat(5, { TITLE: 'E' }),
    ];
    const r = pairMigratedSteps(rows, 5);
    expect(r.pairs).toHaveLength(0);
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0].LEGACYID).toBe(999);
  });

  it('treats rows with neither STATUS=NULL nor STATUS=ACTIVE as untouched', () => {
    const rows = [
      mig(0, { TITLE: 'A' }),
      nat(1, { TITLE: 'A' }),
      { ID: 'odd', LEGACYID: 500, STEPORDER: 99, STATUS: 'WEIRD', TITLE: 'X' },
    ];
    const r = pairMigratedSteps(rows, 1);
    expect(r.pairs).toHaveLength(1);
    expect(r.kept.find(k => k.STATUS === 'WEIRD')).toBeDefined();
  });
});

describe('planTaskRecordOps', () => {
  // Helper to build a TaskRecord row.
  const tr = (id, userId, taskLegacyId) => ({
    ID: id, USER_ID: userId, TASKLEGACYID: taskLegacyId,
  });

  it('user with only migrated record → redirect', () => {
    const records = [tr('tr-1', 'user-A', 100)];
    const ops = planTaskRecordOps(records, 100, 200);
    expect(ops).toEqual([{ op: 'redirect', recordId: 'tr-1' }]);
  });

  it('user with both migrated AND native record → collision-delete the migrated one', () => {
    const records = [tr('tr-1', 'user-A', 100), tr('tr-2', 'user-A', 200)];
    const ops = planTaskRecordOps(records, 100, 200);
    expect(ops).toEqual([{ op: 'collision-delete', recordId: 'tr-1' }]);
  });

  it('mixed users — A redirect, B collision-delete, C native-only no-op', () => {
    const records = [
      tr('tr-A1', 'A', 100),               // A: only migrated → redirect
      tr('tr-B1', 'B', 100),               // B: both → collision-delete migrated
      tr('tr-B2', 'B', 200),
      tr('tr-C1', 'C', 200),               // C: only native → no op (not in migrated list)
    ];
    const ops = planTaskRecordOps(records, 100, 200);
    // Sort for stable assertion (Map iteration order is insertion order, but
    // we don't want to depend on that).
    const sorted = ops.slice().sort((a, b) => a.recordId.localeCompare(b.recordId));
    expect(sorted).toEqual([
      { op: 'redirect',          recordId: 'tr-A1' },
      { op: 'collision-delete',  recordId: 'tr-B1' },
    ]);
  });

  it('user with multiple migrated records but one native → ALL migrated become collision-delete', () => {
    // Theoretical edge case: same user has somehow accumulated >1 migrated
    // record on the same legacyId. Native exists, so all go.
    const records = [
      tr('tr-1', 'A', 100),
      tr('tr-2', 'A', 100),
      tr('tr-3', 'A', 200),
    ];
    const ops = planTaskRecordOps(records, 100, 200);
    expect(ops.filter(o => o.op === 'collision-delete')).toHaveLength(2);
    expect(ops.filter(o => o.op === 'redirect')).toHaveLength(0);
  });
});
