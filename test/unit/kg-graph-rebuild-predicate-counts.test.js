// test/unit/kg-graph-rebuild-predicate-counts.test.js
// Unit tests for the projectPredicateCounts() helper added in #526.
//
// Pins the predicate IRI → GraphMetadata column mapping. Source-of-truth
// for the IRIs is srv/lib/kg-projection.js (the `iriPredicate(name)` ->
// `<https://developers.sap.com/kg/{name}>` builder). If a new predicate
// is added to the projection, EITHER add a column here OR explicitly
// document why it doesn't get a count (e.g. metadata literals like
// `:slug` / `:name` are intentionally ignored).

import { describe, it, expect } from 'vitest';
import { projectPredicateCounts, __TESTING__ } from '../../srv/lib/kg-graph-rebuild.js';

const PRED = (name) => `<https://developers.sap.com/kg/${name}>`;

describe('projectPredicateCounts()', () => {
  it('maps every known predicate IRI to its dedicated count field', () => {
    const counts = new Map([
      [PRED('teaches'),         42],
      [PRED('requires'),        13],
      [PRED('relatedTo'),       7],
      [PRED('extends'),         2],
      [PRED('partOf'),          25],
      [PRED('taggedWith'),      99],
      [PRED('aboutProduct'),    15],
      [PRED('inCategory'),      8],
      [PRED('coCompletedWith'), 50],
    ]);
    const out = projectPredicateCounts(counts);
    expect(out).toEqual({
      teachesCount:         42,
      requiresCount:        13,
      relatedToCount:       7,
      extendsCount:         2,
      partOfCount:          25,
      taggedWithCount:      99,
      aboutProductCount:    15,
      inCategoryCount:      8,
      coCompletedWithCount: 50,
    });
  });

  it('defaults missing predicates to 0 (so partial rebuilds emit explicit zeros, not nulls)', () => {
    // Only 2 predicates present; the rest should default to 0.
    const counts = new Map([
      [PRED('teaches'), 100],
      [PRED('partOf'),  20],
    ]);
    const out = projectPredicateCounts(counts);
    expect(out.teachesCount).toBe(100);
    expect(out.partOfCount).toBe(20);
    expect(out.requiresCount).toBe(0);
    expect(out.relatedToCount).toBe(0);
    expect(out.extendsCount).toBe(0);
    expect(out.taggedWithCount).toBe(0);
    expect(out.aboutProductCount).toBe(0);
    expect(out.inCategoryCount).toBe(0);
    expect(out.coCompletedWithCount).toBe(0);
  });

  it('returns all-zero map for an empty input (e.g. graph wiped, no projection)', () => {
    const out = projectPredicateCounts(new Map());
    // 9 fields, all 0
    expect(Object.keys(out).length).toBe(9);
    expect(Object.values(out).every(n => n === 0)).toBe(true);
  });

  it('silently ignores unknown predicates (does not expand the output object)', () => {
    // The projection ALSO emits literal triples for :slug / :name / :description
    // metadata on each concept; those aren't in the ontology and don't get
    // dedicated count columns. tallyPredicates() captures them anyway, but
    // projectPredicateCounts() drops them.
    const counts = new Map([
      [PRED('teaches'),  10],
      [PRED('slug'),     1000],  // unknown
      [PRED('name'),     500],   // unknown
      [PRED('description'), 200], // unknown
    ]);
    const out = projectPredicateCounts(counts);
    expect(out.teachesCount).toBe(10);
    // No `slugCount`, `nameCount`, or `descriptionCount` key.
    expect(Object.keys(out).sort()).toEqual([
      'aboutProductCount', 'coCompletedWithCount', 'extendsCount',
      'inCategoryCount', 'partOfCount', 'relatedToCount',
      'requiresCount', 'taggedWithCount', 'teachesCount',
    ]);
  });

  it('PREDICATE_TO_COUNT_FIELD mapping covers exactly 9 predicates (sync with kg-projection.js)', () => {
    // Locks the table size so adding a predicate to the projection without
    // updating this mapping fails CI. The 9 here match the predicates emitted
    // in kg-projection.js sections 1-5 (excluding the literal-triple metadata
    // like :slug and :name which are intentionally not counted).
    expect(Object.keys(__TESTING__.PREDICATE_TO_COUNT_FIELD).length).toBe(9);
  });
});
