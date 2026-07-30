// srv/lib/puzzle-grading.js
// Pure, dependency-free puzzle grid logic. Shared by PuzzleService (grading),
// AdminService (validation), and tests. Slot ids are `${row}-${col}-${dir}`,
// matching the POC clue-key scheme. NEVER return solution letters to callers.

export function parseLayout(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  if (!o || !Array.isArray(o.grid)) throw new Error('missing grid');
  const rows = o.rows ?? o.grid.length;
  const cols = o.cols ?? (o.grid[0] ? o.grid[0].length : 0);
  return { rows, cols, grid: o.grid, clues: o.clues || {}, wordLengths: o.wordLengths || {} };
}

export function parseSolution(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object');
  return o;
}

export function buildSlots(grid, minLen = 2) {
  const ROWS = grid.length, COLS = grid[0] ? grid[0].length : 0;
  const slots = [];
  for (let r = 0; r < ROWS; r++) {
    let c = 0;
    while (c < COLS) {
      if (grid[r][c].black) { c++; continue; }
      const start = c;
      while (c < COLS && !grid[r][c].black) c++;
      const len = c - start;
      if (len >= minLen) {
        const cells = Array.from({ length: len }, (_, i) => ({ r, c: start + i }));
        slots.push({ id: `${r}-${start}-across`, dir: 'across', row: r, col: start, len, cells, number: grid[r][start].number ?? null });
      }
    }
  }
  for (let c = 0; c < COLS; c++) {
    let r = 0;
    while (r < ROWS) {
      if (grid[r][c].black) { r++; continue; }
      const start = r;
      while (r < ROWS && !grid[r][c].black) r++;
      const len = r - start;
      if (len >= minLen) {
        const cells = Array.from({ length: len }, (_, i) => ({ r: start + i, c }));
        slots.push({ id: `${start}-${c}-down`, dir: 'down', row: start, col: c, len, cells, number: grid[start][c].number ?? null });
      }
    }
  }
  return slots;
}

export function wordForSlot(slot, cellLetters) {
  return slot.cells.map(({ r, c }) => (cellLetters[`${r},${c}`] || '')).join('');
}

// Grade whole-word submissions. Returns per-slot booleans + a `complete` flag.
// Never leaks letters. slotId format `${row}-${col}-${dir}`.

/**
 * Derive all slot start-ids from a solution object.
 * A slot starts at a cell with no predecessor in that direction that has a
 * successor, i.e. the leftmost/topmost cell of a run of ≥2 white cells.
 *
 * @param {Record<string,string>} sol - parsed solution map "r,c"→letter
 * @returns {Set<string>} set of slotIds in `${r}-${c}-${dir}` format
 */
export function deriveSlotIds(sol) {
  const allSlotIds = new Set();
  for (const key of Object.keys(sol)) {
    const [r, c] = key.split(',').map(Number);
    if (sol[`${r},${c - 1}`] === undefined && sol[`${r},${c + 1}`] !== undefined) allSlotIds.add(`${r}-${c}-across`);
    if (sol[`${r - 1},${c}`] === undefined && sol[`${r + 1},${c}`] !== undefined) allSlotIds.add(`${r}-${c}-down`);
  }
  return allSlotIds;
}

export function gradeEntries({ solution, entries }) {
  const sol = parseSolution(solution);
  const expectedWord = (slotId) => {
    const m = /^(\d+)-(\d+)-(across|down)$/.exec(slotId);
    if (!m) return null;
    let r = +m[1], c = +m[2]; const dir = m[3];
    const letters = [];
    while (sol[`${r},${c}`] !== undefined) {
      letters.push(sol[`${r},${c}`]);
      if (dir === 'across') c++; else r++;
    }
    return letters.join('');
  };
  const results = (entries || []).map(({ slotId, word }) => {
    const expected = expectedWord(slotId);
    const got = String(word || '').toUpperCase();
    return { slotId, correct: expected != null && expected.length > 0 && got === expected };
  });
  const allSlotIds = deriveSlotIds(sol);
  const correctSet = new Set(results.filter(x => x.correct).map(x => x.slotId));
  const complete = allSlotIds.size > 0 && [...allSlotIds].every(id => correctSet.has(id));
  return { results, complete };
}

export function validatePuzzle({ layout, solution }) {
  let L, S;
  try { L = parseLayout(layout); } catch (e) { return { ok: false, error: `layout: ${e.message}` }; }
  try { S = parseSolution(solution); } catch (e) { return { ok: false, error: `solution: ${e.message}` }; }
  if (L.grid.length !== L.rows) return { ok: false, error: 'grid row count != rows' };
  for (let r = 0; r < L.rows; r++) {
    if (!Array.isArray(L.grid[r]) || L.grid[r].length !== L.cols) return { ok: false, error: `row ${r} width != cols` };
    for (let c = 0; c < L.cols; c++) {
      if (!L.grid[r][c].black && S[`${r},${c}`] === undefined) return { ok: false, error: `white cell ${r},${c} has no answer` };
    }
  }
  for (const s of buildSlots(L.grid)) if (!L.clues[s.id]) return { ok: false, error: `slot ${s.id} has no clue` };
  return { ok: true };
}
