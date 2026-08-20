import { describe, it, expect } from 'vitest';
import { collapseSlots, evaluateSlots, tokenFor } from '../../srv/lib/completion-rollup.js';

describe('collapseSlots', () => {
  it('makes one slot per linear item', () => {
    const slots = collapseSlots([
      { taskType: 'TUTORIAL', taskLegacyId: 10, itemOrder: 1, altGroupKey: null, groupId: null },
      { taskType: 'PUZZLE',   taskLegacyId: 20, itemOrder: 2, altGroupKey: null, groupId: null },
    ]);
    expect(slots).toEqual([{ tokens: ['TUTORIAL:10'] }, { tokens: ['PUZZLE:20'] }]);
  });

  it('collapses an alt-group into one multi-token slot', () => {
    const slots = collapseSlots([
      { taskType: 'TUTORIAL', taskLegacyId: 10, itemOrder: 1, altGroupKey: 'A', groupId: null },
      { taskType: 'TUTORIAL', taskLegacyId: 11, itemOrder: 1, altGroupKey: 'A', groupId: null },
    ]);
    expect(slots).toHaveLength(1);
    expect(new Set(slots[0].tokens)).toEqual(new Set(['TUTORIAL:10', 'TUTORIAL:11']));
  });

  it('emits GROUP items as group slots, never alt-collapsed', () => {
    const slots = collapseSlots([
      { taskType: 'GROUP', taskLegacyId: 99, itemOrder: 1, altGroupKey: null, groupId: 5 },
    ]);
    expect(slots).toEqual([{ groupId: 5 }]);
  });
});

describe('evaluateSlots', () => {
  const done = new Set(['TUTORIAL:10']);
  it('counts a satisfied token slot', () => {
    expect(evaluateSlots([{ tokens: ['TUTORIAL:10'] }], done, () => [])).toEqual({ satisfied: 1, total: 1 });
  });
  it('any branch satisfies an alt-group slot', () => {
    expect(evaluateSlots([{ tokens: ['TUTORIAL:10', 'TUTORIAL:11'] }], done, () => [])).toEqual({ satisfied: 1, total: 1 });
  });
  it('a group slot needs all its inner slots satisfied', () => {
    const resolve = () => [{ tokens: ['TUTORIAL:10'] }, { tokens: ['TUTORIAL:12'] }];
    expect(evaluateSlots([{ groupId: 5 }], done, resolve)).toEqual({ satisfied: 0, total: 1 });
    const done2 = new Set(['TUTORIAL:10', 'TUTORIAL:12']);
    expect(evaluateSlots([{ groupId: 5 }], done2, resolve)).toEqual({ satisfied: 1, total: 1 });
  });
  it('tokenFor builds the composite key', () => {
    expect(tokenFor('MISSION', 7)).toBe('MISSION:7');
  });
});
