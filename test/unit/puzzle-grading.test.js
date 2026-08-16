// test/unit/puzzle-grading.test.js
import { expect, test } from 'vitest';
import { buildSlots, gradeEntries, validatePuzzle, deriveSlotIds } from '../../srv/lib/puzzle-grading.js';

const grid = [
  [{black:false,number:1},{black:false,number:null},{black:false,number:2}],
  [{black:false,number:3},{black:true,number:null},{black:false,number:null}],
  [{black:false,number:4},{black:false,number:null},{black:false,number:null}],
];

test('buildSlots ids are row-col-dir', () => {
  const slots = buildSlots(grid);
  expect(slots.some(s => s.id === '0-0-across')).toBe(true);
  expect(slots.some(s => s.id === '0-0-down')).toBe(true);
});

test('gradeEntries marks correct words and detects complete', () => {
  const sol = { '0,0':'C','0,1':'A','0,2':'T' };
  const r = gradeEntries({ solution: sol, entries: [{ slotId:'0-0-across', word:'cat' }] });
  expect(r.results.find(x => x.slotId==='0-0-across').correct).toBe(true);
  expect(r.complete).toBe(true);
  const r2 = gradeEntries({ solution: sol, entries: [{ slotId:'0-0-across', word:'DOG' }] });
  expect(r2.results.find(x => x.slotId==='0-0-across').correct).toBe(false);
  expect(r2.complete).toBe(false);
});

test('gradeEntries never returns answer letters', () => {
  const sol = { '0,0':'C','0,1':'A','0,2':'T' };
  const r = gradeEntries({ solution: sol, entries: [{ slotId:'0-0-across', word:'DOG' }] });
  expect(JSON.stringify(r)).not.toMatch(/CAT/);
});

test('validatePuzzle rejects a white cell with no answer', () => {
  const layout = JSON.stringify({ rows:1, cols:2, grid:[[{black:false},{black:false}]], clues:{'0-0-across':'x'} });
  const bad = validatePuzzle({ layout, solution: JSON.stringify({ '0,0':'A' }) });
  expect(bad.ok).toBe(false);
});

test('validatePuzzle accepts numeric-string rows/cols (issue #1834)', () => {
  // The admin builder two-way-binds Rows/Cols Number inputs with no type, so a
  // touched field serialises rows/cols as strings ("1"/"2"). The grid array
  // length is still a number, so a strict `grid.length !== rows` would report
  // "grid row count != rows" even though the puzzle is well-formed. parseLayout
  // must coerce so a numeric string validates identically to a number.
  const layout = JSON.stringify({
    rows: '1', cols: '2',
    grid: [[{ black: false }, { black: false }]],
    clues: { '0-0-across': 'x' }
  });
  const ok = validatePuzzle({ layout, solution: JSON.stringify({ '0,0': 'A', '0,1': 'B' }) });
  expect(ok.ok).toBe(true);
});

test('deriveSlotIds returns correct across and down slot starts', () => {
  // 3-cell across run → one across slot at 0-0-across
  const solAcross = { '0,0':'C','0,1':'A','0,2':'T' };
  const ids = deriveSlotIds(solAcross);
  expect([...ids]).toEqual(['0-0-across']);

  // L-shape: across (0,0)-(0,1) + down (0,0)-(1,0)
  const solL = { '0,0':'A','0,1':'B','1,0':'C' };
  const idsL = deriveSlotIds(solL);
  expect(idsL.has('0-0-across')).toBe(true);
  expect(idsL.has('0-0-down')).toBe(true);
  expect(idsL.size).toBe(2);

  // Single-letter cell (no run of ≥2) → no slots
  const solSingle = { '0,0':'X' };
  expect(deriveSlotIds(solSingle).size).toBe(0);
});
