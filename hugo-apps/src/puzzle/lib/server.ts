// hugo-apps/src/puzzle/lib/server.ts
// Pure helpers and thin fetch wrappers for the Vue solver's server interactions.
// All fetch calls are isolated here so App.vue stays readable and tests cover the pure logic.
// CAP URL conventions used here:
//   actions  → POST   /puzzle-api/<ActionName>
//   functions→ GET    /puzzle-api/<FunctionName>(param='value')

import { csrfFetch } from '@shared/csrf-fetch';

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/**
 * Build the `entries` payload for POST /check from the current answers map.
 * Includes any slot with at least one filled cell. Blank cells are represented
 * as a space so the server's positional walk stays aligned — a space never
 * matches a solution letter, so blank positions grade wrong.
 *
 * @param slots   - all slots from buildSlots()
 * @param answers - "r,c" → letter map
 * @returns array of { slotId, word } for each slot with ≥1 filled cell
 */
export function buildCheckEntries(
  slots: ReadonlyArray<{ id: string; cells: ReadonlyArray<{ r: number; c: number }> }>,
  answers: Readonly<Record<string, string>>
): Array<{ slotId: string; word: string }> {
  const entries: Array<{ slotId: string; word: string }> = [];
  for (const slot of slots) {
    const word = slot.cells.map(c => (answers[`${c.r},${c.c}`] || ' ')).join('').toUpperCase();
    if (word.trim().length > 0) {
      entries.push({ slotId: slot.id, word });
    }
  }
  return entries;
}

/**
 * Given per-cell check results, build a map from "r,c" cell key → 'correct'|'wrong'.
 *
 * @param cells - array of { r, c, correct } from the server's check response
 * @returns     - cell-key → status map
 */
export function buildCellStatus(
  cells: ReadonlyArray<{ r: number; c: number; correct: boolean }>
): Record<string, 'correct' | 'wrong'> {
  const out: Record<string, 'correct' | 'wrong'> = {};
  for (const { r, c, correct } of cells) {
    out[`${r},${c}`] = correct ? 'correct' : 'wrong';
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
  cells: Array<{ r: number; c: number; correct: boolean }>;
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
 * POST /puzzle-api/check
 * Anonymous endpoint — no CSRF token needed.
 */
export async function postCheck(
  apiUrl: string,
  slug: string,
  entries: Array<{ slotId: string; word: string }>
): Promise<CheckResult> {
  const r = await fetch(`${apiUrl}/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, entries }),
  });
  if (!r.ok) throw new Error(`check HTTP ${r.status}`);
  return r.json();
}

/**
 * GET /puzzle-api/getProgress(slug='<slug>')
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
 * POST /puzzle-api/saveProgress
 */
export async function postSaveProgress(
  apiUrl: string,
  slug: string,
  filledGrid: string
): Promise<void> {
  const r = await csrfFetch(`${apiUrl}/saveProgress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ slug, filledGrid }),
  });
  if (!r.ok) throw new Error(`saveProgress HTTP ${r.status}`);
}

/**
 * POST /puzzle-api/complete
 */
export async function postComplete(
  apiUrl: string,
  slug: string
): Promise<CompleteResult> {
  const r = await csrfFetch(`${apiUrl}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ slug }),
  });
  if (!r.ok) throw new Error(`complete HTTP ${r.status}`);
  return r.json();
}
