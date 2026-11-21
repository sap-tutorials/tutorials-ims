// srv/__tests__/build-catalog-visibility.test.js
// Task 4: /build/catalog feed must carry visibility on each tutorial entry and
//         must NOT filter out UNLISTED / ROLE_GATED tutorials (#3099).
// TDD: write failing test first (visibility undefined), then add the field.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('build-catalog visibility passthrough', () => {
  let Tutorials;

  // High legacy IDs unlikely to collide with other test suites.
  const TUT_LISTED     = 99531;
  const TUT_UNLISTED   = 99532;
  const TUT_ROLE_GATED = 99533;

  beforeAll(async () => {
    ({ Tutorials } = cds.entities('com.sap.developers.ims'));

    await INSERT.into(Tutorials).entries([
      { ID: cds.utils.uuid(), legacyId: TUT_LISTED,     slug: 'cat-vis-listed',     status: 'ACTIVE', visibility: 'LISTED' },
      { ID: cds.utils.uuid(), legacyId: TUT_UNLISTED,   slug: 'cat-vis-unlisted',   status: 'ACTIVE', visibility: 'UNLISTED' },
      { ID: cds.utils.uuid(), legacyId: TUT_ROLE_GATED, slug: 'cat-vis-role-gated', status: 'ACTIVE', visibility: 'ROLE_GATED' },
    ]);
  });

  afterAll(async () => {
    await DELETE.from(Tutorials).where({
      legacyId: { in: [TUT_LISTED, TUT_UNLISTED, TUT_ROLE_GATED] }
    });
  });

  it('UNLISTED tutorial IS present in /build/catalog tutorials list', async () => {
    const { data, status } = await project.get('/build/catalog', { validateStatus: () => true });
    expect(status).toBe(200);
    const slugs = (data.tutorials || []).map(t => t.slug);
    expect(slugs).toContain('cat-vis-unlisted');
  });

  it('ROLE_GATED tutorial IS present in /build/catalog tutorials list', async () => {
    const { data, status } = await project.get('/build/catalog', { validateStatus: () => true });
    expect(status).toBe(200);
    const slugs = (data.tutorials || []).map(t => t.slug);
    expect(slugs).toContain('cat-vis-role-gated');
  });

  it('LISTED tutorial carries visibility: "LISTED"', async () => {
    const { data, status } = await project.get('/build/catalog', { validateStatus: () => true });
    expect(status).toBe(200);
    const entry = (data.tutorials || []).find(t => t.slug === 'cat-vis-listed');
    expect(entry).toBeDefined();
    expect(entry.visibility).toBe('LISTED');
  });

  it('UNLISTED tutorial carries visibility: "UNLISTED"', async () => {
    const { data, status } = await project.get('/build/catalog', { validateStatus: () => true });
    expect(status).toBe(200);
    const entry = (data.tutorials || []).find(t => t.slug === 'cat-vis-unlisted');
    expect(entry).toBeDefined();
    expect(entry.visibility).toBe('UNLISTED');
  });

  it('ROLE_GATED tutorial carries visibility: "ROLE_GATED"', async () => {
    const { data, status } = await project.get('/build/catalog', { validateStatus: () => true });
    expect(status).toBe(200);
    const entry = (data.tutorials || []).find(t => t.slug === 'cat-vis-role-gated');
    expect(entry).toBeDefined();
    expect(entry.visibility).toBe('ROLE_GATED');
  });
});
