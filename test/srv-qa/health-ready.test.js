// test/srv-qa/health-ready.test.js
//
// #2975: srv-qa /health/ready readiness gate. The MTA sets srv-qa's CF startup
// health check to http /health/ready; srv-qa has NO scheduler, so readiness is
// DB-only (ready ⇔ a dialect-safe DB ping succeeds). Without the route CF 404s
// and srv-qa crash-loops, aborting the MTA deploy (observed 2026-11-02).
//
// We don't boot cds here; we mount the structurally-identical handler against a
// fake cds.db, exercising it over real HTTP on an ephemeral port — same pattern
// as test/srv-qa/server.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';

// Mirror of the /health/ready handler in srv-qa/server.js, parameterised on a
// fake db so we can assert the dialect-safe ping + ready/not-ready mapping.
function buildApp(fakeDb) {
  const app = express();
  app.get('/health/ready', async (_req, res) => {
    let dbOk = false;
    if (fakeDb) {
      const ping = fakeDb.kind === 'hana' ? 'SELECT 1 FROM DUMMY' : 'SELECT 1';
      try { await fakeDb.run(ping); dbOk = true; }
      catch { dbOk = false; }
    }
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ready' : 'not-ready',
      channel: 'qa',
      db: dbOk ? 'connected' : 'error',
      timestamp: new Date().toISOString(),
    });
  });
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function get(server, path) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('srv-qa /health/ready (#2975)', () => {
  it('200 ready when HANA ping (SELECT 1 FROM DUMMY) succeeds', async () => {
    let sql;
    const db = { kind: 'hana', run: async (q) => { sql = q; return [{}]; } };
    const server = await listen(buildApp(db));
    try {
      const r = await get(server, '/health/ready');
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('ready');
      expect(r.body.db).toBe('connected');
      expect(sql).toBe('SELECT 1 FROM DUMMY'); // dialect-safe on HANA
    } finally { server.close(); }
  });

  it('uses bare SELECT 1 on sqlite', async () => {
    let sql;
    const db = { kind: 'sqlite', run: async (q) => { sql = q; return [{}]; } };
    const server = await listen(buildApp(db));
    try {
      await get(server, '/health/ready');
      expect(sql).toBe('SELECT 1');
    } finally { server.close(); }
  });

  it('503 not-ready when the DB ping throws', async () => {
    const db = { kind: 'hana', run: async () => { throw new Error('db down'); } };
    const server = await listen(buildApp(db));
    try {
      const r = await get(server, '/health/ready');
      expect(r.status).toBe(503);
      expect(r.body.status).toBe('not-ready');
      expect(r.body.db).toBe('error');
    } finally { server.close(); }
  });

  it('503 not-ready when cds.db is absent', async () => {
    const server = await listen(buildApp(null));
    try {
      const r = await get(server, '/health/ready');
      expect(r.status).toBe(503);
      expect(r.body.db).toBe('error');
    } finally { server.close(); }
  });
});
