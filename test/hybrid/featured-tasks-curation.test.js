// test/hybrid/featured-tasks-curation.test.js
// Task 6: value-help annotation + manifest bump.
//
// Verifies the featured curation workflow is end-to-end coherent:
//   (a) A curated TUTORIAL row flows through to getFeaturedPayload and changes the ETag.
//   (b) The @assert.unique.feature annotation is present on the compiled model.
//       Runtime enforcement on SQLite is not asserted — @assert.unique generates a
//       HANA UNIQUE INDEX (not a SQLite constraint). The structural annotation is the
//       correctness guarantee verifiable without HANA.
//
// FeaturedTasks is @odata.draft.enabled so writes go through the draft flow:
//   1. POST /admin/FeaturedTasks             → creates a draft (IsActiveEntity=false)
//   2. POST .../AdminService.draftActivate   → activates; before('CREATE') fires HERE
//   3. Read back from getFeaturedPayload(db) after resetFeaturedCache()
//
// taskType must be @UI.ReadOnly (not @readonly) — @readonly strips the field on
// draftActivate writes, leaving taskType=null and breaking resolveFeatured lookups.
//
// Uses in-memory SQLite — no HANA binding required.
// Stable legacy IDs well outside real-data range; cleaned up in afterAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { getFeaturedPayload, resetFeaturedCache } from '../../srv/lib/featured-resolve.js';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

const FEATURED_TUTORIAL_LEGACY_ID = 991001;

describe('featured-tasks curation (hybrid)', () => {
  // Active entity IDs created during the tests — collected for afterAll cleanup.
  const createdIDs = [];

  // Helper: POST draft + activate; returns activate response (status + data).
  // validateStatus allows 4xx without throwing so callers can assert the status.
  async function activateDraft(body) {
    const { status: draftStatus, data: draft } = await project.post(
      '/admin/FeaturedTasks',
      body,
      adminAuth
    );
    expect(draftStatus).toBe(201);
    const activateRes = await project.post(
      `/admin/FeaturedTasks(ID=${draft.ID},IsActiveEntity=false)/AdminService.draftActivate`,
      {},
      { ...adminAuth, validateStatus: () => true }
    );
    if (activateRes.status === 201) {
      createdIDs.push(activateRes.data.ID);
    } else {
      // draft not activated — delete the draft so it doesn't leak
      await project.delete(
        `/admin/FeaturedTasks(ID=${draft.ID},IsActiveEntity=false)`,
        adminAuth
      ).catch(() => {});
    }
    return activateRes;
  }

  beforeAll(async () => {
    // Seed a Tutorials row so getFeaturedPayload can resolve its slug.
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries({
      legacyId: FEATURED_TUTORIAL_LEGACY_ID,
      title:    '__TEST__ Featured Curation Tutorial',
      slug:     'test-featured-curation-tutorial',
      status:   'ACTIVE',
    });
  });

  afterAll(async () => {
    for (const id of createdIDs) {
      await project.delete(`/admin/FeaturedTasks(ID=${id},IsActiveEntity=true)`, adminAuth)
        .catch(() => {});
    }
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Tutorials).where({ legacyId: FEATURED_TUTORIAL_LEGACY_ID });
    resetFeaturedCache();
  });

  it('curated TUTORIAL flows to getFeaturedPayload and changes the ETag', async () => {
    const db = await cds.connect.to('db');

    // Capture ETag before curating anything.
    resetFeaturedCache();
    const before = await getFeaturedPayload(db);

    // Curate the seeded tutorial via the draft flow.
    const res = await activateDraft({
      taskLegacyId: FEATURED_TUTORIAL_LEGACY_ID,
      taskType:     'TUTORIAL',
    });
    expect(res.status).toBe(201);

    // Bust the cache (simulates the after-save hook registered in admin-service.js)
    // and re-read.
    resetFeaturedCache();
    const after = await getFeaturedPayload(db);

    expect(after.etag).not.toBe(before.etag);
    expect(
      after.featured.some(
        f => f.slug === 'test-featured-curation-tutorial' && f.type === 'tutorial'
      )
    ).toBe(true);
  });

  it('@assert.unique.feature annotation is present on AdminService.FeaturedTasks', () => {
    // Runtime enforcement requires a HANA UNIQUE INDEX (not available on SQLite).
    // This structural test verifies the CDS annotation is correct in the compiled model,
    // which is what HANA will enforce in production.
    const { definitions } = cds.model;
    const ft = definitions['AdminService.FeaturedTasks'];
    expect(ft).toBeTruthy();
    const annotation = ft['@assert.unique.feature'];
    expect(Array.isArray(annotation)).toBe(true);
    const props = annotation.map(a => a['=']);
    expect(props).toContain('taskLegacyId');
    expect(props).toContain('taskType');
  });
});
