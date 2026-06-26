// Tests for the public alert read endpoints.
// Spec: docs/superpowers/specs/2026-06-26-548-alert-system-design.md
//
// Two endpoints under test:
//   GET /api/alerts        — anonymous, audience=ALL only.
//   GET /api/alerts/me     — authenticated, ALL+AUTHENTICATED (+ADMIN if admin).
//
// supertest is NOT a project dependency (and the codebase explicitly avoids
// adding it — see test/unit/advocate-user-link.test.js). We follow that
// existing pattern: spin up an ephemeral express server with
// http.createServer + Node's built-in fetch.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import cds from '@sap/cds';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { register } from '../../routes/alerts-public.js';
import { _resetForTests as resetCache } from '../alerts-cache.js';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

let db;
let server;
let baseUrl;

beforeAll(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { database: ':memory:' } };
  db = await cds.deploy(schemaPath).to('sqlite::memory:');
  const app = express();
  register(app);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await db?.disconnect?.();
});

beforeEach(async () => {
  resetCache();
  const { Alerts } = cds.entities('com.sap.developers.ims');
  await DELETE.from(Alerts);
});

async function insertAlert(overrides = {}) {
  const { Alerts } = cds.entities('com.sap.developers.ims');
  const now = new Date();
  const past = new Date(now.getTime() - 60_000);
  const future = new Date(now.getTime() + 60_000);
  const row = {
    ID: cds.utils.uuid(),
    title: 'Test',
    severity: 'Information',
    audience: 'ALL',
    startsAt: past.toISOString(),
    endsAt: future.toISOString(),
    active: true,
    dismissible: true,
    ...overrides,
  };
  await INSERT.into(Alerts).entries(row);
  return row;
}

async function getJson(pathname) {
  const res = await fetch(baseUrl + pathname);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body };
}

describe('GET /api/alerts', () => {
  it('returns 200 with empty array when no rows', async () => {
    const res = await getJson('/api/alerts');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toEqual([]);
    expect(typeof res.body.fetchedAt).toBe('string');
  });

  it('sets Cache-Control: public, max-age=60, stale-while-revalidate=300', async () => {
    const res = await getJson('/api/alerts');
    expect(res.headers['cache-control']).toMatch(/public/);
    expect(res.headers['cache-control']).toMatch(/max-age=60/);
    expect(res.headers['cache-control']).toMatch(/stale-while-revalidate=300/);
  });

  it('returns audience=ALL active rows within the window', async () => {
    await insertAlert({ title: 'Visible' });
    const res = await getJson('/api/alerts');
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].title).toBe('Visible');
  });

  it('drops rows with active=false', async () => {
    await insertAlert({ active: false });
    const res = await getJson('/api/alerts');
    expect(res.body.alerts).toEqual([]);
  });

  it('drops rows whose startsAt is in the future', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    await insertAlert({ startsAt: future });
    const res = await getJson('/api/alerts');
    expect(res.body.alerts).toEqual([]);
  });

  it('drops rows whose endsAt is in the past', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    await insertAlert({ startsAt: past, endsAt: past });
    const res = await getJson('/api/alerts');
    expect(res.body.alerts).toEqual([]);
  });

  it('keeps rows with null endsAt indefinitely (ad-hoc)', async () => {
    await insertAlert({ endsAt: null });
    const res = await getJson('/api/alerts');
    expect(res.body.alerts).toHaveLength(1);
  });

  it('does NOT return audience=AUTHENTICATED rows', async () => {
    await insertAlert({ audience: 'AUTHENTICATED' });
    const res = await getJson('/api/alerts');
    expect(res.body.alerts).toEqual([]);
  });

  it('does NOT return audience=ADMIN rows', async () => {
    await insertAlert({ audience: 'ADMIN' });
    const res = await getJson('/api/alerts');
    expect(res.body.alerts).toEqual([]);
  });
});

describe('GET /api/alerts/me', () => {
  it('returns 401 with { authenticated: false } when unauthenticated', async () => {
    const res = await getJson('/api/alerts/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ authenticated: false });
  });

  // Auth-positive cases require a CDS context middleware test setup — those
  // are covered in test/hybrid/alerts.test.js with a real JWT.
});
