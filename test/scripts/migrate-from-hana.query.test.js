/**
 * Unit tests for the hdb wrappers query() and execStmt() in
 * scripts/migrate-from-hana.js.
 *
 * Issue #472 — guards against the 2026-06-20 cutover-rehearsal regression
 * where the migrator's query()/execStmt() called client.exec(sql, params, cb).
 * The hdb driver's Client.prototype.exec signature is exec(command, options, cb)
 * — the middle argument is OPTIONS, not bound parameters. Passing an array
 * there silently left every `?` placeholder unbound and HANA returned
 * `unbound parameter : 1 of N`.
 *
 * The fix routes parameterized SQL through prepare() + stmt.exec(params, cb).
 * These tests lock that contract by stubbing the hdb client object and
 * asserting the exact callback shape used.
 */
import { describe, it, expect, vi } from 'vitest';
import { query, execStmt } from '../../scripts/migrate-from-hana.js';

function makeStmt({ execImpl, dropImpl } = {}) {
  const execFn = vi.fn((params, cb) => {
    if (execImpl) return execImpl(params, cb);
    cb(null, []);
  });
  const drop = vi.fn((cb) => {
    if (dropImpl) return dropImpl(cb);
    if (cb) cb(null);
  });
  return { exec: execFn, drop };
}

function makeClient({ execImpl, prepareImpl, stmt } = {}) {
  const _stmt = stmt || makeStmt();
  const execFn = vi.fn((...args) => {
    if (execImpl) return execImpl(...args);
    const cb = args[args.length - 1];
    cb(null, []);
  });
  const prepare = vi.fn((sql, cb) => {
    if (prepareImpl) return prepareImpl(sql, cb);
    cb(null, _stmt);
  });
  return { exec: execFn, prepare, _stmt };
}

describe('query() — no parameters', () => {
  it('routes through client.exec(sql, cb) with the 2-arg shape (no params)', async () => {
    const client = makeClient({
      execImpl: (sql, cb) => cb(null, [{ N: 1 }]),
    });
    const rows = await query(client, 'SELECT 1');
    expect(rows).toEqual([{ N: 1 }]);
    expect(client.exec).toHaveBeenCalledTimes(1);
    const args = client.exec.mock.calls[0];
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('SELECT 1');
    expect(typeof args[1]).toBe('function');
    expect(client.prepare).not.toHaveBeenCalled();
  });

  it('treats an empty params array the same as no params', async () => {
    const client = makeClient({
      execImpl: (sql, cb) => cb(null, [{ N: 2 }]),
    });
    const rows = await query(client, 'SELECT 2', []);
    expect(rows).toEqual([{ N: 2 }]);
    expect(client.exec).toHaveBeenCalledTimes(1);
    expect(client.prepare).not.toHaveBeenCalled();
  });

  it('rejects with prefixed error message on exec failure', async () => {
    const client = makeClient({
      execImpl: (_sql, cb) => cb(new Error('boom')),
    });
    await expect(query(client, 'SELECT bad')).rejects.toThrow(/SQL error: boom/);
    await expect(query(client, 'SELECT bad')).rejects.toThrow(/SQL: SELECT bad/);
  });
});

