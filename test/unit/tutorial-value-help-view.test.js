// test/unit/tutorial-value-help-view.test.js
//
// Leg-A provider view predicate gate (#cross-container).
//
// The physical TUTORIAL_VALUE_HELP_V1.hdbview is a HANA artifact and is not
// present in the in-memory SQLite unit DB. This test proves the filter
// semantics by running the view's exact WHERE predicate
//   "status = 'ACTIVE' OR status IS NULL"
// against the CDS entity `com.sap.developers.ims.Tutorials` directly.
//
// Three canonical rows are seeded:
//   1. ACTIVE  → must appear in results
//   2. NULL status (legacy row, no status set) → must appear in results
//   3. INACTIVE → must never appear in results

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

// Well-known UUIDs so we can clean up precisely and avoid collisions
// with rows seeded by other test files.
const ID_ACTIVE   = 'a1000000-cccc-0000-0000-000000000001';
const ID_NULL     = 'a1000000-cccc-0000-0000-000000000002';
const ID_INACTIVE = 'a1000000-cccc-0000-0000-000000000003';

describe('TUTORIAL_VALUE_HELP_V1 predicate semantics', () => {
  let Tutorials;

  beforeAll(() => {
    ({ Tutorials } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    // Remove only our test rows — leave other tests' data untouched.
    await DELETE.from(Tutorials).where({ ID: { in: [ID_ACTIVE, ID_NULL, ID_INACTIVE] } });

    // Seed the three discriminating rows.
    await INSERT.into(Tutorials).entries([
      { ID: ID_ACTIVE,   slug: 'tvh-active',   title: 'Active Tutorial',   status: 'ACTIVE',   primaryTag: 'software-product>sap-build' },
      { ID: ID_NULL,     slug: 'tvh-null',     title: 'No-Status Tutorial', status: null,       primaryTag: 'software-product>sap-build' },
      { ID: ID_INACTIVE, slug: 'tvh-inactive', title: 'Inactive Tutorial',  status: 'INACTIVE', primaryTag: 'software-product>sap-build' },
    ]);
  });

  it('includes ACTIVE and NULL-status rows, excludes INACTIVE', async () => {
    // Mirror the view's WHERE clause verbatim.
    const rows = await SELECT.from(Tutorials)
      .columns('ID', 'slug', 'title', 'primaryTag', 'status')
      .where(`status = 'ACTIVE' or status is null`);

    const ids = rows.map(r => r.ID);

    expect(ids).toContain(ID_ACTIVE);
    expect(ids).toContain(ID_NULL);
    expect(ids).not.toContain(ID_INACTIVE);
  });

  it('only INACTIVE rows are excluded — INACTIVE slug is never in the result set', async () => {
    const rows = await SELECT.from(Tutorials)
      .where(`status = 'ACTIVE' or status is null`);

    const slugs = rows.map(r => r.slug);
    expect(slugs).not.toContain('tvh-inactive');
  });

  it('a raw INACTIVE-only query returns one row — seeding is correct', async () => {
    // Sanity: the INACTIVE row genuinely exists; its absence from the
    // predicate query above is due to the filter, not a missing seed.
    const rows = await SELECT.from(Tutorials).where({ ID: ID_INACTIVE });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('INACTIVE');
  });

  it('view columns — exactly ID, slug, title, primaryTag are selectable', async () => {
    // Confirm the four columns the view exposes are present on the entity.
    const [row] = await SELECT.from(Tutorials)
      .columns('ID', 'slug', 'title', 'primaryTag')
      .where({ ID: ID_ACTIVE });

    expect(row).toHaveProperty('ID', ID_ACTIVE);
    expect(row).toHaveProperty('slug', 'tvh-active');
    expect(row).toHaveProperty('title', 'Active Tutorial');
    expect(row).toHaveProperty('primaryTag', 'software-product>sap-build');
  });
});
