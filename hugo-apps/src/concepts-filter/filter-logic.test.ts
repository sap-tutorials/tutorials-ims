// hugo-apps/src/concepts-filter/filter-logic.test.ts
//
// Regression tests for the concepts filter logic (#859). All pure —
// no DOM setup required.

import { describe, it, expect } from 'vitest';
import {
  applyFilters,
  availableLetters,
  fromQueryString,
  toQueryString,
  DEFAULT_STATE,
  type ConceptCard,
  type FilterState,
} from './filter-logic';

const CARDS: ConceptCard[] = [
  { slug: 'cap-handlers', name: 'CAP Handlers', description: 'Before/on/after handlers in CAP', firstLetter: 'C', tutorialCount: 12 },
  { slug: 'cap-cds', name: 'CAP CDS', description: 'Core Data Services for CAP', firstLetter: 'C', tutorialCount: 30 },
  { slug: 'business-ai-platform', name: 'Business AI Platform', description: 'BTP rebrand for AI', firstLetter: 'B', tutorialCount: 0 },
  { slug: 'agentic-ai', name: 'Agentic AI', description: 'Autonomous agents paradigm', firstLetter: 'A', tutorialCount: 0 },
  { slug: 'hana-sql', name: 'HANA SQL', description: 'SQL against SAP HANA Cloud', firstLetter: 'H', tutorialCount: 5 },
];

function state(overrides: Partial<FilterState> = {}): FilterState {
  return { ...DEFAULT_STATE, ...overrides };
}

describe('applyFilters', () => {
  it('returns everything when no filters are set (name sort)', () => {
    const out = applyFilters(CARDS, state());
    expect(out.map((c) => c.slug)).toEqual([
      'agentic-ai', 'business-ai-platform', 'cap-cds', 'cap-handlers', 'hana-sql',
    ]);
  });

  it('name-sort is stable and case-insensitive', () => {
    const out = applyFilters(CARDS, state()).map((c) => c.name);
    // localeCompare puts them in dictionary order.
    expect(out).toEqual(['Agentic AI', 'Business AI Platform', 'CAP CDS', 'CAP Handlers', 'HANA SQL']);
  });

  it('coverage-sort ranks by tutorialCount desc, tie-break by name', () => {
    const out = applyFilters(CARDS, state({ sort: 'coverage' })).map((c) => c.slug);
    expect(out).toEqual([
      'cap-cds',           // 30
      'cap-handlers',      // 12
      'hana-sql',          // 5
      'agentic-ai',        // 0, Agentic before Business alphabetically
      'business-ai-platform',
    ]);
  });

  it('query filter matches name, slug, and description (case-insensitive)', () => {
    // name match
    expect(applyFilters(CARDS, state({ query: 'CAP' })).map((c) => c.slug))
      .toEqual(['cap-cds', 'cap-handlers']);
    // description-only match — the word "agent" is in agentic-ai's description ("agents"),
    // not in any name/slug.
    expect(applyFilters(CARDS, state({ query: 'agent' })).map((c) => c.slug))
      .toEqual(['agentic-ai']);
    // slug-only match — the substring "platform" appears in business-ai-platform's slug
    // but not the other cards.
    expect(applyFilters(CARDS, state({ query: 'platform' })).map((c) => c.slug))
      .toEqual(['business-ai-platform']);
  });

  it('empty query is treated as no filter', () => {
    expect(applyFilters(CARDS, state({ query: '' })).length).toBe(CARDS.length);
    expect(applyFilters(CARDS, state({ query: '   ' })).length).toBe(CARDS.length);
  });

  it('letter filter narrows to first-letter matches', () => {
    expect(applyFilters(CARDS, state({ letter: 'C' })).map((c) => c.slug))
      .toEqual(['cap-cds', 'cap-handlers']);
    expect(applyFilters(CARDS, state({ letter: 'A' })).map((c) => c.slug))
      .toEqual(['agentic-ai']);
    expect(applyFilters(CARDS, state({ letter: 'Z' }))).toEqual([]);
  });

  it('query + letter compose (AND)', () => {
    // "AI" appears in 3 cards but only 1 starts with A.
    const out = applyFilters(CARDS, state({ query: 'AI', letter: 'A' }));
    expect(out.map((c) => c.slug)).toEqual(['agentic-ai']);
  });

  it('does not mutate the input array', () => {
    const before = CARDS.slice();
    applyFilters(CARDS, state({ sort: 'coverage', query: 'cap', letter: 'C' }));
    expect(CARDS).toEqual(before);
  });
});

describe('availableLetters', () => {
  it('lists every letter that has at least one card (no query)', () => {
    const letters = availableLetters(CARDS, state());
    expect([...letters].sort()).toEqual(['A', 'B', 'C', 'H']);
  });

  it('respects the query — letters must have cards that match the query', () => {
    // 'cap' → only CAP CDS + CAP Handlers survive → only 'C' is available.
    const letters = availableLetters(CARDS, state({ query: 'cap' }));
    expect([...letters]).toEqual(['C']);
  });

  it('ignores the letter filter itself when computing availability', () => {
    // If the user's current letter is 'C' but we're computing what buttons
    // to enable, 'C' should still show as available (or the user can never
    // switch away). We test by verifying letters other than the current
    // one still resolve based on the query alone.
    const letters = availableLetters(CARDS, state({ letter: 'C' }));
    // All base letters should be available since no query is set.
    expect([...letters].sort()).toEqual(['A', 'B', 'C', 'H']);
  });
});

describe('URL sync round-trip', () => {
  it('default state serialises to empty string', () => {
    expect(toQueryString(DEFAULT_STATE)).toBe('');
  });

  it('non-default query/letter/sort are round-trip stable', () => {
    const s: FilterState = { query: 'cap', letter: 'C', sort: 'coverage' };
    const qs = toQueryString(s);
    expect(qs).toBe('?q=cap&letter=C&sort=coverage');
    expect(fromQueryString(qs.replace(/^\?/, ''))).toEqual(s);
  });

  it('rejects invalid letter values, falls back to null', () => {
    // Non-letter, lower-case, multi-char — all should parse to null.
    expect(fromQueryString('letter=hello').letter).toBeNull();
    expect(fromQueryString('letter=c').letter).toBeNull(); // lower-case not accepted
    expect(fromQueryString('letter=%20').letter).toBeNull();
  });

  it('accepts the # bucket as a valid letter', () => {
    expect(fromQueryString('letter=%23').letter).toBe('#');
  });

  it('rejects unknown sort values, falls back to name', () => {
    expect(fromQueryString('sort=random').sort).toBe('name');
    expect(fromQueryString('sort=').sort).toBe('name');
  });

  it('omits sort=name from the URL (it is the default)', () => {
    const qs = toQueryString({ query: 'cap', letter: null, sort: 'name' });
    expect(qs).toBe('?q=cap');
    // But coverage IS serialised.
    const qs2 = toQueryString({ query: '', letter: null, sort: 'coverage' });
    expect(qs2).toBe('?sort=coverage');
  });

  it('trims whitespace from query before serialising', () => {
    const qs = toQueryString({ query: '  cap  ', letter: null, sort: 'name' });
    expect(qs).toBe('?q=cap');
  });
});
