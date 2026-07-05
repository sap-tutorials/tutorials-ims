// test/hybrid/graphql-endpoint.test.js
//
// Smoke test: verify the dual GraphQL mounts are live after srv/graphql-config.js
// wires them in cds.on('served', ...).
//
// Run with: npm run test:hybrid -- test/hybrid/graphql-endpoint.test.js
// Does NOT require HANA — boots in-process CAP with in-memory SQLite.
//
// Issue #996

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { readFileSync } from 'node:fs';

// Boot without --profile hybrid so we get in-memory SQLite (no HANA required).
cds.test('serve', '--project', '.');

describe('graphql endpoints (#996)', () => {
  let baseUrl;

  beforeAll(() => {
    baseUrl = process.env.CAP_BASE_URL
      || cds.server?.url
      || `http://localhost:${cds.server?.address?.()?.port ?? 4004}`;
  });

  it('mounts /graphql/public and answers a public query with no token', async () => {
    const r = await fetch(`${baseUrl}/graphql/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' })
    });
    expect(r.status).toBe(200);
  });

  it('mounts /graphql behind auth', async () => {
    const r = await fetch(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' })
    });
    // No token → CAP may respond 401. If the endpoint doesn't exist: 404.
    // Either 200 or 401 is acceptable; 404 means the mount failed.
    expect([200, 401]).toContain(r.status);
    expect(r.status).not.toBe(404);
  });
});

it('AppRouter xs-app.json declares /graphql routes before /graph/…', () => {
  const cfg = JSON.parse(readFileSync('approuter/xs-app.json', 'utf8'));
  const idxGraphQL = cfg.routes.findIndex(r => r.source.startsWith('^/graphql'));
  const idxKG = cfg.routes.findIndex(r => r.source.startsWith('^/graph/'));
  expect(idxGraphQL).toBeGreaterThan(-1);
  expect(idxKG).toBeGreaterThan(-1);
  expect(idxGraphQL).toBeLessThan(idxKG);
});
