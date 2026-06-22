// test/unit/kg-sparql-client-dispatch.test.js
// Mocked-db.run dispatch tests for the typed SPARQL procedure client.
// Verifies that each typed function passes the correct arguments to db.run()
// with the right DO-block and positional arg array.
//
// Spec: docs/superpowers/specs/2026-06-22-kg-sparql-definer-procedures-design.md
// Issue: #533 (Task 6)

import { describe, it, expect, vi } from 'vitest';
import {
  kgGraphClear,
  kgGraphInsert,
  kgQuery,
  kgAdminRunSparql,
} from '../../srv/lib/kg-sparql-client.js';

function makeDb(returnRow = { RESPONSE: 'ok', HEADERS: '' }) {
  return { run: vi.fn().mockResolvedValue([returnRow]) };
}

// ---------------------------------------------------------------------------
// kgGraphClear dispatch
// ---------------------------------------------------------------------------

describe('kgGraphClear dispatch', () => {
  it('calls db.run once with KG_GRAPH_CLEAR DO block and [graphIri]', async () => {
    const db = makeDb();
    const result = await kgGraphClear({ db, graphIri: 'urn:t' });
    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql, args] = db.run.mock.calls[0];
    expect(sql).toContain('CALL KG_GRAPH_CLEAR');
    expect(sql).toContain('DO (');
    expect(args).toEqual(['urn:t']);
    expect(result.response).toBe('ok');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('includes the graphIri in sparqlForLog (not in SQL string)', async () => {
    const db = makeDb();
    await kgGraphClear({ db, graphIri: 'https://example.com/g' });
    const [sql] = db.run.mock.calls[0];
    // The IRI should NOT be embedded in the SQL string — it must be a bind param
    expect(sql).not.toContain('https://example.com/g');
  });

  it('returns response and headers from db.run result', async () => {
    const db = makeDb({ RESPONSE: 'clear-ok', HEADERS: 'x-header: 1' });
    const result = await kgGraphClear({ db, graphIri: 'urn:t' });
    expect(result.response).toBe('clear-ok');
    expect(result.headers).toBe('x-header: 1');
  });

  it('handles lowercase response/headers keys from driver', async () => {
    const db = makeDb({ response: 'lower-ok', headers: 'lower-h' });
    const result = await kgGraphClear({ db, graphIri: 'urn:t' });
    expect(result.response).toBe('lower-ok');
    expect(result.headers).toBe('lower-h');
  });
});

// ---------------------------------------------------------------------------
// kgGraphInsert dispatch
// ---------------------------------------------------------------------------

describe('kgGraphInsert dispatch', () => {
  it('calls db.run with KG_GRAPH_INSERT DO block', async () => {
    const db = makeDb();
    await kgGraphInsert({ db, graphIri: 'urn:t', triples: '<a> <b> <c> .' });
    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql] = db.run.mock.calls[0];
    expect(sql).toContain('CALL KG_GRAPH_INSERT');
    expect(sql).toContain('DO (');
  });

  it('passes [graphIri, triples] positionally', async () => {
    const db = makeDb();
    await kgGraphInsert({ db, graphIri: 'urn:t', triples: '<a> <b> <c> .' });
    expect(db.run.mock.calls[0][1]).toEqual(['urn:t', '<a> <b> <c> .']);
  });

  it('does NOT embed graphIri or triples in the SQL string', async () => {
    const db = makeDb();
    await kgGraphInsert({ db, graphIri: 'urn:test:myGraph', triples: '<x> <y> <z> .' });
    const [sql] = db.run.mock.calls[0];
    expect(sql).not.toContain('urn:test:myGraph');
    expect(sql).not.toContain('<x> <y> <z>');
  });
});

// ---------------------------------------------------------------------------
// kgQuery dispatch
// ---------------------------------------------------------------------------

