// app/admin/puzzles/webapp/lib/crossword-geometry.js
// Pure, framework-agnostic crossword grid geometry.
// Ported from the POC src/crossword.js pure functions.
// Slot ids: `${row}-${startCol}-across` / `${startRow}-${col}-down`
// ESM export — imported by vitest unit tests directly; UI5 controller
// wraps via sap.ui.define in Task 11.

/**
 * Create an empty grid of white cells.
 * Each cell: { black: false, letter: '', number: null }
 */
export function makeEmptyGrid(rows, cols) {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ black: false, letter: '', number: null }))
  );
}

/**
 * Set cell (r, c) to black and mirror 180° (rows-1-r, cols-1-c).
 * Returns a new grid (immutable).
 */
export function setBlack(grid, r, c) {
  const rows = grid.length;
  const cols = grid[0] ? grid[0].length : 0;
  const g = grid.map(row => row.map(cell => ({ ...cell })));
  g[r][c].black = true;
  g[rows - 1 - r][cols - 1 - c].black = true;
  return g;
}

/**
 * Find all slots (across + down runs) of length >= minLen.
 * Returns array of { id, dir, row, col, len, cells:[{r,c}] }
 */
export function findSlots(grid, minLen = 2) {
  const ROWS = grid.length;
  const COLS = grid[0] ? grid[0].length : 0;
  const slots = [];

  // Across
  for (let r = 0; r < ROWS; r++) {
    let c = 0;
    while (c < COLS) {
      if (grid[r][c].black) { c++; continue; }
      const start = c;
      while (c < COLS && !grid[r][c].black) c++;
      const len = c - start;
      if (len >= minLen) {
        const cells = Array.from({ length: len }, (_, i) => ({ r, c: start + i }));
        slots.push({ id: `${r}-${start}-across`, dir: 'across', row: r, col: start, len, cells });
      }
    }
  }

  // Down
  for (let c = 0; c < COLS; c++) {
    let r = 0;
    while (r < ROWS) {
      if (grid[r][c].black) { r++; continue; }
      const start = r;
      while (r < ROWS && !grid[r][c].black) r++;
      const len = r - start;
      if (len >= minLen) {
        const cells = Array.from({ length: len }, (_, i) => ({ r: start + i, c }));
        slots.push({ id: `${start}-${c}-down`, dir: 'down', row: start, col: c, len, cells });
      }
    }
  }

  return slots;
}

/**
 * Assign sequential numbers to cells that start across or down words.
 * Numbers are assigned left-to-right, top-to-bottom.
 * Returns a new grid with `.number` set on qualifying cells.
 * @param {number} minLen - minimum run length to count as a word (default 2)
 */
export function numberGrid(grid, minLen = 2) {
  const ROWS = grid.length;
  const COLS = grid[0] ? grid[0].length : 0;
  const g = grid.map(row => row.map(cell => ({ ...cell, number: null })));

  const runLen = (r, c, dr, dc) => {
    let len = 0, rr = r, cc = c;
    while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && !g[rr][cc].black) {
      len++; rr += dr; cc += dc;
    }
    return len;
  };

  const startsAcross = (r, c) =>
    !g[r][c].black &&
    (c === 0 || g[r][c - 1].black) &&
    runLen(r, c, 0, 1) >= minLen;

  const startsDown = (r, c) =>
    !g[r][c].black &&
    (r === 0 || g[r - 1][c].black) &&
    runLen(r, c, 1, 0) >= minLen;

  let n = 1;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (startsAcross(r, c) || startsDown(r, c)) {
        g[r][c].number = n++;
      }
    }
  }
  return g;
}

/**
 * True if every cell in the slot has a non-empty letter.
 */
export function slotFilled(grid, slot) {
  return slot.cells.every(({ r, c }) => !!grid[r][c].letter);
}

/**
 * True if any cell in this slot is shared with a slot in a different direction.
 */
export function slotHasCrossing(slot, allSlots) {
  const others = allSlots.filter(s => s.id !== slot.id);
  return slot.cells.some(({ r, c }) =>
    others.some(s => s.cells.some(cell => cell.r === r && cell.c === c))
  );
}

/**
 * Place word letters into slot cells. Returns a new grid.
 */
export function placeWord(grid, slot, word) {
  const g = grid.map(row => row.map(cell => ({ ...cell })));
  slot.cells.forEach(({ r, c }, i) => {
    g[r][c].letter = (word[i] || '').toUpperCase();
  });
  return g;
}

/**
 * Clear letters from slot cells. Returns a new grid.
 */
export function removeWord(grid, slot) {
  const g = grid.map(row => row.map(cell => ({ ...cell })));
  slot.cells.forEach(({ r, c }) => { g[r][c].letter = ''; });
  return g;
}

/**
 * True if word length matches slot length and no existing letter conflicts.
 */
export function canFit(grid, slot, word) {
  if (word.length !== slot.len) return false;
  return slot.cells.every(({ r, c }, i) => {
    const existing = grid[r][c].letter;
    return !existing || existing === word[i].toUpperCase();
  });
}
