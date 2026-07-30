// hugo-apps/src/puzzle/lib/geometry.ts
// Pure, dependency-free crossword grid geometry for the Vue solver island.
// Slot ids are `${row}-${startCol}-across` / `${startRow}-${col}-down` —
// IDENTICAL to srv/lib/puzzle-grading.js and app/admin/puzzles/webapp/lib/crossword-geometry.js.

export interface Cell {
  black: boolean;
  number?: number | null;
}

export interface SlotCell {
  r: number;
  c: number;
}

export interface Slot {
  id: string;
  dir: 'across' | 'down';
  row: number;
  col: number;
  len: number;
  cells: SlotCell[];
  number: number | null;
}

export interface Cursor {
  r: number;
  c: number;
}

/**
 * Build all across + down slots of length >= minLen.
 * Slot ids: `${row}-${startCol}-across` / `${startRow}-${col}-down`.
 * Mirrors the algorithm in srv/lib/puzzle-grading.js::buildSlots.
 */
export function buildSlots(grid: Cell[][], minLen = 2): Slot[] {
  const ROWS = grid.length;
  const COLS = grid[0] ? grid[0].length : 0;
  const slots: Slot[] = [];

  // Across runs
  for (let r = 0; r < ROWS; r++) {
    let c = 0;
    while (c < COLS) {
      if (grid[r][c].black) { c++; continue; }
      const start = c;
      while (c < COLS && !grid[r][c].black) c++;
      const len = c - start;
      if (len >= minLen) {
        const cells = Array.from({ length: len }, (_, i) => ({ r, c: start + i }));
        slots.push({
          id: `${r}-${start}-across`,
          dir: 'across',
          row: r,
          col: start,
          len,
          cells,
          number: grid[r][start].number ?? null,
        });
      }
    }
  }

  // Down runs
  for (let c = 0; c < COLS; c++) {
    let r = 0;
    while (r < ROWS) {
      if (grid[r][c].black) { r++; continue; }
      const start = r;
      while (r < ROWS && !grid[r][c].black) r++;
      const len = r - start;
      if (len >= minLen) {
        const cells = Array.from({ length: len }, (_, i) => ({ r: start + i, c }));
        slots.push({
          id: `${start}-${c}-down`,
          dir: 'down',
          row: start,
          col: c,
          len,
          cells,
          number: grid[start][c].number ?? null,
        });
      }
    }
  }

  return slots;
}

/**
 * Find the slot in direction `dir` that contains cell {r,c}.
 */
export function findActiveSlot(pos: Cursor, dir: 'across' | 'down', slots: Slot[]): Slot | null {
  return slots.find(s =>
    s.dir === dir && s.cells.some(cell => cell.r === pos.r && cell.c === pos.c)
  ) ?? null;
}

/**
 * Advance the cursor one step within its current slot (across: right, down: down).
 * Clamps at the last cell of the slot.
 */
export function advanceCursor(pos: Cursor, dir: 'across' | 'down', slots: Slot[]): Cursor {
  const slot = findActiveSlot(pos, dir, slots);
  if (!slot) return pos;
  const idx = slot.cells.findIndex(cell => cell.r === pos.r && cell.c === pos.c);
  if (idx < 0 || idx >= slot.cells.length - 1) return pos;
  return { r: slot.cells[idx + 1].r, c: slot.cells[idx + 1].c };
}

/**
 * Retreat the cursor one step within its current slot (across: left, down: up).
 * Clamps at the first cell of the slot.
 */
export function retreatCursor(pos: Cursor, dir: 'across' | 'down', slots: Slot[]): Cursor {
  const slot = findActiveSlot(pos, dir, slots);
  if (!slot) return pos;
  const idx = slot.cells.findIndex(cell => cell.r === pos.r && cell.c === pos.c);
  if (idx <= 0) return pos;
  return { r: slot.cells[idx - 1].r, c: slot.cells[idx - 1].c };
}

/**
 * Build a CSS key for a cell — used as reactive answers map key.
 */
export function cellKey(r: number, c: number): string {
  return `${r},${c}`;
}
