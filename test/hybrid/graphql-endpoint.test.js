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

describe('scope enforcement', () => {
  let baseUrl;

  beforeAll(() => {
    baseUrl = process.env.CAP_BASE_URL
      || cds.server?.url
      || `http://localhost:${cds.server?.address?.()?.port ?? 4004}`;
  });

  it('/graphql/public serves KnowledgeGraphService without a token', async () => {
    const r = await fetch(`${baseUrl}/graphql/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ KnowledgeGraphService { PublishedConcepts { totalCount } } }'
      })
    });
    const j = await r.json();
    // Must reach the endpoint (not 401/403/404). Service-level errors (e.g.
    // KG disabled → 503) arrive as GraphQL errors with status 200 — that is
    // still a successful AUTH pass. A 401/403 would mean the public mount
    // incorrectly demands authentication.
    expect(r.status).toBe(200);
    const authCodes = (j.errors ?? [])
      .map(e => e?.extensions?.code)
      .filter(c => c === '401' || c === '403' || c === 'UNAUTHENTICATED' || c === 'FORBIDDEN');
    expect(authCodes).toHaveLength(0);
  });

  it('/graphql refuses DeveloperService.Tutorials without Tutorial.API', async () => {
    // 'display' user has only DisplayApp + authenticated-user — no Tutorial.API.
    // DeveloperService.Tutorials carries @restrict:[{grant:'*',to:'Tutorial.API'}]
    // so CAP must reject this query. CAP encodes CDS 403 as extensions.code '403'.
    const r = await fetch(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa('display:display')
      },
      body: JSON.stringify({
        query: '{ DeveloperService { Tutorials { totalCount } } }'
      })
    });
    const j = await r.json();
    const codes = (j.errors ?? []).map(e => e?.extensions?.code);
    // CAP @cap-js/graphql maps a CDS FORBIDDEN (HTTP 403) to extensions.code '403'.
    expect(codes).toContain('403');
  });

  it('/graphql answers DeveloperService.Tutorials with Tutorial.API scope', async () => {
    // 'apiuser' is a test-only mocked user (see .cdsrc.json) with Tutorial.API.
    const r = await fetch(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa('apiuser:apikey')
      },
      body: JSON.stringify({
        query: '{ DeveloperService { Tutorials { totalCount } } }'
      })
    });
    const j = await r.json();
    expect(r.status).toBe(200);
    // Must not carry any 401/403 auth error — data access is permitted.
    const authCodes = (j.errors ?? [])
      .map(e => e?.extensions?.code)
      .filter(c => c === '401' || c === '403' || c === 'UNAUTHENTICATED' || c === 'FORBIDDEN');
    expect(authCodes).toHaveLength(0);
    // Positive proof: the gate opened. DeveloperService.Tutorials is HANA-
    // backed and stable in the hybrid env (unlike the KG service, which is
    // 503 in the test config), so we can assert the data payload actually
    // arrived. Without this, the test passes even if DeveloperService
    // silently errors for any non-auth reason.
    expect(j.data?.DeveloperService).toBeDefined();
  });

  it('/graphql/public schema does NOT include DeveloperService (service-set isolation)', async () => {
    // Introspection query — /graphql/public must be filtered to the public
    // subset (KnowledgeGraphService + SearchService only). This is the
    // regression guard Task 6's smoke test could not provide because
    // `{ __typename }` returns "Query" from any mount.
    const r = await fetch(`${baseUrl}/graphql/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ __schema { queryType { fields { name } } } }'
      })
    });
    const j = await r.json();
    expect(r.status).toBe(200);
    const fieldNames = (j.data?.__schema?.queryType?.fields ?? []).map(f => f.name);
    expect(fieldNames).toContain('KnowledgeGraphService');
    expect(fieldNames).toContain('SearchService');
    expect(fieldNames).not.toContain('DeveloperService');
  });
});
