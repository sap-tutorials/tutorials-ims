import { describe, it, expect } from 'vitest';
import {
  classifyEntity,
  toleranceFor,
  checkTolerance,
  activityTolerance,
  REFERENCE_ENTITIES,
  REFERENCE_LOOSE_ENTITIES,
  ACTIVITY_ENTITIES,
  ACTIVITY_DRIFT_RATE_PER_MIN,
  FALLBACK_WINDOW_SECONDS,
} from '../../scripts/lib/migration-tolerance.cjs';

describe('classifyEntity', () => {
  it('classifies known reference entities as "reference"', () => {
    expect(classifyEntity('tutorials')).toBe('reference');
    expect(classifyEntity('missions')).toBe('reference');
    expect(classifyEntity('groups')).toBe('reference');
    expect(classifyEntity('tags')).toBe('reference');
    expect(classifyEntity('events')).toBe('reference');
    expect(classifyEntity('prizes')).toBe('reference');
    expect(classifyEntity('completionpaths')).toBe('reference');
    expect(classifyEntity('completionpathitems')).toBe('reference');
    expect(classifyEntity('steps')).toBe('reference');
    expect(classifyEntity('accomplishments')).toBe('reference');
  });

  it('classifies tutorialtags as "reference-loose" (#361: persistent FK orphans)', () => {
    expect(classifyEntity('tutorialtags')).toBe('reference-loose');
  });

  it('classifies known activity entities as "activity"', () => {
    expect(classifyEntity('users')).toBe('activity');
    expect(classifyEntity('taskrecords')).toBe('activity');
    expect(classifyEntity('prizerecords')).toBe('activity');
    expect(classifyEntity('accomplishmentrecords')).toBe('activity');
  });

  it('does NOT classify usermetadata (issue #330: dropped from migrator)', () => {
    expect(() => classifyEntity('usermetadata')).toThrow(/unknown entity/i);
  });

  it('throws on unknown entities — fail loud, never silently allow drift', () => {
    expect(() => classifyEntity('mystery_table')).toThrow(/unknown entity/i);
  });

  it('every entity declared is in exactly one bucket', () => {
    const looseKeys = Object.keys(REFERENCE_LOOSE_ENTITIES);
    const r = REFERENCE_ENTITIES.filter(e => ACTIVITY_ENTITIES.includes(e) || looseKeys.includes(e));
    const a = ACTIVITY_ENTITIES.filter(e => looseKeys.includes(e));
    expect(r).toEqual([]);
    expect(a).toEqual([]);
  });
});

describe('activityTolerance', () => {
  it('scales linearly with migration window seconds', () => {
    expect(activityTolerance(60)).toBe(ACTIVITY_DRIFT_RATE_PER_MIN);          // 1 min → 30
    expect(activityTolerance(600)).toBe(10 * ACTIVITY_DRIFT_RATE_PER_MIN);    // 10 min → 300
    expect(activityTolerance(5400)).toBe(90 * ACTIVITY_DRIFT_RATE_PER_MIN);   // 90 min → 2,700
  });

  it('rounds up partial minutes (Math.ceil)', () => {
    // 90s = 1.5 min → 45 (1.5 × 30)
    expect(activityTolerance(90)).toBe(45);
  });

  it('falls back to FALLBACK_WINDOW_SECONDS when input is missing/invalid', () => {
    const expected = Math.ceil((FALLBACK_WINDOW_SECONDS / 60) * ACTIVITY_DRIFT_RATE_PER_MIN);
    expect(activityTolerance(undefined)).toBe(expected);
    expect(activityTolerance(null)).toBe(expected);
    expect(activityTolerance(0)).toBe(expected);
    expect(activityTolerance(-100)).toBe(expected);
    expect(activityTolerance(NaN)).toBe(expected);
  });
});

describe('toleranceFor', () => {
  it('reference entities → 0', () => {
    expect(toleranceFor('tutorials')).toBe(0);
    expect(toleranceFor('missions')).toBe(0);
    expect(toleranceFor('completionpathitems')).toBe(0);
  });

  it('reference-loose entities → explicit ceiling', () => {
    expect(toleranceFor('tutorialtags')).toBe(REFERENCE_LOOSE_ENTITIES.tutorialtags);
    expect(toleranceFor('tutorialtags')).toBe(1500);
  });

  it('activity entities → window-scaled', () => {
    expect(toleranceFor('users', { migrationWindowSeconds: 1800 })).toBe(900);   // 30 min
    expect(toleranceFor('taskrecords', { migrationWindowSeconds: 5400 })).toBe(2700); // 90 min
  });

  it('activity entities → fallback when window missing', () => {
    const expected = Math.ceil((FALLBACK_WINDOW_SECONDS / 60) * ACTIVITY_DRIFT_RATE_PER_MIN);
    expect(toleranceFor('users')).toBe(expected);
    expect(toleranceFor('users', {})).toBe(expected);
  });
});

