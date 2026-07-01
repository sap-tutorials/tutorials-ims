// hugo-apps/src/concepts-filter/filter-logic.ts
//
// Pure, DOM-free filter logic for the concepts index. Extracted so the
// unit tests can drive it without a jsdom setup. Same shape as the
// navigator's buildFilter — takes a snapshot of cards, returns which
// slugs pass the current filter set.
//
// See issue #859.

export interface ConceptCard {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly firstLetter: string; // upper-case single char, or '#' for non-alpha
  readonly tutorialCount: number;
}

export interface FilterState {
  readonly query: string;         // free-text search (trimmed, ≥0 chars)
  readonly letter: string | null; // A-Z or '#' for non-alpha; null = no filter
  readonly sort: SortKey;
}

export type SortKey = 'name' | 'coverage';

export const DEFAULT_STATE: FilterState = Object.freeze({
  query: '',
  letter: null,
  sort: 'name',
});

/**
 * Return the ordered list of cards that match the current filter state.
 * Cards not in the returned list should be hidden by the caller.
 *
 * Contract:
 * - `query`: substring match (case-insensitive) over slug + name +
 *   description. Empty → no query filter.
 * - `letter`: strict equality on `firstLetter`. null → no letter filter.
 * - `sort`: 'name' (already the DOM order — stable A→Z) or 'coverage'
 *   (tutorialCount desc, tie-break by name asc).
 *
 * The input `cards` array is NOT mutated; a new array is returned.
 */
export function applyFilters(cards: readonly ConceptCard[], state: FilterState): ConceptCard[] {
  const q = state.query.trim().toLowerCase();
  const filtered = cards.filter((c) => {
    if (state.letter && c.firstLetter !== state.letter) return false;
    if (!q) return true;
    // Substring across the three text fields. Cheap at 1,635 cards; if
    // the corpus grows to 10k+, switch to fuse.js or a precomputed
    // trigram index — no schema change needed.
    if (c.name.toLowerCase().includes(q)) return true;
    if (c.slug.toLowerCase().includes(q)) return true;
    if (c.description.toLowerCase().includes(q)) return true;
    return false;
  });
  return sortCards(filtered, state.sort);
}

function sortCards(cards: ConceptCard[], sort: SortKey): ConceptCard[] {
  if (sort === 'coverage') {
    return [...cards].sort((a, b) => {
      if (b.tutorialCount !== a.tutorialCount) return b.tutorialCount - a.tutorialCount;
      return a.name.localeCompare(b.name);
    });
  }
  // Default 'name' — Hugo already emits cards ByTitle, so a stable sort
  // over the pre-ordered list keeps that order and makes the function
  // deterministic when the caller ran a letter filter that leaves gaps.
  return [...cards].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Return the set of letters that have at least one card whose *only*
 * lookup criterion has been the letter itself. Used to disable A-Z
 * buttons that would produce zero results under the current query.
 *
 * We intentionally include the query but exclude the letter itself when
 * computing availability, so pressing 'B' when the query is "cap" but
 * no CAP concept starts with B disables the B button rather than the
 * user pressing it and seeing empty state.
 */
export function availableLetters(cards: readonly ConceptCard[], state: FilterState): Set<string> {
  const q = state.query.trim().toLowerCase();
  const set = new Set<string>();
  for (const c of cards) {
    if (q) {
      const matches =
        c.name.toLowerCase().includes(q) ||
        c.slug.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q);
      if (!matches) continue;
    }
    set.add(c.firstLetter);
  }
  return set;
}

/**
 * Serialize a filter state to a URL query string. Empty/default values
 * are omitted so the URL for the default state is clean (`?` alone).
 * Matches the navigator's URL-sync convention.
 */
export function toQueryString(state: FilterState): string {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set('q', state.query.trim());
  if (state.letter) params.set('letter', state.letter);
  if (state.sort !== DEFAULT_STATE.sort) params.set('sort', state.sort);
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Parse a URL query string (or a URLSearchParams-compatible instance)
 * back to a FilterState. Unknown or malformed values fall back to
 * DEFAULT_STATE so we never throw on a hand-typed URL.
 */
export function fromQueryString(search: string | URLSearchParams): FilterState {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const query = params.get('q') ?? '';
  const letterRaw = params.get('letter');
  // Only accept a single upper-case letter or '#'. Anything else -> null.
  const letter = letterRaw && /^[A-Z#]$/.test(letterRaw) ? letterRaw : null;
  const sortRaw = params.get('sort');
  const sort: SortKey = sortRaw === 'coverage' ? 'coverage' : 'name';
  return { query, letter, sort };
}
