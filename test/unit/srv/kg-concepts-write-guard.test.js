// test/unit/srv/kg-concepts-write-guard.test.js
//
// Defence-in-depth: with the service-level @requires dropped (Task 1),
// the Concepts UPDATE guard must imperatively reject non-admin writes.
// Otherwise an anonymous PATCH would slip into the guard and merely fail
// the field-allowlist check (with a 400, not a 403).

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Service is gated by KNOWLEDGE_GRAPH_ENABLED=true (feature flag at
// srv/knowledge-graph-service.js). Must be set BEFORE cds.test()
// boots the service or every request returns 503.
process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';

const project = cds.test('serve', '--project', '.', '--in-memory');

const TEST_ID = 'C0000002-0000-0000-0000-000000000002';

beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Concepts } = cds.entities('com.sap.developers.ims');
  await db.run(DELETE.from(Concepts).where({ ID: TEST_ID }));
  await db.run(INSERT.into(Concepts).entries([{
    ID: TEST_ID,
    slug: 'kg-test-concept-write-guard',
    name: 'Original Name',
    description: 'Original description',
    status: 'ACTIVE',
    extractionCount: 1,
  }]));
});

describe('Concepts UPDATE guard — admin scope required', () => {
  it('anonymous PATCH /graph/Concepts(...) returns 403', async () => {
    // No `auth` option = anonymous request. With the service-level
    // @requires dropped in Task 1, the imperative scope check in the
    // UPDATE before-handler is now the authoritative gate.
    const res = await project.patch(
      `/graph/Concepts(${TEST_ID})`,
      { description: 'pwn' },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(403);
  });

  it('authenticated non-admin PATCH returns 403', async () => {
    // Realistic threat model: a logged-in developer (no KnowledgeGraph.Admin
    // scope) attempting to write the Concepts surface. Must be rejected by
    // the imperative guard, same as anonymous.
    const res = await project.patch(`/graph/Concepts(${TEST_ID})`, { description: 'pwn' }, {
      auth: { username: 'developer', password: 'developer' },
      validateStatus: () => true,
    });
    expect(res.status).toBe(403);
  });
});
