// test/unit/kg-result-parser.test.js
// Unit tests for parseNeighborhoodSparqlResponse — the helper that converts
// the SPARQL JSON response (as emitted by SYS.SPARQL_EXECUTE for the 4-way
// UNION NEIGHBORHOOD_QUERY) into the row shape that rankNeighborhood
// consumes.
//
// The function lives in srv/knowledge-graph-service.js (rather than
// kg-queries.js) because the response shape is co-located with the handler
// that builds it. SPARQL emits unbound projection vars as missing keys in
// the binding object — the parser coerces those to null so the ranker can
// branch on `=== null`.

import { describe, expect, it } from 'vitest';
import { parseNeighborhoodSparqlResponse } from '../../srv/knowledge-graph-service.js';

describe('parseNeighborhoodSparqlResponse', () => {
  it('returns [] for an empty bindings array', () => {
    const json = JSON.stringify({
      head: { vars: ['type', 'targetSlug', 'targetLabel', 'weight'] },
      results: { bindings: [] },
    });
    expect(parseNeighborhoodSparqlResponse(json, 'cap-getting-started')).toEqual([]);
  });

  it('extracts all four fields when every var is bound (teaches branch)', () => {
    const json = JSON.stringify({
      head: { vars: ['type', 'targetSlug', 'targetLabel', 'weight'] },
      results: {
        bindings: [
          {
            type:        { type: 'literal', value: 'teaches' },
            targetSlug:  { type: 'literal', value: 'cap-handlers' },
            targetLabel: { type: 'literal', value: 'CAP Service Handlers' },
            weight:      { type: 'literal', datatype: 'http://www.w3.org/2001/XMLSchema#decimal', value: '1.0' },
          },
        ],
      },
    });
    const rows = parseNeighborhoodSparqlResponse(json, 'cap-getting-started');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      type:        'teaches',
      targetSlug:  'cap-handlers',
      targetLabel: 'CAP Service Handlers',
      weight:      1.0,
    });
  });

  it('emits null targetLabel when the binding lacks ?targetLabel (sharedConcepts branch)', () => {
    const json = JSON.stringify({
      head: { vars: ['type', 'targetSlug', 'targetLabel', 'weight'] },
      results: {
        bindings: [
          {
            type:       { type: 'literal', value: 'sharedConcepts' },
            targetSlug: { type: 'literal', value: 'build-cap-on-hana' },
            // no targetLabel, no weight
          },
        ],
      },
    });
    const rows = parseNeighborhoodSparqlResponse(json, 'cap-getting-started');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      type:        'sharedConcepts',
      targetSlug:  'build-cap-on-hana',
      targetLabel: null,
      weight:      null,
    });
  });

  it('emits null weight when the binding lacks ?weight (whatToLearnNext branch)', () => {
    const json = JSON.stringify({
      head: { vars: ['type', 'targetSlug', 'targetLabel', 'weight'] },
      results: {
        bindings: [
          {
            type:       { type: 'literal', value: 'whatToLearnNext' },
            targetSlug: { type: 'literal', value: 'cap-advanced' },
          },
        ],
      },
    });
    const [row] = parseNeighborhoodSparqlResponse(json, 'cap-getting-started');
    expect(row.weight).toBeNull();
    expect(row.targetLabel).toBeNull();
    expect(row.targetSlug).toBe('cap-advanced');
  });

  it('throws SyntaxError on malformed JSON', () => {
    expect(() =>
      parseNeighborhoodSparqlResponse('this is not json', 'cap-getting-started'),
    ).toThrow(SyntaxError);
  });

  it('returns [] when results.bindings is missing or non-array', () => {
    expect(parseNeighborhoodSparqlResponse(JSON.stringify({}), 'x')).toEqual([]);
    expect(parseNeighborhoodSparqlResponse(JSON.stringify({ results: {} }), 'x')).toEqual([]);
    expect(
      parseNeighborhoodSparqlResponse(JSON.stringify({ results: { bindings: 'oops' } }), 'x'),
    ).toEqual([]);
  });

  it('coerces numeric weight strings via Number() — preserves 0.9, 1.0, 0.5', () => {
    const json = JSON.stringify({
      head: { vars: ['type', 'targetSlug', 'targetLabel', 'weight'] },
      results: {
        bindings: [
          {
            type:       { value: 'prerequisitesOf' },
            targetSlug: { value: 'cap-prereq' },
            weight:     { value: '0.9' },
          },
          {
            type:       { value: 'teaches' },
            targetSlug: { value: 'cap-c' },
            weight:     { value: '1.0' },
          },
        ],
      },
    });
    const rows = parseNeighborhoodSparqlResponse(json, 'x');
    expect(rows[0].weight).toBe(0.9);
    expect(rows[1].weight).toBe(1.0);
  });
});
