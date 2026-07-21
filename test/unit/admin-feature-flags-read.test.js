// test/unit/admin-feature-flags-read.test.js
//
// Regression test for the on('READ','FeatureFlags') handler in srv/admin-service.js.
// FeatureFlags is a @cds.persistence.skip entity synthesized from the static
// feature-flag registry. The handler previously returned the whole array and
// ignored req.query, which broke the FE ObjectPage (a keyed read
// `FeatureFlags(key='X')` returned every row → FE rendered row 0 for every
// selection) and could truncate the ListReport under $skip/$top paging.
//
// Auth: username='admin', password='admin' (mocked auth convention, matches
//       test/unit/admin-kg-community-coverage-read.test.js).

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

// A known-present key that is NOT the first registry entry — proves the keyed
// read filters rather than returning row 0.
const TARGET_KEY = 'ChatSettings.kgPathBetweenEnabled';

describe('on(READ, FeatureFlags) is request-aware', () => {
  it('lists all registry flags including kgPathBetweenEnabled', async () => {
    const res = await project.get('/admin/FeatureFlags', ADMIN_AUTH);
    expect(res.status).toBe(200);
    const rows = res.data.value;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(20);
    const keys = rows.map((r) => r.key);
    expect(keys).toContain(TARGET_KEY);
  });

  it('keyed read returns the requested flag, not the first row', async () => {
    // The ObjectPage navigation FE performs: FeatureFlags(key='...').
    const res = await project.get(
      `/admin/FeatureFlags(key='${encodeURIComponent(TARGET_KEY)}')`,
      ADMIN_AUTH
    );
    expect(res.status).toBe(200);
    expect(res.data.key).toBe(TARGET_KEY);
    expect(res.data.label).toBe('KG learning-path tool');
  });

  it('$filter on key returns exactly the matching flag', async () => {
    const res = await project.get(
      `/admin/FeatureFlags?$filter=key eq '${TARGET_KEY}'`,
      ADMIN_AUTH
    );
    expect(res.status).toBe(200);
    const rows = res.data.value;
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(TARGET_KEY);
  });

  it('honors $top/$skip paging windows', async () => {
    const all = (await project.get('/admin/FeatureFlags', ADMIN_AUTH)).data.value;
    const page = await project.get('/admin/FeatureFlags?$skip=2&$top=3', ADMIN_AUTH);
    expect(page.status).toBe(200);
    const rows = page.data.value;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.key)).toEqual(all.slice(2, 5).map((r) => r.key));
  });

  it('$count=true reflects the full total, not the page size', async () => {
    const res = await project.get('/admin/FeatureFlags?$count=true&$top=5', ADMIN_AUTH);
    expect(res.status).toBe(200);
    expect(res.data.value).toHaveLength(5);
    expect(res.data['@odata.count']).toBeGreaterThan(20);
  });
});
