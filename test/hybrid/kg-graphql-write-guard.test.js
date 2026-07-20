// test/hybrid/kg-graphql-write-guard.test.js
//
// Regression test for issue #1230 — unauthenticated GraphQL write/delete
// mutations on KnowledgeGraphService.
//
// The KG service is @requires:'any' (anonymous-readable) and is mounted on the
// anonymous /graphql/public endpoint. @cap-js/graphql auto-generates
// create/update/delete mutations for the writable Concepts + ConceptAliases
// projections and dispatches them straight to the CAP service, bypassing the
// OData-only @Capabilities.Insert/DeleteRestrictions that were the original
// (protocol-specific) control. Writes MUST require KnowledgeGraph.Admin
// regardless of protocol; the fix is a service-layer before-handler guard.
//
// This test drives the real GraphQL mount (in-memory SQLite, no HANA) and
// asserts anonymous mutations are refused (403) AND the DB is untouched, while
// anonymous reads keep working. Model: test/hybrid/graphql-endpoint.test.js.
//
// Run: npm run test:hybrid -- test/hybrid/kg-graphql-write-guard.test.js

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

// KG service is gated by the feature flag; must be true BEFORE cds.test() boots
// or every request returns 503 (see kg-concepts-update-guard.test.js:30).
process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';

cds.test('serve', '--project', '.');

const TEST_ID = 'C0000001-0000-0000-0000-000000001230';
const TEST_SLUG = 'kg-1230-graphql-guard';
const ALIAS_ID = 'A0000001-0000-0000-0000-000000001230';

let baseUrl;

async function gql(query, headers = {}) {
  const r = await fetch(`${baseUrl}/graphql/public`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  return { status: r.status, json: j };
}

function authCodes(json) {
  return (json.errors ?? [])
    .map((e) => e?.extensions?.code)
    .filter((c) => c === '401' || c === '403' || c === 'UNAUTHENTICATED' || c === 'FORBIDDEN');
}

// A write is "refused" if the GraphQL response carries ANY error whose status
// indicates the mutation did not execute. Two distinct controls can fire:
//   - 403 — our service-layer before-handler guard (ConceptAliases, and Concepts
//     UPDATE) asserting KnowledgeGraph.Admin.
//   - 405 ENTITY_IS_NOT_CRUD — CAP's OData @Capabilities.Insert/DeleteRestrictions
//     on Concepts, which @cap-js/graphql DOES honor via check_odata_constraints.
// Either way the write must not have happened; the DB-unchanged assertion in each
// test is the load-bearing proof. We assert the mutation returned an error and
// resolved to null data.
function writeRefused(status, json, path) {
  expect(status).toBe(200); // GraphQL encodes CDS errors as HTTP 200 + errors[]
  const errs = json.errors ?? [];
  expect(errs.length).toBeGreaterThan(0);
  const statuses = errs.map((e) => e?.extensions?.status);
  // Every refusal we expect is a 403 (our guard) or 405 (OData capability block).
  expect(statuses.some((s) => s === 403 || s === 405)).toBe(true);
  // The mutation field resolved to null (did not return a written row).
  expect(json.data?.KnowledgeGraphService?.[path.entity]?.[path.op]).toBeNull();
}

beforeAll(async () => {
  baseUrl =
    process.env.CAP_BASE_URL ||
    cds.server?.url ||
    `http://localhost:${cds.server?.address?.()?.port ?? 4004}`;

  const db = await cds.connect.to('db');
  const { Concepts, ConceptAliases } = cds.entities('com.sap.developers.ims');
  await db.run(DELETE.from(ConceptAliases).where({ ID: ALIAS_ID }));
  await db.run(DELETE.from(Concepts).where({ ID: TEST_ID }));
  await db.run(
    INSERT.into(Concepts).entries([
      { ID: TEST_ID, slug: TEST_SLUG, name: 'Guard Target', description: 'seed', status: 'ACTIVE' },
    ]),
  );
  await db.run(
    INSERT.into(ConceptAliases).entries([
      { ID: ALIAS_ID, concept_ID: TEST_ID, alias: 'GuardAlias', aliasLower: 'guardalias' },
    ]),
  );
});

afterAll(async () => {
  const db = await cds.connect.to('db');
  const { Concepts, ConceptAliases } = cds.entities('com.sap.developers.ims');
  await db.run(DELETE.from(ConceptAliases).where({ ID: ALIAS_ID }));
  await db.run(DELETE.from(Concepts).where({ ID: TEST_ID }));
});

describe('#1230 — anonymous GraphQL writes on KnowledgeGraphService are refused', () => {
  it('anonymous Concepts.delete is refused and the row survives', async () => {
    const { status, json } = await gql(
      `mutation { KnowledgeGraphService { Concepts { delete(filter: { ID: { eq: "${TEST_ID}" } }) } } }`,
    );
    writeRefused(status, json, { entity: 'Concepts', op: 'delete' });

    const { Concepts } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(Concepts).columns('ID').where({ ID: TEST_ID });
    expect(row).toBeTruthy(); // NOT deleted
  });

  it('anonymous Concepts.create is refused and no row is created', async () => {
    const newSlug = 'kg-1230-anon-created';
    const { status, json } = await gql(
      `mutation { KnowledgeGraphService { Concepts { create(input: [{ slug: "${newSlug}", name: "anon", status: "ACTIVE" }]) { ID } } } }`,
    );
    writeRefused(status, json, { entity: 'Concepts', op: 'create' });

    const { Concepts } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(Concepts).columns('ID').where({ slug: newSlug });
    expect(row).toBeFalsy(); // NOT created
  });

  it('anonymous ConceptAliases.delete → 403 and the alias survives', async () => {
    const { status, json } = await gql(
      `mutation { KnowledgeGraphService { ConceptAliases { delete(filter: { ID: { eq: "${ALIAS_ID}" } }) } } }`,
    );
    writeRefused(status, json, { entity: 'ConceptAliases', op: 'delete' });
    expect(authCodes(json)).toContain('403'); // specifically our service-layer guard

    const { ConceptAliases } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(ConceptAliases).columns('ID').where({ ID: ALIAS_ID });
    expect(row).toBeTruthy(); // NOT deleted
  });

  it('anonymous ConceptAliases.create → 403 and no alias is created', async () => {
    // The create input references the parent via the `concept` association
    // (nested key), not a scalar `concept_ID` — that is the GraphQL input shape
    // @cap-js/graphql generates for a managed to-one.
    const { status, json } = await gql(
      `mutation { KnowledgeGraphService { ConceptAliases { create(input: [{ concept: { ID: "${TEST_ID}" }, alias: "InjectedAlias" }]) { ID } } } }`,
    );
    writeRefused(status, json, { entity: 'ConceptAliases', op: 'create' });
    expect(authCodes(json)).toContain('403'); // specifically our service-layer guard

    const { ConceptAliases } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(ConceptAliases).columns('ID').where({ alias: 'InjectedAlias' });
    expect(row).toBeFalsy(); // NOT created
  });
});

describe('#1230 — anonymous reads remain unaffected (no regression)', () => {
  it('anonymous PublishedConcepts read still returns 200 with no auth error', async () => {
    const { status, json } = await gql(
      `{ KnowledgeGraphService { PublishedConcepts { totalCount } } }`,
    );
    expect(status).toBe(200);
    expect(authCodes(json)).toHaveLength(0);
  });
});
