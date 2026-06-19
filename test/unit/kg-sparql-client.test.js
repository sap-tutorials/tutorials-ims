// test/unit/kg-sparql-client.test.js
// Unit tests for srv/lib/kg-sparql-client.js — exercises the wrapper's
// error classification, timeout, validation, and shape coercion. No real
// HANA needed; the underlying db.run() is mocked.
//
// The hybrid test (test/hybrid/kg-graph-rebuild.test.js) exercises the
// full round-trip against real HANA KGE — that's where the spike's actual
// SPARQL contract is verified.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sparqlExec,
  sparqlQuery,
  SparqlPrivilegeError,
  SparqlSyntaxError,
  SparqlTimeoutError,
  __TESTING__,
} from '../../srv/lib/kg-sparql-client.js';

function makeDb({ runImpl } = {}) {
  return { run: vi.fn(runImpl ?? (() => Promise.resolve([]))) };
}

describe('kg-sparql-client — input validation', () => {
  it('rejects non-string sparql', async () => {
    const db = makeDb();
    await expect(sparqlExec(db, null)).rejects.toThrow(TypeError);
    await expect(sparqlExec(db, undefined)).rejects.toThrow(TypeError);
    await expect(sparqlExec(db, 42)).rejects.toThrow(TypeError);
    await expect(sparqlExec(db, Buffer.from('x'))).rejects.toThrow(TypeError);
    await expect(sparqlExec(db, { x: 1 })).rejects.toThrow(TypeError);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('rejects empty / whitespace-only sparql', async () => {
    const db = makeDb();
    await expect(sparqlExec(db, '')).rejects.toThrow(TypeError);
    await expect(sparqlExec(db, '   \n\t')).rejects.toThrow(TypeError);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('rejects a missing or non-callable db', async () => {
    await expect(sparqlExec(null, 'SELECT * WHERE { ?s ?p ?o }')).rejects.toThrow(TypeError);
    await expect(sparqlExec({}, 'SELECT * WHERE { ?s ?p ?o }')).rejects.toThrow(TypeError);
    await expect(sparqlExec({ run: 'nope' }, 'SELECT * WHERE { ?s ?p ?o }')).rejects.toThrow(TypeError);
  });
});

describe('kg-sparql-client — bind parameter passing', () => {
  it('passes the SPARQL body as the FIRST bind parameter', async () => {
    const db = makeDb({
      runImpl: () => Promise.resolve([{ RESPONSE: 'ok', HEADERS: '' }]),
    });
    const sparql = 'SELECT * WHERE { ?s ?p ?o }';
    await sparqlExec(db, sparql);
    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toBe(__TESTING__.SPARQL_DO_BLOCK);
    expect(params).toHaveLength(2);
    expect(params[0]).toBe(sparql);
    expect(params[1]).toBe(''); // default acceptHeader
  });

  it('passes a custom acceptHeader as the SECOND bind parameter', async () => {
    const db = makeDb({
      runImpl: () => Promise.resolve([{ response: '{}', headers: '' }]),
    });
    await sparqlQuery(db, 'ASK { ?s ?p ?o }', { acceptHeader: 'application/sparql-results+json' });
    const [, params] = db.run.mock.calls[0];
    expect(params[1]).toBe('application/sparql-results+json');
  });

  it('does NOT concatenate the SPARQL body into the SQL string', async () => {
    // Defense-in-depth: the wrapper must rely on bind parameters. If anyone
    // ever inlines the SPARQL into the SQL string, this test catches it.
    const db = makeDb({
      runImpl: () => Promise.resolve([{ RESPONSE: 'ok', HEADERS: '' }]),
    });
    const sparql = 'INSERT DATA { GRAPH <kg:tutorials> { <a> <b> "c\'; DROP TABLE x" } }';
    await sparqlExec(db, sparql);
    const [sql] = db.run.mock.calls[0];
    expect(sql).not.toContain('DROP TABLE x');
    expect(sql).not.toContain('<kg:tutorials>');
  });
});

describe('kg-sparql-client — shape coercion', () => {
  it('handles a flat-array driver shape', async () => {
    const db = makeDb({
      runImpl: () => Promise.resolve([{ RESPONSE: 'flat', HEADERS: 'h1' }]),
    });
    const r = await sparqlExec(db, 'SELECT * WHERE { ?s ?p ?o }');
    expect(r.response).toBe('flat');
    expect(r.headers).toBe('h1');
    expect(typeof r.latencyMs).toBe('number');
  });

  it('handles a nested-array driver shape', async () => {
    const db = makeDb({
      runImpl: () => Promise.resolve([[{ RESPONSE: 'nested', HEADERS: 'h2' }]]),
    });
    const r = await sparqlExec(db, 'SELECT * WHERE { ?s ?p ?o }');
    expect(r.response).toBe('nested');
    expect(r.headers).toBe('h2');
  });

  it('handles a single-object driver shape', async () => {
    const db = makeDb({
      runImpl: () => Promise.resolve({ response: 'obj', headers: 'h3' }),
    });
    const r = await sparqlExec(db, 'SELECT * WHERE { ?s ?p ?o }');
    expect(r.response).toBe('obj');
    expect(r.headers).toBe('h3');
  });

  it('falls back to empty strings when the driver returns nothing usable', async () => {
    const db = makeDb({
      runImpl: () => Promise.resolve(null),
    });
    const r = await sparqlExec(db, 'SELECT * WHERE { ?s ?p ?o }');
    expect(r.response).toBe('');
    expect(r.headers).toBe('');
  });

  it('coerceRow exported helper handles the three shapes', () => {
    expect(__TESTING__.coerceRow([{ a: 1 }])).toEqual({ a: 1 });
    expect(__TESTING__.coerceRow([[{ a: 2 }]])).toEqual({ a: 2 });
    expect(__TESTING__.coerceRow({ a: 3 })).toEqual({ a: 3 });
    expect(__TESTING__.coerceRow(null)).toEqual({});
    expect(__TESTING__.coerceRow([])).toEqual({});
    expect(__TESTING__.coerceRow(['scalar'])).toEqual({});
  });
});

describe('kg-sparql-client — privilege error mapping', () => {
  it('maps numeric HANA code 258 to SparqlPrivilegeError', async () => {
    const cause = Object.assign(new Error('Insufficient privilege: not authorized'), { code: 258 });
    const db = makeDb({ runImpl: () => Promise.reject(cause) });
    const p = sparqlExec(db, 'INSERT DATA { GRAPH <kg:t> { <a> <b> <c> } }');
    await expect(p).rejects.toBeInstanceOf(SparqlPrivilegeError);
    await expect(p).rejects.toMatchObject({
      cause,
      code: 258,
    });
    await expect(p).rejects.toHaveProperty('remediation');
  });

  it('maps the "User does not have SPARQL UPDATE" message even without numeric code', async () => {
    const cause = new Error('User does not have SPARQL UPDATE privilege on container.');
    // Note: no .code field — pure message-regex path.
    const db = makeDb({ runImpl: () => Promise.reject(cause) });
    const p = sparqlExec(db, 'CLEAR GRAPH <kg:t>');
    await expect(p).rejects.toBeInstanceOf(SparqlPrivilegeError);
  });

  it('maps the "Insufficient privilege ... SPARQL QUERY" message path', async () => {
    const cause = new Error('Insufficient privilege: cannot grant SPARQL QUERY here');
    const db = makeDb({ runImpl: () => Promise.reject(cause) });
    const p = sparqlQuery(db, 'SELECT * WHERE { ?s ?p ?o }');
    await expect(p).rejects.toBeInstanceOf(SparqlPrivilegeError);
  });

  it('truncates sparql attached to the error to 200 chars', async () => {
    const cause = Object.assign(new Error('priv'), { code: 258 });
    const db = makeDb({ runImpl: () => Promise.reject(cause) });
    const longSparql = 'SELECT * WHERE { ' + '?x ?y ?z . '.repeat(100) + '}';
    try {
      await sparqlExec(db, longSparql);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SparqlPrivilegeError);
      expect(err.sparql.length).toBeLessThanOrEqual(201); // 200 + ellipsis
      expect(err.sparql.endsWith('…')).toBe(true);
    }
  });
});

describe('kg-sparql-client — syntax error mapping', () => {
  it('maps numeric HANA code 257 to SparqlSyntaxError', async () => {
    const cause = Object.assign(new Error('parse error'), { code: 257 });
    const db = makeDb({ runImpl: () => Promise.reject(cause) });
    await expect(sparqlExec(db, 'NOT VALID SPARQL')).rejects.toBeInstanceOf(SparqlSyntaxError);
  });

  it('maps numeric HANA code 261 to SparqlSyntaxError', async () => {
    const cause = Object.assign(new Error('something'), { code: 261 });
    const db = makeDb({ runImpl: () => Promise.reject(cause) });
    await expect(sparqlExec(db, 'NOT VALID')).rejects.toBeInstanceOf(SparqlSyntaxError);
  });

  it('maps a "SPARQL ... syntax" message even without numeric code', async () => {
    const cause = new Error('SPARQL syntax error near token "FOO"');
    const db = makeDb({ runImpl: () => Promise.reject(cause) });
    await expect(sparqlExec(db, 'FOO')).rejects.toBeInstanceOf(SparqlSyntaxError);
  });
});

describe('kg-sparql-client — generic errors are re-thrown unchanged', () => {
  it('preserves the original error class and message', async () => {
    class WeirdDriverError extends Error {}
    const cause = new WeirdDriverError('connection lost');
    const db = makeDb({ runImpl: () => Promise.reject(cause) });
    await expect(sparqlExec(db, 'SELECT * WHERE { ?s ?p ?o }')).rejects.toBe(cause);
  });
});

describe('kg-sparql-client — timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with SparqlTimeoutError when the underlying db.run hangs past the timeout', async () => {
    // db.run never resolves
    const db = makeDb({
      runImpl: () => new Promise(() => { /* pending forever */ }),
    });
    const promise = sparqlExec(db, 'SELECT * WHERE { ?s ?p ?o }', { timeoutMs: 1000 });
    // Attach error handler IMMEDIATELY so the unhandled-rejection slot is
    // claimed before vi.advanceTimersByTimeAsync flushes the microtask queue.
    const assertion = expect(promise).rejects.toBeInstanceOf(SparqlTimeoutError);
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
  });

  it('uses the default 30s timeout when no override is provided', async () => {
    expect(__TESTING__.DEFAULT_TIMEOUT_MS).toBe(30_000);
    const db = makeDb({
      runImpl: () => new Promise(() => { /* pending forever */ }),
    });
    const promise = sparqlExec(db, 'SELECT * WHERE { ?s ?p ?o }');
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'SparqlTimeoutError',
      timeoutMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });

  it('does NOT fire the timeout if db.run resolves first', async () => {
    const db = makeDb({
      runImpl: () => Promise.resolve([{ RESPONSE: 'ok', HEADERS: '' }]),
    });
    const r = await sparqlExec(db, 'SELECT * WHERE { ?s ?p ?o }', { timeoutMs: 5000 });
    expect(r.response).toBe('ok');
    // Even if we advance fake timers now, the promise has already settled.
    await vi.advanceTimersByTimeAsync(10_000);
  });
});

describe('kg-sparql-client — sparqlExec vs sparqlQuery', () => {
  it('both functions delegate to the same underlying invocation', async () => {
    const db = makeDb({
      runImpl: () => Promise.resolve([{ RESPONSE: 'ok', HEADERS: '' }]),
    });
    await sparqlExec(db, 'CLEAR GRAPH <kg:t>');
    await sparqlQuery(db, 'SELECT * WHERE { ?s ?p ?o }');
    expect(db.run).toHaveBeenCalledTimes(2);
    // Both calls used the same DO block.
    expect(db.run.mock.calls[0][0]).toBe(__TESTING__.SPARQL_DO_BLOCK);
    expect(db.run.mock.calls[1][0]).toBe(__TESTING__.SPARQL_DO_BLOCK);
  });
});
