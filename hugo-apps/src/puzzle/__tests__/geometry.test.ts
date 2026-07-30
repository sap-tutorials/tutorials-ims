// hugo-apps/src/puzzle/__tests__/geometry.test.ts
import { describe, it, expect } from 'vitest';
import { buildSlots, advanceCursor, retreatCursor, clueForSlot } from '../lib/geometry';

describe('island geometry', () => {
  it('builds row-col-dir slot ids', () => {
    const grid = [[{ black: false }, { black: false }, { black: false }]];
    expect(buildSlots(grid).some(s => s.id === '0-0-across')).toBe(true);
  });

  it('emits no slot for a run shorter than minLen', () => {
    // single white cell: run length 1 in both directions → skipped
    const grid = [[{ black: false }]];
    expect(buildSlots(grid)).toHaveLength(0);
  });

  it('produces across and down slots for a simple 3x3 open grid', () => {
    const grid = Array.from({ length: 3 }, () =>
      Array.from({ length: 3 }, () => ({ black: false }))
    );
    const slots = buildSlots(grid);
    const ids = slots.map(s => s.id);
    expect(ids).toContain('0-0-across');
    expect(ids).toContain('1-0-across');
    expect(ids).toContain('2-0-across');
    expect(ids).toContain('0-0-down');
    expect(ids).toContain('0-1-down');
    expect(ids).toContain('0-2-down');
  });

  it('slot cells match expected row/col pairs', () => {
    const grid = [[{ black: false }, { black: false }, { black: false }]];
    const slot = buildSlots(grid).find(s => s.id === '0-0-across')!;
    expect(slot.cells).toEqual([
      { r: 0, c: 0 },
      { r: 0, c: 1 },
      { r: 0, c: 2 },
    ]);
    expect(slot.len).toBe(3);
  });

  it('black cells split runs correctly', () => {
    const grid = [[
      { black: false }, { black: false },
      { black: true },
      { black: false }, { black: false }, { black: false },
    ]];
    const slots = buildSlots(grid);
    expect(slots.some(s => s.id === '0-0-across')).toBe(true);
    expect(slots.some(s => s.id === '0-3-across')).toBe(true);
    expect(slots.find(s => s.id === '0-0-across')!.len).toBe(2);
    expect(slots.find(s => s.id === '0-3-across')!.len).toBe(3);
  });

  describe('advanceCursor', () => {
    it('moves right for across direction', () => {
      const slots = buildSlots([[{ black: false }, { black: false }, { black: false }]]);
      const acrossSlot = slots.find(s => s.dir === 'across')!;
      const result = advanceCursor({ r: 0, c: 0 }, 'across', slots);
      expect(result).toEqual({ r: 0, c: 1 });
      void acrossSlot;
    });

    it('stays at last cell for across when at end', () => {
      const slots = buildSlots([[{ black: false }, { black: false }]]);
      const result = advanceCursor({ r: 0, c: 1 }, 'across', slots);
      expect(result).toEqual({ r: 0, c: 1 });
    });

    it('moves down for down direction', () => {
      const grid = [
        [{ black: false }],
        [{ black: false }],
        [{ black: false }],
      ];
      const result = advanceCursor({ r: 0, c: 0 }, 'down', buildSlots(grid));
      expect(result).toEqual({ r: 1, c: 0 });
    });
  });

  describe('retreatCursor', () => {    it('moves left for across direction', () => {
      const slots = buildSlots([[{ black: false }, { black: false }, { black: false }]]);
      const result = retreatCursor({ r: 0, c: 2 }, 'across', slots);
      expect(result).toEqual({ r: 0, c: 1 });
    });

    it('stays at first cell for across when at start', () => {
      const slots = buildSlots([[{ black: false }, { black: false }]]);
      const result = retreatCursor({ r: 0, c: 0 }, 'across', slots);
      expect(result).toEqual({ r: 0, c: 0 });
    });

    it('moves up for down direction', () => {
      const grid = [
        [{ black: false }],
        [{ black: false }],
        [{ black: false }],
      ];
      const result = retreatCursor({ r: 1, c: 0 }, 'down', buildSlots(grid));
      expect(result).toEqual({ r: 0, c: 0 });
    });
  });

  describe('clueForSlot — flat slot-id keyed lookup', () => {
    it('resolves a clue by flat slot.id (not by number+direction)', () => {
      const grid = [[{ black: false }, { black: false }, { black: false }]];
      const slots = buildSlots(grid);
      const slot = slots.find(s => s.id === '0-0-across')!;
      const cluesFlat = { '0-0-across': 'Feline' };
      expect(clueForSlot(slot, cluesFlat)).toBe('Feline');
    });

    it('returns empty string when slot.id not in flat map', () => {
      const grid = [[{ black: false }, { black: false }]];
      const slots = buildSlots(grid);
      expect(clueForSlot(slots[0], {})).toBe('');
    });

    it('resolves down clues by slot.id', () => {
      const grid = [
        [{ black: false }],
        [{ black: false }],
      ];
      const slots = buildSlots(grid);
      const downSlot = slots.find(s => s.dir === 'down')!;
      const cluesFlat = { [downSlot.id]: 'Canine' };
      expect(clueForSlot(downSlot, cluesFlat)).toBe('Canine');
    });

    it('does NOT resolve clues keyed by number (old schema)', () => {
      // Guard: if someone passes nested {across:{1:'Feline'}} it returns ''
      const grid = [[{ black: false, number: 1 }, { black: false }]];
      const slots = buildSlots(grid);
      const slot = slots.find(s => s.dir === 'across')!;
      // Simulate the OLD (wrong) schema — should return empty
      const wrongSchema = { '1': 'Feline' } as Record<string, string>;
      expect(clueForSlot(slot, wrongSchema)).toBe('');
    });
  });
});
