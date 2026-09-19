// test/unit/kg-concepts-update-guard.test.js
// Smoke tests for the writable surface of /graph/Concepts.
//
// Only `name` and `description` are admin-editable (allowlist in
// srv/knowledge-graph-service.js). The Fiori Elements admin UI relies on
// @Common.FieldControl: #ReadOnly to keep the other fields uneditable; the
// service's before('UPDATE','Concepts') guard is the defense-in-depth fallback.
//
// LIMITATION: We test the positive path here (admin PATCH of name/description
// succeeds end-to-end). Anonymous PATCH is covered by the dedicated
// kg-concepts-write-guard.test.js suite. Negative-path testing FOR THE
// FIELD ALLOWLIST (PATCH of slug/status/extraction returns 403) remains
// harder than it looks:
//   - Over OData PATCH: the FieldControl metadata strips read-only fields
//     before the before-handler runs, so the request silently no-ops.
//   - Programmatic srv.run(UPDATE(...)): in @sap/cds 8 the before-handler
//     does not fire for direct CQL routed through the service (handlers
//     only run on OData/REST events); the UPDATE bypasses the guard.
// TODO(PR 7+): exercise the negative path either via a hybrid test (real
// HANA + raw HTTP body forging the read-only fields past the OData adapter)
// or via a unit test that invokes the handler function directly with a
// crafted req object.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Service is gated by KNOWLEDGE_GRAPH_ENABLED=true (feature flag at
// srv/knowledge-graph-service.js ~line 438). Must be set BEFORE cds.test()
// boots the service or every request returns 503.
process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

const TEST_ID = 'C0000001-0000-0000-0000-000000000001';

beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Concepts } = cds.entities('com.sap.developers.ims');
  await db.run(DELETE.from(Concepts).where({ ID: TEST_ID }));
  await db.run(INSERT.into(Concepts).entries([{
    ID: TEST_ID,
    slug: 'kg-test-concept-guard',
    name: 'Original Name',
    description: 'Original description',
    status: 'ACTIVE',
    extractionCount: 7,
  }]));
});

describe('PATCH /graph/Concepts — editable surface', () => {
  it('PATCH name succeeds and persists', async () => {
    const res = await project.patch(
      `/graph/Concepts(${TEST_ID})`,
      { name: 'Updated Name' },
      adminAuth,
    );
    expect([200, 204]).toContain(res.status);

    const { Concepts } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(Concepts).columns('name').where({ ID: TEST_ID });
    expect(row.name).toBe('Updated Name');
  });

  it('PATCH description succeeds, persists, and auto-approves the definition (#2426)', async () => {
    const res = await project.patch(
      `/graph/Concepts(${TEST_ID})`,
      { description: 'New description' },
      adminAuth,
    );
    expect([200, 204]).toContain(res.status);

    const { Concepts } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(Concepts)
      .columns('description', 'descriptionStatus', 'descriptionReviewedAt', 'descriptionReviewedBy')
      .where({ ID: TEST_ID });
    expect(row.description).toBe('New description');
    // A hand-edit IS the review: status flips to APPROVED and audit is stamped.
    expect(row.descriptionStatus).toBe('APPROVED');
    expect(row.descriptionReviewedAt).toBeTruthy();
    expect(row.descriptionReviewedBy).toBeTruthy();
  });

  it('PATCH descriptionStatus=APPROVED stamps audit; client cannot set audit fields (#2426)', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    // Reset to DRAFT + clear audit.
    await UPDATE(Concepts)
      .set({ descriptionStatus: 'DRAFT', descriptionReviewedAt: null, descriptionReviewedBy: null })
      .where({ ID: TEST_ID });

    const res = await project.patch(
      `/graph/Concepts(${TEST_ID})`,
      { descriptionStatus: 'APPROVED' },
      adminAuth,
    );
    expect([200, 204]).toContain(res.status);
    const row = await SELECT.one.from(Concepts)
      .columns('descriptionStatus', 'descriptionReviewedAt', 'descriptionReviewedBy')
      .where({ ID: TEST_ID });
    expect(row.descriptionStatus).toBe('APPROVED');
    expect(row.descriptionReviewedAt).toBeTruthy();
    expect(row.descriptionReviewedBy).toBeTruthy();

    // The audit fields are @Common.FieldControl:#ReadOnly, so the OData
    // adapter strips a client-supplied value before the handler runs — a
    // forged descriptionReviewedBy is a silent no-op, not a persisted value.
    // (The service guard also rejects it on the programmatic path.)
    const before = await SELECT.one.from(Concepts).columns('descriptionReviewedBy').where({ ID: TEST_ID });
    const rej = await project.patch(
      `/graph/Concepts(${TEST_ID})`,
      { descriptionReviewedBy: 'forged@evil.com' },
      { ...adminAuth, validateStatus: () => true },
    );
    expect([200, 204]).toContain(rej.status);
    const after = await SELECT.one.from(Concepts).columns('descriptionReviewedBy').where({ ID: TEST_ID });
    expect(after.descriptionReviewedBy).toBe(before.descriptionReviewedBy);
    expect(after.descriptionReviewedBy).not.toBe('forged@evil.com');
  });

  it('PATCH name to null succeeds (clearing allowed for editable field)', async () => {
    const res = await project.patch(
      `/graph/Concepts(${TEST_ID})`,
      { name: null },
      adminAuth,
    );
    expect([200, 204]).toContain(res.status);

    const { Concepts } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(Concepts).columns('name').where({ ID: TEST_ID });
    expect(row.name).toBeNull();
  });

  it('PATCH slug is silently no-op (FieldControl#ReadOnly strips it at OData)', async () => {
    // Persist a known starting slug.
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await UPDATE(Concepts).set({ slug: 'kg-test-concept-guard' }).where({ ID: TEST_ID });

    // PATCH attempts a slug mutation. Returns 200/204; OData strips slug.
    const res = await project.patch(
      `/graph/Concepts(${TEST_ID})`,
      { slug: 'attempted-mutation' },
      { ...adminAuth, validateStatus: () => true },
    );
    expect([200, 204]).toContain(res.status);

    // Slug is unchanged — read-only metadata held.
    const row = await SELECT.one.from(Concepts).columns('slug').where({ ID: TEST_ID });
    expect(row.slug).toBe('kg-test-concept-guard');
  });
});
