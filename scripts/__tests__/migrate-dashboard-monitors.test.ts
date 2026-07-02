// scripts/__tests__/migrate-dashboard-monitors.test.ts
//
// Unit tests for buildMigrateDecision — the pure diff/decision function
// that drives scripts/migrate-dashboard-monitors.cjs. Kind-agnostic
// (no HANA). Exercises every bucket + edge case.
//
// Full context in the header of the target script.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildMigrateDecision, monitorRowUuid } = require('../migrate-dashboard-monitors.cjs');

describe('monitorRowUuid — deterministic per source-row id', () => {
  it('same input produces same UUID', () => {
    expect(monitorRowUuid(42)).toBe(monitorRowUuid(42));
    expect(monitorRowUuid('42')).toBe(monitorRowUuid(42)); // stringified
  });

  it('different inputs produce different UUIDs', () => {
    expect(monitorRowUuid(1)).not.toBe(monitorRowUuid(2));
  });
});

describe('buildMigrateDecision', () => {
  const tutorialMap = new Map<any, string>([
    [15733, 'tutorial-uuid-15733'],
    ['15733', 'tutorial-uuid-15733'],
    [5580, 'tutorial-uuid-5580'],
    ['5580', 'tutorial-uuid-5580'],
  ]);
  const userMap = new Map<string, string>([
    ['i838039', 'riley-uuid'],
    ['i809764', 'tom-uuid'],
  ]);

  it('will-insert when both tutorial and user resolve', () => {
    const row = { SOURCE_ID: 100, TUT_LEGACY_ID: 15733, USER_SAP_ID: 'I838039' };
    const d = buildMigrateDecision(row, tutorialMap, userMap);
    expect(d.bucket).toBe('will-insert');
    expect(d.tutorialId).toBe('tutorial-uuid-15733');
    expect(d.userId).toBe('riley-uuid');
    expect(d.monitorUuid).toBe(monitorRowUuid(100));
  });

  it('sapId lookup is case-insensitive + trims whitespace', () => {
    const row = { SOURCE_ID: 101, TUT_LEGACY_ID: 15733, USER_SAP_ID: '  i838039  ' };
    const d = buildMigrateDecision(row, tutorialMap, userMap);
    expect(d.userId).toBe('riley-uuid');
    expect(d.bucket).toBe('will-insert');
  });

  it('legacyId lookup works with either numeric or string source rep', () => {
    // Simulates hdb sometimes surfacing BIGINT as JS number, sometimes as string
    const numeric = buildMigrateDecision(
      { SOURCE_ID: 1, TUT_LEGACY_ID: 5580, USER_SAP_ID: 'I838039' },
      tutorialMap, userMap,
    );
    const stringy = buildMigrateDecision(
      { SOURCE_ID: 2, TUT_LEGACY_ID: '5580', USER_SAP_ID: 'I838039' },
      tutorialMap, userMap,
    );
    expect(numeric.tutorialId).toBe('tutorial-uuid-5580');
    expect(stringy.tutorialId).toBe('tutorial-uuid-5580');
  });

  it('bucket=orphan-tutorial when no DEV Tutorials.legacyId match', () => {
    const row = { SOURCE_ID: 200, TUT_LEGACY_ID: 999999, USER_SAP_ID: 'I838039' };
    const d = buildMigrateDecision(row, tutorialMap, userMap);
    expect(d.bucket).toBe('orphan-tutorial');
    expect(d.tutorialId).toBeNull();
    // userId is still reported for the CSV (useful debugging), even though
    // the row will be skipped.
    expect(d.userId).toBe('riley-uuid');
  });

  it('bucket=orphan-user when no DEV Users.sapId match', () => {
    const row = { SOURCE_ID: 201, TUT_LEGACY_ID: 15733, USER_SAP_ID: 'I999999' };
    const d = buildMigrateDecision(row, tutorialMap, userMap);
    expect(d.bucket).toBe('orphan-user');
    expect(d.tutorialId).toBe('tutorial-uuid-15733');
    expect(d.userId).toBeNull();
  });

  it('bucket=orphan-tutorial wins when BOTH would miss (tutorial is checked first)', () => {
    // A row where both misses would apply — we report the first-checked
    // orphan bucket for CSV clarity. Not a correctness requirement, but
    // documents the ordering to prevent surprise in the CSV output.
    const row = { SOURCE_ID: 202, TUT_LEGACY_ID: 999999, USER_SAP_ID: 'I999999' };
    expect(buildMigrateDecision(row, tutorialMap, userMap).bucket).toBe('orphan-tutorial');
  });

  it('null / empty USER_SAP_ID -> orphan-user (never crashes)', () => {
    const row1 = { SOURCE_ID: 300, TUT_LEGACY_ID: 15733, USER_SAP_ID: null };
    const row2 = { SOURCE_ID: 301, TUT_LEGACY_ID: 15733, USER_SAP_ID: '' };
    const row3 = { SOURCE_ID: 302, TUT_LEGACY_ID: 15733, USER_SAP_ID: '   ' };
    expect(buildMigrateDecision(row1, tutorialMap, userMap).bucket).toBe('orphan-user');
    expect(buildMigrateDecision(row2, tutorialMap, userMap).bucket).toBe('orphan-user');
    expect(buildMigrateDecision(row3, tutorialMap, userMap).bucket).toBe('orphan-user');
  });

  it('monitorUuid is deterministic per SOURCE_ID regardless of other fields', () => {
    const a = buildMigrateDecision(
      { SOURCE_ID: 42, TUT_LEGACY_ID: 15733, USER_SAP_ID: 'I838039' }, tutorialMap, userMap,
    );
    const b = buildMigrateDecision(
      { SOURCE_ID: 42, TUT_LEGACY_ID: 5580, USER_SAP_ID: 'I809764' }, tutorialMap, userMap,
    );
    expect(a.monitorUuid).toBe(b.monitorUuid);
    expect(a.monitorUuid).toBe(monitorRowUuid(42));
  });
});