describe('checkTolerance', () => {
  it('reference tables: zero diff is OK', () => {
    expect(checkTolerance('tutorials', 1398, 1398)).toEqual({
      ok: true,
      diff: 0,
      tolerance: 0,
      class: 'reference',
    });
  });

  it('reference tables: any non-zero diff fails', () => {
    const r = checkTolerance('tutorials', 1398, 1397);
    expect(r.ok).toBe(false);
    expect(r.diff).toBe(-1);
  });

  it('reference-loose: tutorialtags absorbs the 2026-06-16 rehearsal -1,350 gap', () => {
    // From the 2026-06-16 rehearsal artifact: source 12,757 / target 11,407
    const r = checkTolerance('tutorialtags', 12757, 11407);
    expect(r.ok).toBe(true);
    expect(r.diff).toBe(-1350);
    expect(r.tolerance).toBe(1500);
    expect(r.class).toBe('reference-loose');
  });

  it('reference-loose: tutorialtags fails when gap exceeds ceiling', () => {
    const r = checkTolerance('tutorialtags', 100000, 80000);
    expect(r.ok).toBe(false);
    expect(r.diff).toBe(-20000);
    expect(r.tolerance).toBe(1500);
  });

  it('activity: 90-min window absorbs rehearsal -349 taskrecord drift', () => {
    const r = checkTolerance('taskrecords', 10813898, 10813549, { migrationWindowSeconds: 5400 });
    expect(r.ok).toBe(true);
    expect(r.diff).toBe(-349);
    expect(r.tolerance).toBe(2700);
    expect(r.class).toBe('activity');
  });

  it('activity: 90-min window absorbs rehearsal -28 user drift', () => {
    const r = checkTolerance('users', 786889, 786861, { migrationWindowSeconds: 5400 });
    expect(r.ok).toBe(true);
    expect(r.diff).toBe(-28);
  });

  it('activity: short windows give correspondingly tight tolerances', () => {
    const tight = checkTolerance('users', 100000, 100050, { migrationWindowSeconds: 60 });
    expect(tight.ok).toBe(false);   // 50 > 30
    expect(tight.tolerance).toBe(30);
  });

  it('activity: standalone-run fallback uses 2h tolerance', () => {
    const r = checkTolerance('taskrecords', 10000000, 10003500);
    expect(r.ok).toBe(true);
    expect(r.tolerance).toBe(3600);  // 120 min × 30
  });

  it('reports the diff signed (target - source)', () => {
    expect(checkTolerance('users', 100, 98, { migrationWindowSeconds: 60 }).diff).toBe(-2);
    expect(checkTolerance('users', 100, 102, { migrationWindowSeconds: 60 }).diff).toBe(2);
  });

  it('throws on unknown entity (does not silently allow)', () => {
    expect(() => checkTolerance('mystery', 0, 0)).toThrow(/unknown entity/i);
  });
});

describe('Issue #361 acceptance: 2026-06-16 rehearsal scenario passes', () => {
  it('all entities pass with the actual rehearsal numbers + 90-min window', () => {
    // From .migration-data/cutover-2026-06-16T14-32-49-580Z/tier-a-rowcount-diff.json:
    // the 3 FAILs Issue #361 was filed to address.
    const w = { migrationWindowSeconds: 5400 };
    expect(checkTolerance('users', 786889, 786861, w).ok).toBe(true);
    expect(checkTolerance('taskrecords', 10813898, 10813549, w).ok).toBe(true);
    expect(checkTolerance('tutorialtags', 12757, 11407, w).ok).toBe(true);
    // Entities that already passed continue to pass.
    expect(checkTolerance('tutorials', 2862, 2862, w).ok).toBe(true);
    expect(checkTolerance('missions', 888, 888, w).ok).toBe(true);
    expect(checkTolerance('groups', 359, 359, w).ok).toBe(true);
  });
});
