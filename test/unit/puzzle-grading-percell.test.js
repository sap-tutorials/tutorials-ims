import { describe, it, expect } from 'vitest';
import { gradeEntries } from '../../srv/lib/puzzle-grading.js';

// Solution: across 0-0 = CAT (0,0)(0,1)(0,2); down 0-0 = COW (0,0)(1,0)(2,0)
const solution = JSON.stringify({ '0,0':'C','0,1':'A','0,2':'T','1,0':'O','2,0':'W' });

describe('gradeEntries per-cell', () => {
  it('returns per-cell correctness, only the wrong letter marked wrong', () => {
    // User typed CXT across (X wrong at 0,1), COW down (all correct)
    const out = gradeEntries({ solution, entries: [
      { slotId: '0-0-across', word: 'CXT' },
      { slotId: '0-0-down',   word: 'COW' },
    ]});
    const cell = (r,c) => out.cells.find(x => x.r===r && x.c===c);
    expect(cell(0,0).correct).toBe(true);   // C
    expect(cell(0,1).correct).toBe(false);  // X ≠ A  ← only this one wrong
    expect(cell(0,2).correct).toBe(true);   // T
    expect(cell(1,0).correct).toBe(true);   // O
    expect(cell(2,0).correct).toBe(true);   // W
    // back-compat: whole-word results still present
    expect(out.results.find(x=>x.slotId==='0-0-across').correct).toBe(false);
    expect(out.results.find(x=>x.slotId==='0-0-down').correct).toBe(true);
  });

  it('a shared cell wrong in one direction is wrong overall (AND merge)', () => {
    // across correct CAT, but down submitted XOW (X wrong at shared 0,0)
    const out = gradeEntries({ solution, entries: [
      { slotId: '0-0-across', word: 'CAT' },
      { slotId: '0-0-down',   word: 'XOW' },
    ]});
    const cell = (r,c) => out.cells.find(x => x.r===r && x.c===c);
    expect(cell(0,0).correct).toBe(false); // shared cell: across says C-correct, down says X-wrong → wrong
    expect(cell(0,1).correct).toBe(true);
  });

  it('never leaks solution letters', () => {
    const out = gradeEntries({ solution, entries: [{ slotId:'0-0-across', word:'CXT' }] });
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('"A"'); // expected letter A never appears
    expect(out.cells.every(c => !('letter' in c) && !('expected' in c))).toBe(true);
  });
});
