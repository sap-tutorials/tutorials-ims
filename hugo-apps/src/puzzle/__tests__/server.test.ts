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

describe('buildCheckEntries (>=1 filled)', () => {
  it('includes fully-filled slots with uppercased word', () => {
    const answers = { '0,0': 'c', '0,1': 'a', '0,2': 't' };
    const entries = buildCheckEntries([slot0], answers);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ slotId: '0-0-across', word: 'CAT' });
  });

  it('includes a partially-filled slot', () => {
    const slots = [{ id: '0-0-across', cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }] }];
    const answers = { '0,0': 'C', '0,1': 'A' }; // 0,2 blank
    const entries = buildCheckEntries(slots, answers);
    expect(entries).toEqual([{ slotId: '0-0-across', word: 'CA ' }]);
  });

  it('excludes a fully-empty slot', () => {
    const slots = [{ id: '0-0-across', cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }] }];
    expect(buildCheckEntries(slots, {})).toEqual([]);
  });

  it('excludes slots with an empty-string answer cell (all blanks)', () => {
    const answers = { '0,0': '', '0,1': '', '0,2': '' };
    const entries = buildCheckEntries([slot0], answers);
    expect(entries).toHaveLength(0);
  });

  it('includes multiple slots with >=1 filled cell each', () => {
    const answers2 = { '0,0': 'a', '0,1': 'b', '0,2': 'c', '1,0': 'd', '2,0': 'e' };
    const entries = buildCheckEntries([slot0, slot1], answers2);
    // slot0 fully filled: ABC; slot1: cells [0,0],[1,0],[2,0] → 'a','d','e' → ADE
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

describe('buildCellStatus (per-cell)', () => {
  it('maps per-cell correctness to r,c → status', () => {
    const cells = [{ r: 0, c: 0, correct: true }, { r: 0, c: 1, correct: false }];
    expect(buildCellStatus(cells)).toEqual({ '0,0': 'correct', '0,1': 'wrong' });
  });

  it('marks correct cells as correct', () => {
    const cells = [{ r: 0, c: 0, correct: true }, { r: 0, c: 1, correct: true }, { r: 0, c: 2, correct: true }];
    const status = buildCellStatus(cells);
    expect(status['0,0']).toBe('correct');
    expect(status['0,1']).toBe('correct');
    expect(status['0,2']).toBe('correct');
  });

  it('marks wrong cells as wrong', () => {
    const cells = [{ r: 0, c: 0, correct: false }, { r: 0, c: 1, correct: false }];
    const status = buildCellStatus(cells);
    expect(status['0,0']).toBe('wrong');
    expect(status['0,1']).toBe('wrong');
  });

  it('handles mixed correct/wrong cells', () => {
    const cells = [
      { r: 0, c: 0, correct: true },
      { r: 1, c: 0, correct: false },
    ];
    const status = buildCellStatus(cells);
    expect(status['0,0']).toBe('correct');
    expect(status['1,0']).toBe('wrong');
  });

  it('returns empty map for empty cells array', () => {
    expect(buildCellStatus([])).toEqual({});
  });
});

describe('postResetProgress (export shape)', () => {
  it('is exported as a function', async () => {
    const mod = await import('../lib/server');
    expect(typeof mod.postResetProgress).toBe('function');
  });

  it('accepts (apiUrl, slug) signature', async () => {
    const { postResetProgress } = await import('../lib/server');
    // Two required parameters: apiUrl (string), slug (string)
    expect(postResetProgress.length).toBe(2);
  });
});
