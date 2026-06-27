// test/unit/kg-sparql-client-validation.test.js
// Synchronous validator tests for the typed SPARQL procedure client.
// No DB connection needed — the stub db resolves immediately; validators
// throw before the db.run() call ever happens.
//
// Spec: docs/superpowers/specs/2026-06-22-kg-sparql-definer-procedures-design.md
// Issue: #533 (Task 6)

import { describe, it, expect } from 'vitest';
import {
  kgGraphClear,
  kgGraphInsert,
  kgQuery,
  kgAdminRunSparql,
  __TESTING__,
} from '../../srv/lib/kg-sparql-client.js';

// Stub db so validators run before the DB call ever happens.
const stubDb = { run: async () => [{ RESPONSE: '', HEADERS: '' }] };

// ---------------------------------------------------------------------------
// kgGraphClear
// ---------------------------------------------------------------------------

describe('kgGraphClear validation', () => {
  it('rejects non-string graphIri (null)', async () => {
    await expect(kgGraphClear({ db: stubDb, graphIri: null })).rejects.toThrow(TypeError);
  });

  it('rejects non-string graphIri (number)', async () => {
    await expect(kgGraphClear({ db: stubDb, graphIri: 123 })).rejects.toThrow(TypeError);
  });

  it('rejects non-string graphIri (undefined)', async () => {
    await expect(kgGraphClear({ db: stubDb, graphIri: undefined })).rejects.toThrow(TypeError);
  });

  it('rejects bad-shape IRI (no scheme)', async () => {
    await expect(kgGraphClear({ db: stubDb, graphIri: 'not-an-iri' })).rejects.toThrow(TypeError);
  });

  it('rejects bad-shape IRI (ftp scheme)', async () => {
    await expect(kgGraphClear({ db: stubDb, graphIri: 'ftp://example.com/g' })).rejects.toThrow(TypeError);
  });

  it('rejects bad-shape IRI (spaces)', async () => {
    await expect(kgGraphClear({ db: stubDb, graphIri: 'https://example.com/g g' })).rejects.toThrow(TypeError);
  });

  it('rejects empty string', async () => {
    await expect(kgGraphClear({ db: stubDb, graphIri: '' })).rejects.toThrow(RangeError);
  });

  it('rejects IRI > 500 chars', async () => {
    const long = 'urn:test:' + 'x'.repeat(495);
    expect(long.length).toBeGreaterThan(500);
    await expect(kgGraphClear({ db: stubDb, graphIri: long })).rejects.toThrow(RangeError);
  });

  it('accepts a valid http IRI', async () => {
    await expect(kgGraphClear({ db: stubDb, graphIri: 'http://example.com/g' })).resolves.toBeDefined();
  });

  it('accepts a valid https IRI', async () => {
    await expect(kgGraphClear({ db: stubDb, graphIri: 'https://example.com/g' })).resolves.toBeDefined();
  });

  it('accepts a valid urn IRI', async () => {
    await expect(kgGraphClear({ db: stubDb, graphIri: 'urn:test:abc' })).resolves.toBeDefined();
  });

  it('accepts the production graph IRI', async () => {
    await expect(kgGraphClear({ db: stubDb, graphIri: 'https://developers.sap.com/kg/tutorials-v2' })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// kgGraphInsert
// ---------------------------------------------------------------------------

describe('kgGraphInsert validation', () => {
  it('rejects empty triples', async () => {
    await expect(kgGraphInsert({ db: stubDb, graphIri: 'urn:test:a', triples: '' })).rejects.toThrow(RangeError);
  });

  it('rejects non-string triples (null)', async () => {
    await expect(kgGraphInsert({ db: stubDb, graphIri: 'urn:test:a', triples: null })).rejects.toThrow(TypeError);
  });

  it('rejects non-string triples (number)', async () => {
    await expect(kgGraphInsert({ db: stubDb, graphIri: 'urn:test:a', triples: 42 })).rejects.toThrow(TypeError);
  });

  it('rejects triples exceeding 16MB', async () => {
    const triples = 'x'.repeat(16 * 1024 * 1024 + 1);
    await expect(kgGraphInsert({ db: stubDb, graphIri: 'urn:test:a', triples })).rejects.toThrow(RangeError);
  });

  it('rejects invalid graphIri with valid triples', async () => {
    await expect(kgGraphInsert({ db: stubDb, graphIri: 'bad-iri', triples: '<a> <b> <c> .' })).rejects.toThrow(TypeError);
  });

  it('accepts valid graphIri and triples', async () => {
    await expect(kgGraphInsert({ db: stubDb, graphIri: 'urn:test:a', triples: '<a> <b> <c> .' })).resolves.toBeDefined();
  });

  it('accepts a non-empty triples string up to 16MB', async () => {
    const triples = 'x'.repeat(16 * 1024 * 1024);
    await expect(kgGraphInsert({ db: stubDb, graphIri: 'urn:test:a', triples })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// kgQuery
// ---------------------------------------------------------------------------

describe('kgQuery validation', () => {
  it('rejects unknown queryName', async () => {
    await expect(kgQuery({ db: stubDb, queryName: 'NOT_A_QUERY', params: {} })).rejects.toThrow(TypeError);
  });

  it('rejects non-string queryName', async () => {
    await expect(kgQuery({ db: stubDb, queryName: null, params: {} })).rejects.toThrow(TypeError);
  });

  it('rejects missing required keys for NEIGHBORHOOD', async () => {
    await expect(kgQuery({ db: stubDb, queryName: 'NEIGHBORHOOD', params: {} })).rejects.toThrow(/missing keys: slug/);
  });

  it('rejects unexpected keys for NEIGHBORHOOD', async () => {
    await expect(kgQuery({ db: stubDb, queryName: 'NEIGHBORHOOD', params: { slug: 'foo', extra: 'bar' } }))
      .rejects.toThrow(/unexpected keys: extra/);
  });

  it('rejects value > 500 chars for NEIGHBORHOOD slug', async () => {
    await expect(kgQuery({ db: stubDb, queryName: 'NEIGHBORHOOD', params: { slug: 'x'.repeat(501) } }))
      .rejects.toThrow(/1-500 chars/);
  });

  it('rejects empty string for NEIGHBORHOOD slug', async () => {
    await expect(kgQuery({ db: stubDb, queryName: 'NEIGHBORHOOD', params: { slug: '' } }))
      .rejects.toThrow(TypeError);
  });

  it('rejects non-string value for NEIGHBORHOOD slug', async () => {
    await expect(kgQuery({ db: stubDb, queryName: 'NEIGHBORHOOD', params: { slug: 42 } }))
      .rejects.toThrow(TypeError);
  });

  it('accepts valid NEIGHBORHOOD params', async () => {
    await expect(kgQuery({ db: stubDb, queryName: 'NEIGHBORHOOD', params: { slug: 'my-tutorial' } }))
      .resolves.toBeDefined();
  });

  it('rejects missing required keys for PATH_BETWEEN', async () => {
    await expect(kgQuery({ db: stubDb, queryName: 'PATH_BETWEEN', params: { fromSlug: 'a' } }))
      .rejects.toThrow(/missing keys: toSlug/);
  });

  it('accepts valid PATH_BETWEEN params', async () => {
    await expect(kgQuery({ db: stubDb, queryName: 'PATH_BETWEEN', params: { fromSlug: 'a', toSlug: 'b' } }))
      .resolves.toBeDefined();
  });

  it('accepts valid CONCEPTS_FOR_USER params', async () => {
    await expect(kgQuery({ db: stubDb, queryName: 'CONCEPTS_FOR_USER', params: { userId: 'user-123' } }))
      .resolves.toBeDefined();
  });

  it('accepts valid overrideGraphIri', async () => {
    await expect(kgQuery({
      db: stubDb,
      queryName: 'NEIGHBORHOOD',
      params: { slug: 'foo' },
      overrideGraphIri: 'urn:test:g',
    })).resolves.toBeDefined();
  });

  it('rejects bad overrideGraphIri shape', async () => {
    await expect(kgQuery({
      db: stubDb,
      queryName: 'NEIGHBORHOOD',
      params: { slug: 'foo' },
      overrideGraphIri: 'bad',
    })).rejects.toThrow(TypeError);
  });

  it('accepts null overrideGraphIri (no override)', async () => {
    await expect(kgQuery({
      db: stubDb,
      queryName: 'NEIGHBORHOOD',
      params: { slug: 'foo' },
      overrideGraphIri: null,
    })).resolves.toBeDefined();
  });

  it('accepts undefined overrideGraphIri (no override)', async () => {
    await expect(kgQuery({
      db: stubDb,
      queryName: 'NEIGHBORHOOD',
      params: { slug: 'foo' },
    })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// kgAdminRunSparql
// ---------------------------------------------------------------------------

describe('kgAdminRunSparql validation', () => {
  it('rejects empty sparql', async () => {
    await expect(kgAdminRunSparql({ db: stubDb, sparql: '', isUpdate: false })).rejects.toThrow(RangeError);
  });

  it('rejects non-string sparql (null)', async () => {
    await expect(kgAdminRunSparql({ db: stubDb, sparql: null, isUpdate: false })).rejects.toThrow(TypeError);
  });

  it('rejects non-bool isUpdate (string "yes")', async () => {
    await expect(kgAdminRunSparql({ db: stubDb, sparql: 'SELECT', isUpdate: 'yes' })).rejects.toThrow(TypeError);
  });

  it('rejects non-bool isUpdate (number 1)', async () => {
    await expect(kgAdminRunSparql({ db: stubDb, sparql: 'SELECT', isUpdate: 1 })).rejects.toThrow(TypeError);
  });

  it('rejects non-bool isUpdate (null)', async () => {
    await expect(kgAdminRunSparql({ db: stubDb, sparql: 'SELECT', isUpdate: null })).rejects.toThrow(TypeError);
  });

  it('accepts boolean false', async () => {
    await expect(kgAdminRunSparql({ db: stubDb, sparql: 'SELECT ?x WHERE {}', isUpdate: false })).resolves.toBeDefined();
  });

  it('accepts boolean true', async () => {
    await expect(kgAdminRunSparql({ db: stubDb, sparql: 'INSERT { ?x ?y ?z }', isUpdate: true })).resolves.toBeDefined();
  });

  it('rejects sparql exceeding 16MB', async () => {
    const sparql = 'x'.repeat(16 * 1024 * 1024 + 1);
    await expect(kgAdminRunSparql({ db: stubDb, sparql, isUpdate: false })).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// __TESTING__ exports
// ---------------------------------------------------------------------------

describe('__TESTING__ exports', () => {
  it('exports IRI_RE as a RegExp', () => {
    expect(__TESTING__.IRI_RE).toBeInstanceOf(RegExp);
  });

  it('IRI_RE matches http IRIs', () => {
    expect(__TESTING__.IRI_RE.test('http://example.com/g')).toBe(true);
    expect(__TESTING__.IRI_RE.test('https://developers.sap.com/kg/tutorials-v2')).toBe(true);
  });

  it('IRI_RE matches urn IRIs', () => {
    expect(__TESTING__.IRI_RE.test('urn:test:abc')).toBe(true);
  });

  it('IRI_RE rejects bad IRIs', () => {
    expect(__TESTING__.IRI_RE.test('not-an-iri')).toBe(false);
    expect(__TESTING__.IRI_RE.test('ftp://example.com')).toBe(false);
  });

  it('exports QUERY_PARAM_SHAPES as a frozen object', () => {
    expect(Object.isFrozen(__TESTING__.QUERY_PARAM_SHAPES)).toBe(true);
  });

  it('QUERY_PARAM_SHAPES has the four expected keys', () => {
    expect(Object.keys(__TESTING__.QUERY_PARAM_SHAPES)).toEqual(['NEIGHBORHOOD', 'PATH_BETWEEN', 'CONCEPTS_FOR_USER', 'EXPLORE_GRAPH_BULK']);
  });

  it('each QUERY_PARAM_SHAPES entry is frozen', () => {
    for (const shape of Object.values(__TESTING__.QUERY_PARAM_SHAPES)) {
      expect(Object.isFrozen(shape)).toBe(true);
    }
  });

  it('NEIGHBORHOOD shape requires slug', () => {
    expect(__TESTING__.QUERY_PARAM_SHAPES.NEIGHBORHOOD.required).toEqual(['slug']);
    expect(__TESTING__.QUERY_PARAM_SHAPES.NEIGHBORHOOD.order).toEqual(['slug']);
  });

  it('PATH_BETWEEN shape requires fromSlug and toSlug', () => {
    expect(__TESTING__.QUERY_PARAM_SHAPES.PATH_BETWEEN.required).toEqual(['fromSlug', 'toSlug']);
  });

  it('CONCEPTS_FOR_USER shape requires userId', () => {
    expect(__TESTING__.QUERY_PARAM_SHAPES.CONCEPTS_FOR_USER.required).toEqual(['userId']);
  });

  it('exports coerceRow as a function', () => {
    expect(typeof __TESTING__.coerceRow).toBe('function');
  });

  it('exports DEFAULT_TIMEOUT_MS as 30000', () => {
    expect(__TESTING__.DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it('does NOT export SPARQL_DO_BLOCK', () => {
    expect(__TESTING__.SPARQL_DO_BLOCK).toBeUndefined();
  });
});
