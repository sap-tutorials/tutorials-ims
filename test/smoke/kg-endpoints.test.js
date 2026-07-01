// test/smoke/kg-endpoints.test.js
// Smoke test for the deployed KnowledgeGraphService endpoints — exercised
// against a live tutorials-srv URL after PR 5 has shipped.
//
// HOW TO RUN
//   SMOKE_BASE_URL=https://tutorial-system-dev-approuter.cfapps.eu10-005.hana.ondemand.com \
//   SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
//   SMOKE_AUTH_TOKEN="$(cf oauth-token | tr -d '\n')" \
//   npm run test:smoke -- test/smoke/kg-endpoints.test.js
//
// Optional env vars (some tests skip when absent):
//   - SMOKE_AUTH_TOKEN          — bearer token for an authenticated developer.
//                                 Required for the neighborhood happy-path cases.
//                                 The smoke runner gets this via `cf oauth-token`.
//   - SMOKE_KG_TUTORIAL_SLUG    — slug of a published tutorial. Defaults to
//                                 'hana-cloud-cap-create' (per the plan). If
//                                 the deploy doesn't have it yet, the
//                                 happy-path test self-skips with a warning.
//   - SMOKE_KG_FLAG_DISABLED    — set to 'true' if the deployed srv has
//                                 KNOWLEDGE_GRAPH_ENABLED unset/false. Flips
//                                 the disabled-flag test from skip to active.
//
// CONVENTION NOTES
//   - Mirrors test/smoke/auth-enforcement.test.js (anon path) and
//     test/smoke/admin-exports.smoke.test.js (token path).
//   - `describe.runIf(APPROUTER && SRV)` keeps the suite quiet during local
//     unit-test runs where SMOKE_* env vars are absent.

import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

const APPROUTER = process.env.SMOKE_BASE_URL;
const SRV = process.env.SMOKE_SRV_URL;
const AUTH_TOKEN = process.env.SMOKE_AUTH_TOKEN;
const KG_TUTORIAL_SLUG = process.env.SMOKE_KG_TUTORIAL_SLUG || 'hana-cloud-cap-create';
const KG_FLAG_DISABLED = process.env.SMOKE_KG_FLAG_DISABLED === 'true';

if (!process.env.SMOKE_KG_FLAG_DISABLED) {
  // eslint-disable-next-line no-console
  console.warn(
    '[kg-endpoints smoke] SMOKE_KG_FLAG_DISABLED unset; the disabled-flag assertions will be skipped. ' +
    'To exercise that path: cf set-env tutorials-srv KNOWLEDGE_GRAPH_ENABLED false && cf restart, ' +
    'then SMOKE_KG_FLAG_DISABLED=true.'
  );
}

function authHeaders(token = AUTH_TOKEN) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

