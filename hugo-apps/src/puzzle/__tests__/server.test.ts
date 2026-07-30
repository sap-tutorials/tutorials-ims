// hugo-apps/src/puzzle/__tests__/server.test.ts
import { describe, it, expect } from 'vitest';
import { buildCheckEntries, buildCellStatus } from '../lib/server';

// ── Minimal fixtures ──────────────────────────────────────────────────────────
const slot0 = {
  id: '0-0-across',
  cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }],
};
const slot1 = {
  id: '0-0-down',
  cells: [{ r: 0, c: 0 }, { r: 1, c: 0 }, { r: 2, c: 0 }],
};

describe('buildCheckEntries', () => {
  it('includes fully-filled slots with uppercased word', () => {
    const answers = { '0,0': 'c', '0,1': 'a', '0,2': 't' };
    const entries = buildCheckEntries([slot0], answers);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ slotId: '0-0-across', word: 'CAT' });
  });

  it('excludes partially filled slots', () => {
    // only 2 of 3 cells filled
    const answers = { '0,0': 'c', '0,1': 'a' };
    const entries = buildCheckEntries([slot0], answers);
    expect(entries).toHaveLength(0);
  });

  it('excludes slots with an empty-string answer cell', () => {
    const answers = { '0,0': 'c', '0,1': '', '0,2': 't' };
    const entries = buildCheckEntries([slot0], answers);
    expect(entries).toHaveLength(0);
  });

  it('includes multiple filled slots', () => {
    const answers = {
      '0,0': 'a', '0,1': 'b', '0,2': 'c', // slot0 across
      '1,0': 'd', '2,0': 'e',               // slot1 down needs 3 cells
    };
    // slot1 has 3 cells (r0-r2, c0); '0,0' is 'a', '1,0' is 'd', '2,0' is 'e'
    const answers2 = { '0,0': 'a', '0,1': 'b', '0,2': 'c', '1,0': 'd', '2,0': 'e' };
    const entries = buildCheckEntries([slot0, slot1], answers2);
    // slot0 fully filled: CAT... slot1: cells [0,0],[1,0],[2,0] → 'a','d','e'
    expect(entries).toHaveLength(2);
    const e0 = entries.find(e => e.slotId === '0-0-across')!;
    const e1 = entries.find(e => e.slotId === '0-0-down')!;
    expect(e0.word).toBe('ABC');
    expect(e1.word).toBe('ADE');
  });

  it('returns empty array when no slots filled', () => {
    const entries = buildCheckEntries([slot0, slot1], {});
    expect(entries).toHaveLength(0);
  });

  it('uppercases lowercase input letters', () => {
    const answers = { '0,0': 'f', '0,1': 'o', '0,2': 'o' };
    const entries = buildCheckEntries([slot0], answers);
    expect(entries[0].word).toBe('FOO');
  });
});

describe('buildCellStatus', () => {
  it('marks cells of correct slot as correct', () => {
    const results = [{ slotId: '0-0-across', correct: true }];
    const status = buildCellStatus(results, [slot0]);
    expect(status['0,0']).toBe('correct');
    expect(status['0,1']).toBe('correct');
    expect(status['0,2']).toBe('correct');
  });

  it('marks cells of wrong slot as wrong', () => {
    const results = [{ slotId: '0-0-across', correct: false }];
    const status = buildCellStatus(results, [slot0]);
    expect(status['0,0']).toBe('wrong');
    expect(status['0,1']).toBe('wrong');
    expect(status['0,2']).toBe('wrong');
  });

  it('handles mixed correct/wrong across different slots', () => {
    const results = [
      { slotId: '0-0-across', correct: true },
      { slotId: '0-0-down',   correct: false },
    ];
    const status = buildCellStatus(results, [slot0, slot1]);
    // slot0 cells → correct
    expect(status['0,1']).toBe('correct');
    expect(status['0,2']).toBe('correct');
    // slot1 cells → wrong (r1c0, r2c0); r0c0 is shared — last write wins (wrong from slot1)
    expect(status['1,0']).toBe('wrong');
    expect(status['2,0']).toBe('wrong');
    // Note: shared cell [0,0] will be overwritten by the last slot processed
    // This is intentional — the caller sees the last result applied.
  });

  it('ignores unknown slotIds', () => {
    const results = [{ slotId: 'ghost-slot', correct: true }];
    const status = buildCellStatus(results, [slot0]);
    expect(Object.keys(status)).toHaveLength(0);
  });

  it('returns empty map for empty results', () => {
    expect(buildCellStatus([], [slot0])).toEqual({});
  });
});
