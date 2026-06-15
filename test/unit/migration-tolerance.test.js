import { describe, it, expect } from 'vitest';
import {
  classifyEntity,
  checkTolerance,
  REFERENCE_ENTITIES,
  ACTIVITY_ENTITIES,
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
    expect(classifyEntity('tutorialtags')).toBe('reference');
    expect(classifyEntity('steps')).toBe('reference');
    expect(classifyEntity('accomplishments')).toBe('reference');
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
    const overlap = REFERENCE_ENTITIES.filter(e => ACTIVITY_ENTITIES.includes(e));
    expect(overlap).toEqual([]);
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

  it('activity tables: diff within ±2 is OK', () => {
    expect(checkTolerance('taskrecords', 892341, 892340).ok).toBe(true);
    expect(checkTolerance('taskrecords', 892341, 892343).ok).toBe(true);
    expect(checkTolerance('taskrecords', 892341, 892339).ok).toBe(true);
  });

  it('activity tables: diff beyond ±2 fails', () => {
    expect(checkTolerance('taskrecords', 892341, 892338).ok).toBe(false);
    expect(checkTolerance('taskrecords', 892341, 892344).ok).toBe(false);
  });

  it('reports the diff signed (target - source)', () => {
    expect(checkTolerance('users', 100, 98).diff).toBe(-2);
    expect(checkTolerance('users', 100, 102).diff).toBe(2);
  });

  it('throws on unknown entity (does not silently allow)', () => {
    expect(() => checkTolerance('mystery', 0, 0)).toThrow(/unknown entity/i);
  });
});