describe.runIf(APPROUTER && SRV)('Knowledge Graph endpoints smoke', () => {
  // ─── Anonymous-access checks (no token required) ────────────────────────
  it('GET /graph/neighborhood without auth returns 200', async () => {
    const res = await fetchWithRetry(
      `${SRV_URL}/graph/neighborhood(slug='${KG_TUTORIAL_SLUG}')`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('teaches');
  });

  // Whole /graph/* reader surface must be anonymous. #853 was caused by
  // `neighborhood` being the only endpoint the widget hits, but the four
  // projections back the /explore page + admin tooling — if we ever drop
  // `@requires: 'any'` again, all four regress in lockstep, so pin them.
  it.each([
    ['PublishedConcepts',      '$top=1'],
    ['Concepts',               '$top=1'],
    ['ConceptEdges',           '$top=1'],
    ['TutorialConceptLinks',   '$top=1'],
  ])('GET /graph/%s without auth returns 200 (issue #853)', async (entity, query) => {
    const res = await fetchWithRetry(`${SRV_URL}/graph/${entity}?${query}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('value');
    expect(Array.isArray(body.value)).toBe(true);
  });

  it('POST /graph/runSparql without auth is rejected', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/graph/runSparql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }' }),
    });
    expect([401, 403]).toContain(res.status);
  });

  // ─── Authenticated-developer happy paths ────────────────────────────────
  describe.runIf(AUTH_TOKEN && !KG_FLAG_DISABLED)('with auth token (KG flag enabled)', () => {
    it('GET /graph/neighborhood for a known slug returns the expected JSON shape', async () => {
      // Pre-flight: confirm the slug actually exists in the deployed catalog.
      // If it doesn't (e.g. fresh deploy missing this tutorial), self-skip
      // rather than emit a false-positive failure.
      const head = await fetchWithRetry(
        `${SRV_URL}/api/tutorials('${KG_TUTORIAL_SLUG}')`,
        { headers: authHeaders() }
      );
      if (head.status === 404) {
        // eslint-disable-next-line no-console
        console.warn(
          `[kg-endpoints smoke] slug '${KG_TUTORIAL_SLUG}' not present on ${SRV_URL}; skipping happy-path. ` +
          `Set SMOKE_KG_TUTORIAL_SLUG to a known-existing slug.`
        );
        return;
      }

      const res = await fetchWithRetry(
        `${SRV_URL}/graph/neighborhood(slug='${KG_TUTORIAL_SLUG}')`,
        { headers: authHeaders() }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      // Top-level shape — spec contract from srv/knowledge-graph-service.cds
      // (NeighborhoodResult). graphVersion may be null on cold start (no
      // rebuild yet); we only assert the keys exist.
      expect(body).toHaveProperty('tutorial');
      expect(body).toHaveProperty('graphVersion');
      expect(body).toHaveProperty('teaches');
      expect(body).toHaveProperty('prerequisitesOf');
      expect(body).toHaveProperty('sharedConcepts');
      expect(body).toHaveProperty('whatToLearnNext');
      expect(Array.isArray(body.teaches)).toBe(true);
      expect(Array.isArray(body.prerequisitesOf)).toBe(true);
      expect(Array.isArray(body.sharedConcepts)).toBe(true);
      expect(Array.isArray(body.whatToLearnNext)).toBe(true);
      expect(body.tutorial).toMatchObject({
        slug: KG_TUTORIAL_SLUG,
        title: expect.any(String),
      });
    });

    it('GET /graph/neighborhood for a nonexistent slug returns 200 with empty groups', async () => {
      // The handler returns the empty-but-valid envelope for slugs that pass
      // SLUG_RE but have no matching graph data — same envelope as cold-start
      // (graphVersion === null).
      const res = await fetchWithRetry(
        `${SRV_URL}/graph/neighborhood(slug='nonexistent-slug-xyz-${Date.now()}')`,
        { headers: authHeaders() }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.teaches).toEqual([]);
      expect(body.prerequisitesOf).toEqual([]);
      expect(body.sharedConcepts).toEqual([]);
      expect(body.whatToLearnNext).toEqual([]);
    });

    it('GET /graph/neighborhood with an invalid slug returns 400', async () => {
      // Spaces + uppercase fail SLUG_RE; the handler emits 400 with the
      // KG_QUERY_INVALID_SLUG code path. Note: the URL encoder will
      // percent-encode the space and capital letters, but the bound `slug`
      // will arrive at the handler as-is and fail validation.
      const url = `${SRV_URL}/graph/neighborhood(slug='INVALID%20UPPER')`;
      const res = await fetchWithRetry(url, { headers: authHeaders() });
      expect(res.status).toBe(400);
    });

    it('POST /graph/runSparql with a non-admin user token returns 403', async () => {
      // SMOKE_AUTH_TOKEN is a regular developer token; runSparql requires
      // KnowledgeGraph.Admin scope. CAP returns 403 from the @requires gate
      // before the handler body executes.
      const res = await fetchWithRetry(`${SRV_URL}/graph/runSparql`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: 'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }' }),
      });
      expect(res.status).toBe(403);
    });
  });

  // ─── Feature-flag disabled path ─────────────────────────────────────────
  // The handler's before('*') hook rejects every request with 503 when
  // KNOWLEDGE_GRAPH_ENABLED !== 'true'. Toggling this requires `cf set-env
  // tutorials-srv KNOWLEDGE_GRAPH_ENABLED false && cf restart`, so we
  // can't flip it per-request — the test runs only when the operator has
  // set SMOKE_KG_FLAG_DISABLED=true to confirm the disabled state.
  //
  // Out-of-band manual verification path:
  //   cf set-env tutorials-srv KNOWLEDGE_GRAPH_ENABLED false
  //   cf restart tutorials-srv
  //   SMOKE_KG_FLAG_DISABLED=true npm run test:smoke -- test/smoke/kg-endpoints.test.js
  //   cf set-env tutorials-srv KNOWLEDGE_GRAPH_ENABLED true
  //   cf restart tutorials-srv
  describe.runIf(AUTH_TOKEN && KG_FLAG_DISABLED)('with KNOWLEDGE_GRAPH_ENABLED unset', () => {
    it('GET /graph/neighborhood returns 503', async () => {
      const res = await fetchWithRetry(
        `${SRV_URL}/graph/neighborhood(slug='${KG_TUTORIAL_SLUG}')`,
        { headers: authHeaders() }
      );
      expect(res.status).toBe(503);
    });
  });
});
