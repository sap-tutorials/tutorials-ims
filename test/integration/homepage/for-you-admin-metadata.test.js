// test/integration/homepage/for-you-admin-metadata.test.js
//
// (#763 Task 18) Smoke-test that the @UI.LineItem and @UI.Facets annotations
// for HomepageForYouCandidatesAdmin reach the OData $metadata document.
//
// Auth: admin/admin (matches .cdsrc.json mock users).

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' }, validateStatus: () => true };

describe('HomepageForYouCandidatesAdmin OData metadata', () => {
  it('returns HTTP 200 for GET /admin/$metadata', async () => {
    const r = await project.get('/admin/$metadata', adminAuth);
    expect(r.status).toBe(200);
  });

  it('includes HomepageForYouCandidatesAdmin EntityType', async () => {
    const r = await project.get('/admin/$metadata', adminAuth);
    expect(r.status).toBe(200);
    expect(r.data).toContain('HomepageForYouCandidatesAdmin');
  });

  it('includes UI.LineItem annotation for HomepageForYouCandidatesAdmin', async () => {
    const r = await project.get('/admin/$metadata', adminAuth);
    const metadata = r.data;
    // The metadata XML contains the LineItem annotation term
    expect(metadata).toContain('UI.LineItem');
    expect(metadata).toContain('HomepageForYouCandidatesAdmin');
  });

  it('includes UI.Facets annotation for HomepageForYouCandidatesAdmin', async () => {
    const r = await project.get('/admin/$metadata', adminAuth);
    const metadata = r.data;
    expect(metadata).toContain('UI.Facets');
    // Both General and Personalization facet IDs should appear
    expect(metadata).toContain('MainFacet');
    expect(metadata).toContain('PersonalizationFacet');
  });
});
