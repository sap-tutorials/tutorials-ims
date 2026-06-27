// test/unit/srv/kg-projection-k-anonymity.test.js
//
// Unit tests for the k-anonymity floor applied to the `coCompletedWith`
// projection. Per spec §2.3 (docs/superpowers/specs/2026-06-27-446-...):
//   - Drop edges with raw count < 10 (the K floor).
//   - The binary predicate carries no count literal, so the gate alone
//     is the protection — raw counts never reach the RDF graph.
//
// Helper under test: buildCoCompletionTriples(rows). Extracted from the
// inlined emission in projectFromFixtures so it can be unit-tested in
// isolation without spinning up the full fixture machinery.

import { describe, it, expect } from 'vitest';
import { buildCoCompletionTriples } from '../../../srv/lib/kg-projection.js';

describe('coCompletedWith k-anonymity', () => {
  it('drops edges with raw count < 10 and keeps the boundary at 10', () => {
    const rows = [
      { sourceSlug: 'a', targetSlug: 'b', count: 15 }, // kept
      { sourceSlug: 'a', targetSlug: 'c', count: 23 }, // kept
      { sourceSlug: 'a', targetSlug: 'd', count: 9 },  // dropped (below K)
    ];
    const triples = buildCoCompletionTriples(rows);
    // Two surviving edges → two triples (binary predicate, no count emitted).
    expect(triples).toHaveLength(2);
  });

  it('drops edges with raw count < 10', () => {
    const rows = [
      { sourceSlug: 'a', targetSlug: 'b', count: 1 },
      { sourceSlug: 'a', targetSlug: 'c', count: 9 },
      { sourceSlug: 'a', targetSlug: 'd', count: 10 }, // boundary — kept
    ];
    const triples = buildCoCompletionTriples(rows);
    expect(triples).toHaveLength(1);
  });

  it('emits zero triples for empty input', () => {
    expect(buildCoCompletionTriples([])).toHaveLength(0);
  });

  it('emits N-Triples in the canonical Tutorial → coCompletedWith → Tutorial shape', () => {
    const rows = [
      { sourceSlug: 'cap-handlers', targetSlug: 'cap-quickstart', count: 12 },
    ];
    const triples = buildCoCompletionTriples(rows);
    expect(triples).toEqual([
      '<https://developers.sap.com/kg/tutorial/cap-handlers> ' +
      '<https://developers.sap.com/kg/coCompletedWith> ' +
      '<https://developers.sap.com/kg/tutorial/cap-quickstart> .',
    ]);
  });
});
