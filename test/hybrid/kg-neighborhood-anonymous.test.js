// test/hybrid/kg-neighborhood-anonymous.test.js
//
// Runtime contract: GET /graph/neighborhood(slug='...') is reachable
// without an auth header. Backed by cds bind --exec against real HANA.
//
// Counterpart to test/unit/srv/kg-service-auth.test.js (CDS shape) and
// test/unit/approuter/xs-app-graph-routes.test.js (approuter routing).
// This level catches a bug those can't: CAP's runtime enforcement of
// @requires might lag the CDS annotation if a stale gen/ tree sneaks
// into the test environment.
//
// Run with: npm run test:hybrid -- test/hybrid/kg-neighborhood-anonymous.test.js
// Requires: `cf login` to a HANA-bound CF space first.
//
// Pattern follows test/hybrid/graph-path-route.test.js (same project,
// same `cds.test('serve', --profile hybrid)` boot, same axios-shaped
// project.get/post helpers).

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

// Slug confirmed by controller HANA probe: one of 10 tutorials with
// associated concepts. Parameterizable for portability across snapshots.
const SLUG = process.env.SMOKE_KG_TUTORIAL_SLUG
  || 'abap-environment-deploy-fiori-elements-ui';

describe('GET /graph/neighborhood — anonymous', () => {
  it('returns 200 with the NeighborhoodResult shape', async () => {
    let r;
    try {
      r = await project.get(`/graph/neighborhood(slug='${SLUG}')`);
    } catch (err) {
      r = err.response;
      // Anonymous must NOT be rejected with 401/403; surface enough info
      // for debugging if the runtime contract regresses.
      if (r && (r.status === 401 || r.status === 403)) {
        throw new Error(
          `Anonymous GET /graph/neighborhood was rejected with ${r.status}. ` +
          `The @requires annotation on KnowledgeGraphService must allow anonymous reads.`
        );
      }
      throw err;
    }
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty('tutorial');
    expect(r.data).toHaveProperty('graphVersion');
    expect(Array.isArray(r.data.teaches)).toBe(true);
    expect(Array.isArray(r.data.prerequisitesOf)).toBe(true);
    expect(Array.isArray(r.data.sharedConcepts)).toBe(true);
    expect(Array.isArray(r.data.whatToLearnNext)).toBe(true);
  });

  it('admin POST /graph/runSparql still requires the admin scope', async () => {
    // Defence-in-depth: anonymous must NOT be able to fire write actions.
    // CAP rejects with 401 (no user at all) or 403 (user without scope) —
    // either is correct; only the success path is forbidden.
    let r;
    try {
      r = await project.post('/graph/runSparql', {
        query: 'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }',
      });
    } catch (err) {
      r = err.response;
    }
    expect(r, 'expected an HTTP response, not undefined').toBeDefined();
    expect([401, 403]).toContain(r.status);
  });
});
