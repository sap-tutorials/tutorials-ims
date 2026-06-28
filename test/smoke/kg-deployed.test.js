// test/smoke/kg-deployed.test.js
//
// HTTP smoke test for the KG runtime post-deploy. Exercises the
// DEFINER-procedure-backed end-to-end chain (issue #381, #533):
//   - POST /graph/triggerGraphRebuild → confirms KG_GRAPH_INSERT + KG_GRAPH_CLEAR work
//   - GET  /graph/neighborhood        → confirms KG_QUERY dispatcher works
//
// Skips with a warning when SMOKE_BASE_URL/SMOKE_SRV_URL are missing
// (run during local unit-test sweeps). Individual cases skip when their
// auth env vars are missing — runtime is still validated by the chain
// of hybrid tests (see test/hybrid/kg-procedures-*.test.js).
//
// HOW TO RUN
//   SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-approver.cfapps.eu10-005.hana.ondemand.com \
//   SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
//   SMOKE_KG_ADMIN_TOKEN="$(cf oauth-token | tr -d '\n')" \
//   SMOKE_AUTH_TOKEN="$(cf oauth-token | tr -d '\n')" \
//   npm run test:smoke -- test/smoke/kg-deployed.test.js
//
// Optional env vars:
//   - SMOKE_KG_ADMIN_TOKEN — bearer token with KnowledgeGraph.Admin scope.
//                            Required for triggerGraphRebuild test.
//                            Without it, that case self-skips.
//   - SMOKE_AUTH_TOKEN     — bearer token with an authenticated developer scope.
//                            Required for neighborhood test (auth-gated via @requires).
//                            Without it, that case self-skips.
//   - SMOKE_KG_TUTORIAL_SLUG — slug of a published tutorial to query.
//                              Defaults to 'abap-dev-enhance-cds-view' (12 concept links,
//                              most stable for smoke).
//
// CI WIRING TODO
//   - SMOKE_KG_ADMIN_TOKEN must be added to GitHub Actions secrets.
//     Currently only SMOKE_AUTH_TOKEN is in CI; this is a follow-up issue.

import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

const APPROUTER = process.env.SMOKE_BASE_URL;
const SRV = process.env.SMOKE_SRV_URL;
const KG_ADMIN_TOKEN = process.env.SMOKE_KG_ADMIN_TOKEN;
const AUTH_TOKEN = process.env.SMOKE_AUTH_TOKEN;
const TUTORIAL_SLUG = process.env.SMOKE_KG_TUTORIAL_SLUG || 'abap-dev-enhance-cds-view';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe.runIf(APPROUTER && SRV)('KG runtime smoke (issue #381/#533, deployed)', () => {
  it.runIf(KG_ADMIN_TOKEN)('POST /graph/triggerGraphRebuild produces triples', async () => {
    // 90s timeout — cold-cache rebuild can take ~30s for 1089 concepts.
    const res = await fetchWithRetry(`${SRV}/graph/triggerGraphRebuild`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KG_ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tripleCount).toBeGreaterThan(0);
    expect(body.graphVersion).toMatch(UUID_RE);
  }, 90_000);

  it(`GET /graph/neighborhood?slug=${TUTORIAL_SLUG} returns rows`, async () => {
    // 90s timeout — cold-cache query against rebuilt graph.
    const res = await fetchWithRetry(
      `${SRV}/graph/neighborhood?slug=${encodeURIComponent(TUTORIAL_SLUG)}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // The endpoint returns an object with teaches/prerequisitesOf/sharedConcepts/whatToLearnNext arrays.
    // For smoke purposes, verify structure and check at least one array has content.
    expect(body.tutorial).toBeTruthy();
    expect(body.graphVersion).toBeTruthy();
    expect(Array.isArray(body.teaches)).toBe(true);
    expect(Array.isArray(body.prerequisitesOf)).toBe(true);
    expect(Array.isArray(body.sharedConcepts)).toBe(true);
    expect(Array.isArray(body.whatToLearnNext)).toBe(true);
    // At least one array should have content (the given slug has 12 concept links).
    const totalItems =
      body.teaches.length +
      body.prerequisitesOf.length +
      body.sharedConcepts.length +
      body.whatToLearnNext.length;
    expect(totalItems).toBeGreaterThanOrEqual(1);
  });

  if (!KG_ADMIN_TOKEN) {
    // eslint-disable-next-line no-console
    console.warn(
      '[kg-deployed smoke] Skipping triggerGraphRebuild — set SMOKE_KG_ADMIN_TOKEN to exercise. ' +
      'Refs #381, #533.'
    );
  }
});
