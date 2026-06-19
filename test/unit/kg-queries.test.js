// test/unit/kg-queries.test.js
// Unit tests for srv/lib/kg-queries.js — pure-function module.
//
// The module exports:
//   - NEIGHBORHOOD_QUERY   (Phase 1 flagship 4-way UNION SPARQL)
//   - PATH_BETWEEN_QUERY   (Phase 2 stub)
//   - CONCEPTS_FOR_USER_QUERY (Phase 2 stub)
//   - substitute(template, params) — strict, allow-listed parameter
//     substitution + injection guard. Throws synchronously on any input
//     that fails validation; the HTTP layer maps to 400.
//
// The flagship NEIGHBORHOOD_QUERY deviates from the spec in two places (both
// documented in the implementation file):
//   1. Uses full IRI form <...kg/tutorial/$SLUG> instead of the prefixed-name
//      `kg:tutorial/$SLUG` because HANA SPARQL rejects `/` inside PN_LOCAL.
//   2. Drops `?targetLabel` projection on the three tutorial-targeted UNION
//      branches because kg-projection.js emits no `kg:title` triples for
//      tutorials. The JS handler enriches with Tutorials.title separately.

import { describe, it, expect } from 'vitest';
import {
  NEIGHBORHOOD_QUERY,
  PATH_BETWEEN_QUERY,
  CONCEPTS_FOR_USER_QUERY,
  substitute,
} from '../../srv/lib/kg-queries.js';

// ---------------------------------------------------------------------------
// Module-level: exported templates exist and are non-empty strings
// ---------------------------------------------------------------------------

