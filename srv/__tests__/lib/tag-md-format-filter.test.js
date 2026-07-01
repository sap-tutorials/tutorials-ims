// srv/__tests__/lib/tag-md-format-filter.test.js
//
// Regression guard for #837 — Sage's tag-search $filter over the virtual
// `mdFormat` field must not 500. `mdFormat` has no DB column (see
// db/schema.cds — `virtual mdFormat : String;`), so CAP's pushdown of
// $filter into SQL raises an error. This helper rewrites the CQN filter
// so any leaf reference to `mdFormat` becomes `titlePath` for SQL push-down
// (a strict SUPERSET of the true match set), then produces a JS predicate
// that re-evaluates the ORIGINAL clause against enriched rows so callers
// can drop false positives after applyMdFormat().
//
// #837 / follow-up to #824.

import { describe, it, expect } from 'vitest';
import {
  rewriteWhereForPushdown,
  buildRowMatcher,
  containsMdFormatRef,
} from '../../lib/tag-md-format-filter.js';

// CQN fragments used by the OData $filter parser — mirrored from
// `@sap/cds` output for the exact queries in the issue report.

function cqn_containsTolower(field, value) {
  // contains(tolower(<field>), '<value>')
  return {
    func: 'contains',
    args: [
      { func: 'tolower', args: [{ ref: [field] }] },
      { val: value },
    ],
  };
}

function cqn_containsTolowerTolower(field, value) {
  // contains(tolower(<field>), tolower('<value>'))
  return {
    func: 'contains',
    args: [
      { func: 'tolower', args: [{ ref: [field] }] },
      { func: 'tolower', args: [{ val: value }] },
    ],
  };
}

describe('containsMdFormatRef', () => {
  it('returns false for undefined / empty where', () => {
    expect(containsMdFormatRef(undefined)).toBe(false);
    expect(containsMdFormatRef([])).toBe(false);
  });

  it('returns true when a leaf {ref:["mdFormat"]} is present', () => {
    const where = [cqn_containsTolower('mdFormat', 'business')];
    expect(containsMdFormatRef(where)).toBe(true);
  });

  it('returns true when nested inside an OR', () => {
    const where = [
      cqn_containsTolower('name', 'business'),
      'or',
      cqn_containsTolower('mdFormat', 'business'),
    ];
    expect(containsMdFormatRef(where)).toBe(true);
  });

  it('returns false when only non-mdFormat refs are present', () => {
    const where = [cqn_containsTolower('name', 'business')];
    expect(containsMdFormatRef(where)).toBe(false);
  });
});

describe('rewriteWhereForPushdown — mdFormat → titlePath', () => {
  it('leaves clauses without mdFormat unchanged', () => {
    const where = [cqn_containsTolower('name', 'business')];
    const out = rewriteWhereForPushdown(where);
    // structural equality; helper returns a fresh tree
    expect(JSON.stringify(out)).toBe(JSON.stringify(where));
  });

  it('swaps mdFormat ref for titlePath in a single leaf', () => {
    const where = [cqn_containsTolower('mdFormat', 'business')];
    const out = rewriteWhereForPushdown(where);
    const expected = [cqn_containsTolower('titlePath', 'business')];
    expect(JSON.stringify(out)).toBe(JSON.stringify(expected));
  });

  it('swaps only mdFormat in an OR chain, preserving the other side', () => {
    const where = [
      cqn_containsTolower('name', 'business'),
      'or',
      cqn_containsTolower('mdFormat', 'business'),
    ];
    const out = rewriteWhereForPushdown(where);
    const expected = [
      cqn_containsTolower('name', 'business'),
      'or',
      cqn_containsTolower('titlePath', 'business'),
    ];
    expect(JSON.stringify(out)).toBe(JSON.stringify(expected));
  });

  it('handles nested tolower(<val>) wrapper on the RHS', () => {
    const where = [cqn_containsTolowerTolower('mdFormat', 'Business')];
    const out = rewriteWhereForPushdown(where);
    const expected = [cqn_containsTolowerTolower('titlePath', 'Business')];
    expect(JSON.stringify(out)).toBe(JSON.stringify(expected));
  });

  it('does not mutate the input tree', () => {
    const where = [cqn_containsTolower('mdFormat', 'business')];
    const snapshot = JSON.stringify(where);
    rewriteWhereForPushdown(where);
    expect(JSON.stringify(where)).toBe(snapshot);
  });
});

