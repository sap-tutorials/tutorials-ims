// srv/__tests__/search-visibility.test.js
// Task 3: SearchableItems view must only return LISTED (or null) tutorials (#3099)
// TDD: write failing test first, then add WHERE filter to db/views.cds.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('SearchableItems visibility filter', () => {
  let SearchableItems, Tutorials;

  // Use high legacy IDs unlikely to collide with other test suites.
  const TUT_LISTED     = 99521;
  const TUT_UNLISTED   = 99522;
  const TUT_ROLE_GATED = 99523;
  const TUT_NULL_VIS   = 99524; // no visibility set → simulate pre-activation rows

  beforeAll(async () => {
    ({ SearchableItems, Tutorials } = cds.entities('com.sap.developers.ims'));

    // ---- seed four tutorials with distinct visibility ----
    await INSERT.into(Tutorials).entries([
      { ID: cds.utils.uuid(), legacyId: TUT_LISTED,     slug: 'srch-vis-listed',     status: 'ACTIVE', visibility: 'LISTED' },
      { ID: cds.utils.uuid(), legacyId: TUT_UNLISTED,   slug: 'srch-vis-unlisted',   status: 'ACTIVE', visibility: 'UNLISTED' },
      { ID: cds.utils.uuid(), legacyId: TUT_ROLE_GATED, slug: 'srch-vis-role-gated', status: 'ACTIVE', visibility: 'ROLE_GATED' },
      { ID: cds.utils.uuid(), legacyId: TUT_NULL_VIS,   slug: 'srch-vis-null',       status: 'ACTIVE', visibility: null }
    ]);
  });

  afterAll(async () => {
    await DELETE.from(Tutorials).where({
      legacyId: { in: [TUT_LISTED, TUT_UNLISTED, TUT_ROLE_GATED, TUT_NULL_VIS] }
    });
  });

  it('LISTED tutorial appears in SearchableItems', async () => {
    const rows = await SELECT.from(SearchableItems).where({ taskType: 'TUTORIAL', slug: 'srch-vis-listed' });
    expect(rows).toHaveLength(1);
  });

  it('UNLISTED tutorial does NOT appear in SearchableItems', async () => {
    const rows = await SELECT.from(SearchableItems).where({ taskType: 'TUTORIAL', slug: 'srch-vis-unlisted' });
    expect(rows).toHaveLength(0);
  });

  it('ROLE_GATED tutorial does NOT appear in SearchableItems', async () => {
    const rows = await SELECT.from(SearchableItems).where({ taskType: 'TUTORIAL', slug: 'srch-vis-role-gated' });
    expect(rows).toHaveLength(0);
  });

  it('null-visibility tutorial appears in SearchableItems (pre-activation rows not hidden)', async () => {
    const rows = await SELECT.from(SearchableItems).where({ taskType: 'TUTORIAL', slug: 'srch-vis-null' });
    expect(rows).toHaveLength(1);
  });
});