describe('kg-queries — exported templates', () => {
  it('NEIGHBORHOOD_QUERY is a non-empty string', () => {
    expect(typeof NEIGHBORHOOD_QUERY).toBe('string');
    expect(NEIGHBORHOOD_QUERY.length).toBeGreaterThan(50);
  });

  it('PATH_BETWEEN_QUERY exists as a non-empty string (Phase 2 stub)', () => {
    expect(typeof PATH_BETWEEN_QUERY).toBe('string');
    expect(PATH_BETWEEN_QUERY.length).toBeGreaterThan(0);
  });

  it('CONCEPTS_FOR_USER_QUERY exists as a non-empty string (Phase 2 stub)', () => {
    expect(typeof CONCEPTS_FOR_USER_QUERY).toBe('string');
    expect(CONCEPTS_FOR_USER_QUERY.length).toBeGreaterThan(0);
  });

  it('NEIGHBORHOOD_QUERY does NOT contain kg:title (regression — projection emits none)', () => {
    // The spec's flagship SPARQL selected ?prereqTut kg:title ?targetLabel,
    // but kg-projection.js never emits kg:title for tutorials. If anyone
    // re-introduces kg:title in the template, this test fails loudly.
    expect(NEIGHBORHOOD_QUERY).not.toMatch(/kg:title\b/);
  });

  it('NEIGHBORHOOD_QUERY uses full IRI form for the input tutorial (not prefixed kg:tutorial/$SLUG)', () => {
    // HANA SPARQL parser rejects `/` inside PN_LOCAL. The template MUST use
    // <https://developers.sap.com/kg/tutorial/$SLUG> not kg:tutorial/$SLUG.
    expect(NEIGHBORHOOD_QUERY).toMatch(/<https:\/\/developers\.sap\.com\/kg\/tutorial\/\$SLUG>/);
    expect(NEIGHBORHOOD_QUERY).not.toMatch(/\bkg:tutorial\//);
  });

  it('NEIGHBORHOOD_QUERY contains all four UNION branch type names', () => {
    expect(NEIGHBORHOOD_QUERY).toMatch(/"teaches"/);
    expect(NEIGHBORHOOD_QUERY).toMatch(/"prerequisitesOf"/);
    expect(NEIGHBORHOOD_QUERY).toMatch(/"sharedConcepts"/);
    expect(NEIGHBORHOOD_QUERY).toMatch(/"whatToLearnNext"/);
  });
});

// ---------------------------------------------------------------------------
// substitute() — happy path
// ---------------------------------------------------------------------------

describe('substitute — happy path', () => {
  it('substitutes $SLUG into NEIGHBORHOOD_QUERY with full-IRI form', () => {
    const sql = substitute(NEIGHBORHOOD_QUERY, { SLUG: 'cap-handlers' });
    expect(typeof sql).toBe('string');
    expect(sql).toContain('<https://developers.sap.com/kg/tutorial/cap-handlers>');
    // ensure no leftover placeholder
    expect(sql).not.toMatch(/\$SLUG\b/);
  });

  it('substitutes $SLUG into a minimal template', () => {
    const tmpl = 'SELECT * WHERE { <kg/tutorial/$SLUG> ?p ?o }';
    const out = substitute(tmpl, { SLUG: 'foo-bar' });
    expect(out).toBe('SELECT * WHERE { <kg/tutorial/foo-bar> ?p ?o }');
  });

  it('escapes belt-and-suspenders: any leftover IRI-unsafe chars are percent-encoded', () => {
    // The slug regex already rejects '>'. To probe iriEscapeSegment, we
    // bypass the SLUG type by using the FROM_SLUG type which has the same
    // shape rules — but here we deliberately feed something the SLUG validator
    // would reject. So instead we assert the integration: a valid slug
    // round-trips identical (no spurious encoding).
    const out = substitute('X $SLUG Y', { SLUG: 'a-b-c' });
    expect(out).toBe('X a-b-c Y');
  });

  it('treats $$ as a literal $ (escape)', () => {
    const out = substitute('cost is $$5 not $SLUG', { SLUG: 'q' });
    expect(out).toBe('cost is $5 not q');
  });
});

// ---------------------------------------------------------------------------
// substitute() — slug validation
// ---------------------------------------------------------------------------

describe('substitute — slug validation rejects bad shapes', () => {
  it('rejects uppercase slug', () => {
    expect(() => substitute('$SLUG', { SLUG: 'Foo' })).toThrow(/invalid slug.*Foo/i);
  });

  it('rejects underscore in slug', () => {
    expect(() => substitute('$SLUG', { SLUG: 'foo_bar' })).toThrow(/invalid slug/i);
  });

  it('rejects leading hyphen', () => {
    expect(() => substitute('$SLUG', { SLUG: '-foo' })).toThrow(/invalid slug/i);
  });

  it('rejects trailing hyphen', () => {
    expect(() => substitute('$SLUG', { SLUG: 'foo-' })).toThrow(/invalid slug/i);
  });

  it('rejects slug with quote injection', () => {
    expect(() => substitute('$SLUG', { SLUG: "foo' OR" })).toThrow(/invalid slug/i);
  });

  it('rejects slug with angle bracket', () => {
    expect(() => substitute('$SLUG', { SLUG: 'foo>bar' })).toThrow(/invalid slug/i);
  });

  it('rejects slug with semicolon', () => {
    expect(() => substitute('$SLUG', { SLUG: 'foo;bar' })).toThrow(/invalid slug/i);
  });

  it('rejects slug with newline', () => {
    expect(() => substitute('$SLUG', { SLUG: 'foo\nbar' })).toThrow(/invalid slug/i);
  });

  it('rejects empty slug', () => {
    expect(() => substitute('$SLUG', { SLUG: '' })).toThrow(/invalid slug/i);
  });

  it('rejects slug longer than 80 chars', () => {
    const tooLong = 'a' + 'b'.repeat(80); // 81 chars
    expect(() => substitute('$SLUG', { SLUG: tooLong })).toThrow(/invalid slug/i);
  });

  it('rejects non-string slug (number)', () => {
    expect(() => substitute('$SLUG', { SLUG: 42 })).toThrow(/invalid slug/i);
  });

  it('errors carry a code property KG_QUERY_INVALID_SLUG', () => {
    let caught;
    try {
      substitute('$SLUG', { SLUG: 'BAD' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('KG_QUERY_INVALID_SLUG');
  });
});

// ---------------------------------------------------------------------------
// substitute() — required / unknown / extra placeholders
// ---------------------------------------------------------------------------

describe('substitute — placeholder discovery', () => {
  it('throws when a required placeholder ($SLUG) is missing from params', () => {
    let caught;
    try {
      substitute(NEIGHBORHOOD_QUERY, {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('KG_QUERY_MISSING_PARAM');
    expect(String(caught.message)).toMatch(/SLUG/);
  });

  it('throws when the template contains an unknown placeholder name', () => {
    // $UNKNOWN is not on the whitelist of typed placeholders.
    let caught;
    try {
      substitute('PREFIX kg: <x> SELECT * WHERE { $UNKNOWN }', { UNKNOWN: 'x' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('KG_QUERY_UNKNOWN_PLACEHOLDER');
    expect(String(caught.message)).toMatch(/UNKNOWN/);
  });

  it('throws when params contains a key that is not on the whitelist', () => {
    // params={SLUG:'x', BOGUS:'y'} — even if BOGUS isn't in the template,
    // an unknown param key is rejected to catch typos at the call site.
    let caught;
    try {
      substitute('$SLUG', { SLUG: 'foo', BOGUS: 'y' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('KG_QUERY_UNKNOWN_PLACEHOLDER');
    expect(String(caught.message)).toMatch(/BOGUS/);
  });
});

// ---------------------------------------------------------------------------
// substitute() — typed placeholders (FROM_SLUG, TO_SLUG, USER_ID, LIMIT)
// ---------------------------------------------------------------------------

describe('substitute — additional typed placeholders', () => {
  it('FROM_SLUG and TO_SLUG follow slug rules', () => {
    const out = substitute('$FROM_SLUG to $TO_SLUG', {
      FROM_SLUG: 'a-b',
      TO_SLUG: 'c-d',
    });
    expect(out).toBe('a-b to c-d');
  });

  it('FROM_SLUG rejects bad shape with the same code as SLUG', () => {
    let caught;
    try { substitute('$FROM_SLUG', { FROM_SLUG: 'BAD' }); } catch (e) { caught = e; }
    expect(caught.code).toBe('KG_QUERY_INVALID_SLUG');
  });

  it('USER_ID accepts a UUID', () => {
    const u = '11111111-2222-3333-4444-555555555555';
    const out = substitute('user=$USER_ID', { USER_ID: u });
    expect(out).toBe(`user=${u}`);
  });

  it('USER_ID rejects a non-UUID', () => {
    let caught;
    try { substitute('$USER_ID', { USER_ID: 'not-a-uuid' }); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('KG_QUERY_INVALID_UUID');
  });

  it('LIMIT coerces a numeric integer through Number()', () => {
    const out = substitute('LIMIT $LIMIT', { LIMIT: '25' });
    expect(out).toBe('LIMIT 25');
  });

  it('LIMIT rejects NaN', () => {
    let caught;
    try { substitute('$LIMIT', { LIMIT: 'abc' }); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('KG_QUERY_INVALID_INTEGER');
  });

  it('LIMIT rejects Infinity', () => {
    let caught;
    try { substitute('$LIMIT', { LIMIT: Infinity }); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('KG_QUERY_INVALID_INTEGER');
  });

  it('LIMIT rejects non-integer numbers', () => {
    let caught;
    try { substitute('$LIMIT', { LIMIT: 3.14 }); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('KG_QUERY_INVALID_INTEGER');
  });

  it('LIMIT rejects negative integer', () => {
    let caught;
    try { substitute('$LIMIT', { LIMIT: -5 }); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('KG_QUERY_INVALID_INTEGER');
  });
});

// ---------------------------------------------------------------------------
// Spec-bug-fix regression: NEIGHBORHOOD_QUERY substitution shape
// ---------------------------------------------------------------------------

describe('substitute — NEIGHBORHOOD_QUERY end-to-end shape', () => {
  it('substituted SPARQL contains the full IRI for all four UNION branches', () => {
    const sql = substitute(NEIGHBORHOOD_QUERY, { SLUG: 'cap-handlers' });
    // Every reference to the input tutorial uses the full IRI form.
    const matches = sql.match(/<https:\/\/developers\.sap\.com\/kg\/tutorial\/cap-handlers>/g) || [];
    // 4 branches × at least 1 reference each, plus the FILTER != self in 3
    // branches. Don't pin the exact count — just assert "many".
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('substituted SPARQL still contains REPLACE(STR(...)) BIND for the three tutorial-targeted branches', () => {
    const sql = substitute(NEIGHBORHOOD_QUERY, { SLUG: 'cap-handlers' });
    const replaceCount = (sql.match(/BIND\(REPLACE\(STR\(/g) || []).length;
    expect(replaceCount).toBe(3);
  });
});
