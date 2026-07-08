// test/unit/kg-concepts-is-published-filter.test.js
//
// #1080 — coverage for the virtual `isPublished` field on
// KnowledgeGraphService.Concepts and the paired
// `publishAllConcepts` bulk action.
//
// Split into two describes:
//   1) Pure `rewriteIsPublishedFilter` — no server, no DB. Verifies the
//      CQN mutation is correct for both eq/ne, true/false, and nested
//      xpr groups. This is the load-bearing invariant: virtual fields
//      have no SQL column, so the pushed-down WHERE MUST target
//      publishedAt or HANA will reject with "column not found".
//   2) End-to-end over `cds.test('serve')` in-memory SQLite. Seeds three
//      rows (one published, one not, one non-active), exercises the
//      OData filter, and confirms row shape includes `isPublished`.
//      Also exercises publishAllConcepts and verifies row counts.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { rewriteIsPublishedFilter } from '../../srv/knowledge-graph-service.js';

// KG service is feature-flagged; must set BEFORE cds.test() boots or every
// request returns 503. Same guard as kg-concepts-update-guard.test.js.
process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';

describe('rewriteIsPublishedFilter — pure CQN rewrite', () => {
  it('rewrites `isPublished eq true` to `publishedAt != null`', () => {
    const where = [{ ref: ['isPublished'] }, 'eq', { val: true }];
    rewriteIsPublishedFilter(where);
    expect(where).toEqual([
      { ref: ['publishedAt'] }, '!=', { val: null },
    ]);
  });

  it('rewrites `isPublished eq false` to `publishedAt = null`', () => {
    const where = [{ ref: ['isPublished'] }, 'eq', { val: false }];
    rewriteIsPublishedFilter(where);
    expect(where).toEqual([
      { ref: ['publishedAt'] }, '=', { val: null },
    ]);
  });

  it('rewrites `isPublished ne true` to `publishedAt = null`', () => {
    const where = [{ ref: ['isPublished'] }, 'ne', { val: true }];
    rewriteIsPublishedFilter(where);
    expect(where).toEqual([
      { ref: ['publishedAt'] }, '=', { val: null },
    ]);
  });

  it('rewrites `isPublished ne false` to `publishedAt != null`', () => {
    const where = [{ ref: ['isPublished'] }, 'ne', { val: false }];
    rewriteIsPublishedFilter(where);
    expect(where).toEqual([
      { ref: ['publishedAt'] }, '!=', { val: null },
    ]);
  });

  it('leaves other predicates alone', () => {
    const where = [
      { ref: ['status'] }, 'eq', { val: 'ACTIVE' },
      'and',
      { ref: ['slug'] }, 'like', { val: '%cap%' },
    ];
    const snapshot = JSON.parse(JSON.stringify(where));
    rewriteIsPublishedFilter(where);
    expect(where).toEqual(snapshot);
  });

  it('rewrites within a nested xpr group (FE-composed filter)', () => {
    // (status eq 'ACTIVE' and isPublished eq false)
    const where = [
      {
        xpr: [
          { ref: ['status'] }, 'eq', { val: 'ACTIVE' },
          'and',
          { ref: ['isPublished'] }, 'eq', { val: false },
        ],
      },
    ];
    rewriteIsPublishedFilter(where);
    expect(where[0].xpr).toEqual([
      { ref: ['status'] }, 'eq', { val: 'ACTIVE' },
      'and',
      { ref: ['publishedAt'] }, '=', { val: null },
    ]);
  });

  it('leaves `isPublished eq null` alone (defensive — no boolean rhs)', () => {
    // The FE FilterBar only emits boolean literals for a Boolean field,
    // but a hand-crafted URL like `?$filter=isPublished eq null` should
    // NOT be silently rewritten — let the DB return column-not-found.
    const where = [{ ref: ['isPublished'] }, 'eq', { val: null }];
    const snapshot = JSON.parse(JSON.stringify(where));
    rewriteIsPublishedFilter(where);
    expect(where).toEqual(snapshot);
  });

  it('handles combined AND filter across virtual and real fields', () => {
    // `status eq 'ACTIVE' and isPublished eq false` at the top level.
    const where = [
      { ref: ['status'] }, 'eq', { val: 'ACTIVE' },
      'and',
      { ref: ['isPublished'] }, 'eq', { val: false },
    ];
    rewriteIsPublishedFilter(where);
    expect(where).toEqual([
      { ref: ['status'] }, 'eq', { val: 'ACTIVE' },
      'and',
      { ref: ['publishedAt'] }, '=', { val: null },
    ]);
  });

  it('is safe on empty / non-array input', () => {
    expect(() => rewriteIsPublishedFilter([])).not.toThrow();
    expect(() => rewriteIsPublishedFilter(undefined)).not.toThrow();
    expect(() => rewriteIsPublishedFilter(null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// End-to-end over in-memory SQLite
// ---------------------------------------------------------------------------

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

const PUB_ID = 'C0001080-0000-0000-0000-000000000001';
const UNPUB_ID = 'C0001080-0000-0000-0000-000000000002';
const VETOED_ID = 'C0001080-0000-0000-0000-000000000003';

async function seed() {
  const { Concepts } = cds.entities('com.sap.developers.ims');
  const db = await cds.connect.to('db');
  await db.run(DELETE.from(Concepts).where({ ID: { in: [PUB_ID, UNPUB_ID, VETOED_ID] } }));
  await db.run(INSERT.into(Concepts).entries([
    {
      ID: PUB_ID,
      slug: 'kg-1080-published',
      name: '1080 Published',
      status: 'ACTIVE',
      publishedAt: '2026-07-08T00:00:00.000Z',
      publishedBy: 'seed',
    },
    {
      ID: UNPUB_ID,
      slug: 'kg-1080-unpublished',
      name: '1080 Unpublished',
      status: 'ACTIVE',
      publishedAt: null,
    },
    {
      ID: VETOED_ID,
      slug: 'kg-1080-vetoed',
      name: '1080 Vetoed',
      status: 'VETOED',
      publishedAt: null,
    },
  ]));
}

describe('/graph/Concepts?$filter=isPublished — E2E over in-memory SQLite', () => {
  beforeAll(async () => {
    await seed();
  });

  it('after-READ stamps isPublished=true when publishedAt is set', async () => {
    const res = await project.get(
      `/graph/Concepts(${PUB_ID})?$select=ID,slug,publishedAt,isPublished`,
      adminAuth,
    );
    expect(res.status).toBe(200);
    expect(res.data.isPublished).toBe(true);
    expect(res.data.publishedAt).not.toBeNull();
  });

  it('after-READ stamps isPublished=false when publishedAt is null', async () => {
    const res = await project.get(
      `/graph/Concepts(${UNPUB_ID})?$select=ID,slug,publishedAt,isPublished`,
      adminAuth,
    );
    expect(res.status).toBe(200);
    expect(res.data.isPublished).toBe(false);
    expect(res.data.publishedAt).toBeNull();
  });

  it('before-READ pushes $filter=isPublished eq false → publishedAt IS NULL', async () => {
    const res = await project.get(
      `/graph/Concepts?$filter=isPublished eq false&$select=ID,slug&$top=100`,
      adminAuth,
    );
    expect(res.status).toBe(200);
    const ids = (res.data.value ?? []).map((r) => r.ID);
    // UNPUB_ID (ACTIVE + null) AND VETOED_ID (VETOED + null) both match:
    // the virtual field is agnostic to `status`. Combining with status
    // is the admin's job — the filter here is exactly publishedAt IS NULL.
    expect(ids).toContain(UNPUB_ID);
    expect(ids).toContain(VETOED_ID);
    expect(ids).not.toContain(PUB_ID);
  });

  it('before-READ pushes $filter=isPublished eq true → publishedAt IS NOT NULL', async () => {
    const res = await project.get(
      `/graph/Concepts?$filter=isPublished eq true&$select=ID,slug&$top=100`,
      adminAuth,
    );
    expect(res.status).toBe(200);
    const ids = (res.data.value ?? []).map((r) => r.ID);
    expect(ids).toContain(PUB_ID);
    expect(ids).not.toContain(UNPUB_ID);
    expect(ids).not.toContain(VETOED_ID);
  });

  it('combined status + isPublished filter works (admin curation workflow)', async () => {
    // The realistic admin filter: "ACTIVE concepts that aren't published yet".
    const res = await project.get(
      `/graph/Concepts?$filter=status eq 'ACTIVE' and isPublished eq false&$select=ID,slug&$top=100`,
      adminAuth,
    );
    expect(res.status).toBe(200);
    const ids = (res.data.value ?? []).map((r) => r.ID);
    expect(ids).toContain(UNPUB_ID);
    expect(ids).not.toContain(PUB_ID);      // filtered by isPublished
    expect(ids).not.toContain(VETOED_ID);   // filtered by status
  });
});

describe('/graph/publishAllConcepts — bulk publish action', () => {
  beforeEach(async () => {
    await seed();
  });

  it('publishes every ACTIVE concept whose publishedAt is null', async () => {
    const res = await project.post(
      '/graph/publishAllConcepts',
      {},
      adminAuth,
    );
    expect(res.status).toBe(200);
    expect(res.data.publishedCount).toBeGreaterThanOrEqual(1);

    // Verify each seeded row's final state.
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const pub = await SELECT.one.from(Concepts).columns('publishedAt').where({ ID: PUB_ID });
    const unpub = await SELECT.one.from(Concepts).columns('publishedAt', 'publishedBy').where({ ID: UNPUB_ID });
    const vetoed = await SELECT.one.from(Concepts).columns('publishedAt').where({ ID: VETOED_ID });

    // Already-published: publishedAt is unchanged (not clobbered).
    expect(pub.publishedAt).toBeTruthy();

    // Was ACTIVE + null: NOW published, publishedBy stamped.
    expect(unpub.publishedAt).toBeTruthy();
    expect(unpub.publishedBy).toBe('admin');

    // VETOED: NOT published — status='ACTIVE' filter excluded it.
    expect(vetoed.publishedAt).toBeNull();
  });

  it('is idempotent — second invocation publishes 0 additional rows', async () => {
    await project.post('/graph/publishAllConcepts', {}, adminAuth);
    const second = await project.post('/graph/publishAllConcepts', {}, adminAuth);
    expect(second.status).toBe(200);
    // VETOED row is the only remaining unpublished, but its status
    // excludes it — so 0 additional rows on the second pass.
    expect(second.data.publishedCount).toBe(0);
  });
});