describe('query() — parameterized (the #472 fix)', () => {
  it('routes through prepare() + stmt.exec(params, cb), NOT client.exec(sql, params, cb)', async () => {
    const stmt = makeStmt({
      execImpl: (params, cb) => cb(null, [{ ID: params[0] }, { ID: params[1] }, { ID: params[2] }]),
    });
    const client = makeClient({ stmt });

    const sql = 'SELECT * FROM x WHERE y IN (?,?,?)';
    const params = ['a', 'b', 'c'];
    const rows = await query(client, sql, params);

    expect(rows).toEqual([{ ID: 'a' }, { ID: 'b' }, { ID: 'c' }]);
    expect(client.exec).not.toHaveBeenCalled();
    expect(client.prepare).toHaveBeenCalledTimes(1);
    expect(client.prepare.mock.calls[0][0]).toBe(sql);
    expect(stmt.exec).toHaveBeenCalledTimes(1);
    expect(stmt.exec.mock.calls[0][0]).toEqual(params);
    expect(typeof stmt.exec.mock.calls[0][1]).toBe('function');
    expect(stmt.drop).toHaveBeenCalledTimes(1);
  });

  it('rejects with prefixed error message on prepare failure', async () => {
    const client = makeClient({
      prepareImpl: (_sql, cb) => cb(new Error('prepare boom')),
    });
    await expect(query(client, 'SELECT * FROM x WHERE id = ?', [1]))
      .rejects.toThrow(/SQL error: prepare boom/);
  });

  it('rejects with prefixed error message on stmt.exec failure', async () => {
    const stmt = makeStmt({
      execImpl: (_params, cb) => cb(new Error('exec boom')),
    });
    const client = makeClient({ stmt });
    await expect(query(client, 'SELECT * FROM x WHERE id = ?', [1]))
      .rejects.toThrow(/SQL error: exec boom/);
    expect(stmt.drop).toHaveBeenCalledTimes(1);
  });

  it('tolerates stmt.drop() throwing fire-and-forget never breaks the result path', async () => {
    const stmt = makeStmt({
      execImpl: (_p, cb) => cb(null, [{ OK: 1 }]),
      dropImpl: () => { throw new Error('drop boom'); },
    });
    const client = makeClient({ stmt });
    const rows = await query(client, 'SELECT 1 FROM dummy WHERE x = ?', [1]);
    expect(rows).toEqual([{ OK: 1 }]);
  });
});

describe('execStmt() — no parameters', () => {
  it('routes through client.exec(sql, cb) with the 2-arg shape', async () => {
    const client = makeClient({
      execImpl: (_sql, cb) => cb(null, 7),
    });
    const result = await execStmt(client, 'DELETE FROM x WHERE 1=1');
    expect(result).toBe(7);
    expect(client.exec).toHaveBeenCalledTimes(1);
    const args = client.exec.mock.calls[0];
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('DELETE FROM x WHERE 1=1');
    expect(typeof args[1]).toBe('function');
    expect(client.prepare).not.toHaveBeenCalled();
  });

  it('rejects on exec failure with truncated SQL in the message', async () => {
    const client = makeClient({
      execImpl: (_sql, cb) => cb(new Error('write boom')),
    });
    await expect(execStmt(client, 'UPDATE x SET y = 1'))
      .rejects.toThrow(/SQL error: write boom/);
  });
});

describe('execStmt() — parameterized (the #472 fix on the write path)', () => {
  it('routes through prepare() + stmt.exec(params, cb), NOT client.exec(sql, params, cb)', async () => {
    const stmt = makeStmt({
      execImpl: (params, cb) => cb(null, params.length),
    });
    const client = makeClient({ stmt });

    const sql = 'UPDATE Tutorials SET TITLE = ? WHERE ID = ?';
    const params = ['New title', 'uuid-1'];
    const result = await execStmt(client, sql, params);

    expect(result).toBe(2);
    expect(client.exec).not.toHaveBeenCalled();
    expect(client.prepare).toHaveBeenCalledTimes(1);
    expect(client.prepare.mock.calls[0][0]).toBe(sql);
    expect(stmt.exec).toHaveBeenCalledTimes(1);
    expect(stmt.exec.mock.calls[0][0]).toEqual(params);
    expect(stmt.drop).toHaveBeenCalledTimes(1);
  });

  it('rejects with prefixed error message on prepare failure', async () => {
    const client = makeClient({
      prepareImpl: (_sql, cb) => cb(new Error('prepare boom')),
    });
    await expect(execStmt(client, 'UPDATE x SET y = ? WHERE id = ?', [1, 2]))
      .rejects.toThrow(/SQL error: prepare boom/);
  });

  it('rejects with prefixed error message on stmt.exec failure and still drops the statement', async () => {
    const stmt = makeStmt({
      execImpl: (_p, cb) => cb(new Error('exec boom')),
    });
    const client = makeClient({ stmt });
    await expect(execStmt(client, 'UPDATE x SET y = ? WHERE id = ?', [1, 2]))
      .rejects.toThrow(/SQL error: exec boom/);
    expect(stmt.drop).toHaveBeenCalledTimes(1);
  });

  it('tolerates stmt.drop() throwing fire-and-forget never breaks the result path', async () => {
    const stmt = makeStmt({
      execImpl: (_p, cb) => cb(null, 3),
      dropImpl: () => { throw new Error('drop boom'); },
    });
    const client = makeClient({ stmt });
    const result = await execStmt(client, 'INSERT INTO x VALUES (?)', [1]);
    expect(result).toBe(3);
  });
});