describe('kgQuery dispatch', () => {
  it('calls db.run with KG_QUERY DO block', async () => {
    const db = makeDb();
    await kgQuery({ db, queryName: 'NEIGHBORHOOD', params: { slug: 'foo' } });
    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql] = db.run.mock.calls[0];
    expect(sql).toContain('CALL KG_QUERY');
    expect(sql).toContain('DO (');
  });

  it('NEIGHBORHOOD: passes [queryName, slug, null, null, null]', async () => {
    const db = makeDb();
    await kgQuery({ db, queryName: 'NEIGHBORHOOD', params: { slug: 'foo' } });
    expect(db.run.mock.calls[0][1]).toEqual(['NEIGHBORHOOD', 'foo', null, null, null]);
  });

  it('PATH_BETWEEN: passes [queryName, fromSlug, toSlug, null, null]', async () => {
    const db = makeDb();
    await kgQuery({ db, queryName: 'PATH_BETWEEN', params: { fromSlug: 'a', toSlug: 'b' } });
    expect(db.run.mock.calls[0][1]).toEqual(['PATH_BETWEEN', 'a', 'b', null, null]);
  });

  it('PATH_BETWEEN with overrideGraphIri: passes [queryName, fromSlug, toSlug, null, override]', async () => {
    const db = makeDb();
    await kgQuery({
      db,
      queryName: 'PATH_BETWEEN',
      params: { fromSlug: 'a', toSlug: 'b' },
      overrideGraphIri: 'urn:t',
    });
    expect(db.run.mock.calls[0][1]).toEqual(['PATH_BETWEEN', 'a', 'b', null, 'urn:t']);
  });

  it('CONCEPTS_FOR_USER: passes [queryName, userId, null, null, null]', async () => {
    const db = makeDb();
    await kgQuery({ db, queryName: 'CONCEPTS_FOR_USER', params: { userId: 'u1' } });
    expect(db.run.mock.calls[0][1]).toEqual(['CONCEPTS_FOR_USER', 'u1', null, null, null]);
  });

  it('NEIGHBORHOOD with overrideGraphIri: passes override as 5th positional arg', async () => {
    const db = makeDb();
    await kgQuery({
      db,
      queryName: 'NEIGHBORHOOD',
      params: { slug: 'foo' },
      overrideGraphIri: 'https://example.com/override',
    });
    expect(db.run.mock.calls[0][1]).toEqual(['NEIGHBORHOOD', 'foo', null, null, 'https://example.com/override']);
  });

  it('overrideGraphIri null → null in 5th position', async () => {
    const db = makeDb();
    await kgQuery({ db, queryName: 'NEIGHBORHOOD', params: { slug: 'foo' }, overrideGraphIri: null });
    expect(db.run.mock.calls[0][1][4]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kgAdminRunSparql dispatch
// ---------------------------------------------------------------------------

describe('kgAdminRunSparql dispatch', () => {
  it('calls db.run with KG_ADMIN_RUNSPARQL DO block', async () => {
    const db = makeDb();
    await kgAdminRunSparql({ db, sparql: 'SELECT ?x WHERE {}', isUpdate: false });
    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql] = db.run.mock.calls[0];
    expect(sql).toContain('CALL KG_ADMIN_RUNSPARQL');
    expect(sql).toContain('DO (');
  });

  it('isUpdate=false maps flag to "N"', async () => {
    const db = makeDb();
    await kgAdminRunSparql({ db, sparql: 'SELECT ?x WHERE {}', isUpdate: false });
    expect(db.run.mock.calls[0][1]).toEqual(['SELECT ?x WHERE {}', 'N']);
  });

  it('isUpdate=true maps flag to "Y"', async () => {
    const db = makeDb();
    await kgAdminRunSparql({ db, sparql: 'INSERT { ?x ?y ?z }', isUpdate: true });
    expect(db.run.mock.calls[0][1]).toEqual(['INSERT { ?x ?y ?z }', 'Y']);
  });

  it('does NOT embed sparql body in the SQL string', async () => {
    const db = makeDb();
    await kgAdminRunSparql({ db, sparql: 'SELECT ?secret WHERE {}', isUpdate: false });
    const [sql] = db.run.mock.calls[0];
    expect(sql).not.toContain('SELECT ?secret');
  });

  it('returns response and latencyMs', async () => {
    const db = makeDb({ RESPONSE: 'admin-ok', HEADERS: '' });
    const result = await kgAdminRunSparql({ db, sparql: 'SELECT ?x WHERE {}', isUpdate: false });
    expect(result.response).toBe('admin-ok');
    expect(typeof result.latencyMs).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// db type-guard
// ---------------------------------------------------------------------------

describe('callProcedure db type-guard (exercised via kgGraphClear)', () => {
  it('rejects null db', async () => {
    await expect(kgGraphClear({ db: null, graphIri: 'urn:t' })).rejects.toThrow(TypeError);
  });

  it('rejects db without .run method', async () => {
    await expect(kgGraphClear({ db: {}, graphIri: 'urn:t' })).rejects.toThrow(TypeError);
  });

  it('rejects db with non-function .run', async () => {
    await expect(kgGraphClear({ db: { run: 'not-a-function' }, graphIri: 'urn:t' })).rejects.toThrow(TypeError);
  });
});