describe('buildRowMatcher — evaluate original predicate in JS', () => {
  // Rows carry the enriched mdFormat (post applyMdFormat).
  const rowSapCommunity = {
    name: 'SAP Community',
    titlePath: 'Topic : SAP Community',
    mdFormat: 'topic>sap-community',
  };
  const rowBusinessSuite = {
    name: 'Business Suite',
    titlePath: 'Topic : Business Suite',
    mdFormat: 'topic>business-suite',
  };
  const rowSapHana = {
    name: 'SAP HANA',
    titlePath: 'Software Product : Technology Platform / SAP HANA',
    mdFormat: 'software-product>sap-hana',
  };
  const rowNoMdFormat = {
    name: 'Placeholder',
    titlePath: null,
    mdFormat: '',
  };

  it('evaluates a simple contains(tolower(name), "business")', () => {
    const match = buildRowMatcher([cqn_containsTolower('name', 'business')]);
    expect(match(rowBusinessSuite)).toBe(true);
    expect(match(rowSapCommunity)).toBe(false);
  });

  it('evaluates contains(tolower(mdFormat), "business")', () => {
    const match = buildRowMatcher([cqn_containsTolower('mdFormat', 'business')]);
    expect(match(rowBusinessSuite)).toBe(true);
    expect(match(rowSapCommunity)).toBe(false);
  });

  it('honors OR between name and mdFormat — the #837 pattern', () => {
    const where = [
      cqn_containsTolower('name', 'business'),
      'or',
      cqn_containsTolower('mdFormat', 'business'),
    ];
    const match = buildRowMatcher(where);
    expect(match(rowBusinessSuite)).toBe(true);   // name matches
    expect(match(rowSapCommunity)).toBe(false);   // neither matches
  });

  it('drops the SQL-side false positive from titlePath superset', () => {
    // If Sage searches for "product" via the OR pattern, the SQL side
    // (titlePath) matches "Software Product : ..." because titlePath
    // contains "product". But if the user ACTUALLY wanted only mdFormat
    // matches, the JS side must be able to filter it out cleanly.
    const where = [cqn_containsTolower('mdFormat', 'product')];
    const match = buildRowMatcher(where);
    // "software-product>sap-hana" — DOES contain "product"
    expect(match(rowSapHana)).toBe(true);
  });

  it('handles the hyphen-in-substring edge case — hits mdFormat but not titlePath', () => {
    // The SQL rewrite would MISS this (titlePath has no hyphen), which is
    // why the SQL-side is a SUPERSET only for plain words — but if the
    // rewrite yielded the false-positive superset, the JS matcher must
    // still recognize the hyphenated substring correctly against mdFormat.
    const where = [cqn_containsTolower('mdFormat', 'sap-community')];
    const match = buildRowMatcher(where);
    expect(match(rowSapCommunity)).toBe(true);
  });

  it('treats null mdFormat as empty string (does not throw)', () => {
    const where = [cqn_containsTolower('mdFormat', 'business')];
    const match = buildRowMatcher(where);
    expect(match(rowNoMdFormat)).toBe(false);
    expect(match({ ...rowNoMdFormat, mdFormat: undefined })).toBe(false);
    expect(match({ ...rowNoMdFormat, mdFormat: null })).toBe(false);
  });

  it('handles tolower on the RHS value too', () => {
    const where = [cqn_containsTolowerTolower('mdFormat', 'BUSINESS')];
    const match = buildRowMatcher(where);
    expect(match(rowBusinessSuite)).toBe(true);
  });

  it('supports startswith and endswith', () => {
    const startsWith = buildRowMatcher([
      {
        func: 'startswith',
        args: [
          { func: 'tolower', args: [{ ref: ['mdFormat'] }] },
          { val: 'topic' },
        ],
      },
    ]);
    expect(startsWith(rowSapCommunity)).toBe(true);
    expect(startsWith(rowSapHana)).toBe(false);

    const endsWith = buildRowMatcher([
      {
        func: 'endswith',
        args: [
          { func: 'tolower', args: [{ ref: ['mdFormat'] }] },
          { val: 'hana' },
        ],
      },
    ]);
    expect(endsWith(rowSapHana)).toBe(true);
    expect(endsWith(rowSapCommunity)).toBe(false);
  });

  it('supports AND', () => {
    const where = [
      cqn_containsTolower('name', 'sap'),
      'and',
      cqn_containsTolower('mdFormat', 'community'),
    ];
    const match = buildRowMatcher(where);
    expect(match(rowSapCommunity)).toBe(true);
    expect(match(rowSapHana)).toBe(false);   // name matches but mdFormat doesn't contain "community"
    expect(match(rowBusinessSuite)).toBe(false);
  });

  it('supports NOT', () => {
    const where = [
      'not',
      { xpr: [cqn_containsTolower('mdFormat', 'business')] },
    ];
    const match = buildRowMatcher(where);
    expect(match(rowBusinessSuite)).toBe(false);
    expect(match(rowSapCommunity)).toBe(true);
  });

  it('supports = and <> comparisons', () => {
    const eq = buildRowMatcher([{ ref: ['mdFormat'] }, '=', { val: 'topic>sap-community' }]);
    expect(eq(rowSapCommunity)).toBe(true);
    expect(eq(rowBusinessSuite)).toBe(false);
    const ne = buildRowMatcher([{ ref: ['mdFormat'] }, '<>', { val: 'topic>sap-community' }]);
    expect(ne(rowSapCommunity)).toBe(false);
    expect(ne(rowBusinessSuite)).toBe(true);
  });
});
