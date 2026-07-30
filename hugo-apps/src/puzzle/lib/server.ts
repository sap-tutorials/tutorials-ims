// hugo-apps/src/puzzle/lib/server.ts
// Pure helpers and thin fetch wrappers for the Vue solver's server interactions.
// All fetch calls are isolated here so App.vue stays readable and tests cover the pure logic.
// CAP URL conventions used here:
//   actions  → POST   /api/puzzles/<ActionName>
//   functions→ GET    /api/puzzles/<FunctionName>(param='value')

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/**
 * Build the `entries` payload for POST /check from the current answers map.
 * Only includes FULLY-filled slots (all cells have a non-empty letter).
 *
 * @param slots   - all slots from buildSlots()
 * @param answers - "r,c" → letter map
 * @returns array of { slotId, word } for each fully-filled slot
 */
export function buildCheckEntries(
  slots: ReadonlyArray<{ id: string; cells: ReadonlyArray<{ r: number; c: number }> }>,
  answers: Readonly<Record<string, string>>
): Array<{ slotId: string; word: string }> {
  const entries: Array<{ slotId: string; word: string }> = [];
  for (const slot of slots) {
    const letters = slot.cells.map(c => answers[`${c.r},${c.c}`] ?? '');
    if (letters.every(l => l.length > 0)) {
      entries.push({ slotId: slot.id, word: letters.join('').toUpperCase() });
    }
  }
  return entries;
}

/**
 * Given check results, build a map from "r,c" cell key → 'correct'|'wrong'|undefined.
 *
 * @param results   - array of { slotId, correct } from the server
 * @param slots     - all slots (to resolve slotId → cells)
 * @returns         - cell-key → status map (only for cells in checked slots)
 */
export function buildCellStatus(
  results: ReadonlyArray<{ slotId: string; correct: boolean }>,
  slots: ReadonlyArray<{ id: string; cells: ReadonlyArray<{ r: number; c: number }> }>
): Record<string, 'correct' | 'wrong'> {
  const slotMap = new Map(slots.map(s => [s.id, s]));
  const out: Record<string, 'correct' | 'wrong'> = {};
  for (const { slotId, correct } of results) {
    const slot = slotMap.get(slotId);
    if (!slot) continue;
    const status = correct ? 'correct' : 'wrong';
    for (const cell of slot.cells) {
      out[`${cell.r},${cell.c}`] = status;
    }
  }
  return out;
}

// ── Auth probe ────────────────────────────────────────────────────────────────

export async function probeAuth(): Promise<boolean> {
  try {
    const r = await fetch('/auth/user', { credentials: 'include' });
    return r.ok;
  } catch {
    return false;
  }
}

// ── Server calls ─────────────────────────────────────────────────────────────

export interface CheckResult {
  results: Array<{ slotId: string; correct: boolean }>;
  complete: boolean;
}

export interface ProgressResult {
  filledGrid: string | null;
  attemptNumber: number;
}

export interface CompleteResult {
  recorded: boolean;
  alreadyComplete: boolean;
}

/**
 * POST /api/puzzles/check
 */
export async function postCheck(
  apiUrl: string,
  slug: string,
  entries: Array<{ slotId: string; word: string }>
): Promise<CheckResult> {
  const r = await fetch(`${apiUrl}/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ slug, entries }),
  });
  if (!r.ok) throw new Error(`check HTTP ${r.status}`);
  return r.json();
}

/**
 * GET /api/puzzles/getProgress(slug='<slug>')
 * CAP unbound functions use the form: GET /path/FunctionName(param='value')
 */
export async function fetchProgress(
  apiUrl: string,
  slug: string
): Promise<ProgressResult> {
  const url = `${apiUrl}/getProgress(slug='${encodeURIComponent(slug)}')`;
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`getProgress HTTP ${r.status}`);
  return r.json();
}

/**
 * POST /api/puzzles/saveProgress
 */
export async function postSaveProgress(
  apiUrl: string,
  slug: string,
  filledGrid: string
): Promise<void> {
  const r = await fetch(`${apiUrl}/saveProgress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ slug, filledGrid }),
  });
  if (!r.ok) throw new Error(`saveProgress HTTP ${r.status}`);
}

/**
 * POST /api/puzzles/complete
 */
export async function postComplete(
  apiUrl: string,
  slug: string
): Promise<CompleteResult> {
  const r = await fetch(`${apiUrl}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ slug }),
  });
  if (!r.ok) throw new Error(`complete HTTP ${r.status}`);
  return r.json();
}
