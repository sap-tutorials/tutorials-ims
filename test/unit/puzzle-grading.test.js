// test/unit/puzzle-grading.test.js
import { expect, test } from 'vitest';
import { buildSlots, gradeEntries, validatePuzzle } from '../../srv/lib/puzzle-grading.js';

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
