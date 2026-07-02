// #890 — AuthorService.rebuildContent must verify the caller owns the tutorial.
// Without the ownership check, any user with the Tutorial.Author scope could
// queue an expensive rebuild (GH Actions minutes + dispatch quota) against
// any other author's tutorial by ID.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import cds from '@sap/cds';

// credstore.js is lazily imported by rebuild-trigger.js. Mock so we don't
// need a real BTP binding — same pattern as author-service-rebuild.test.js.
vi.mock('../../srv/lib/credstore.js', () => ({
  readSecret: vi.fn().mockResolvedValue(null),
}));

import { _resetForTests as resetRebuildTrigger } from '../../srv/lib/rebuild-trigger.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

let captured;
let mockDispatch;

beforeAll(() => {
  mockDispatch = vi.fn().mockImplementation(async (inputs) => {
    captured.push(inputs);
    return { status: 204 };
  });
  resetRebuildTrigger({ dispatchFn: mockDispatch, debounceMs: 5, token: 'test-token' });
});

beforeEach(async () => {
  captured = [];
  mockDispatch.mockClear();

  const { Users, Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TutorialMeta);
  await DELETE.from(Tutorials);
  await DELETE.from(Users);

  // `author` mock user resolves to sapId='author' via resolveUserSapId
  // (basic-auth fallback path). Seed matching Users rows so MyTutorialsView
  // can return the ownership-linked row.
  await INSERT.into(Users).entries([
    {
      ID: 'u-author', uuid: 'u-author',
      sapId: 'author', legacyId: 91001,
      email: 'author@test.example', displayName: 'Author',
    },
    {
      ID: 'u-other', uuid: 'u-other',
      sapId: 'other-sap', legacyId: 91002,
      email: 'other@test.example', displayName: 'Other',
    },
  ]);
  await INSERT.into(Tutorials).entries([
    {
      ID: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      slug: 'owned-by-author', title: 'Owned', status: 'ACTIVE',
      author_ID: 'u-author',
    },
    {
      ID: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      slug: 'owned-by-other', title: 'Other', status: 'ACTIVE',
      author_ID: 'u-other',
    },
  ]);
  await INSERT.into(TutorialMeta).entries([
    { ID: 'tm-1', tutorial_ID: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      owner: 'Author', ownerEmail: 'author@test.example' },
    { ID: 'tm-2', tutorial_ID: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      owner: 'Other', ownerEmail: 'other@test.example' },
  ]);
});

describe('#890 — AuthorService.rebuildContent ownership check', () => {
  it('returns 403 when the caller does not own the tutorial', async () => {
    const { POST } = project;
    const otherId = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';
    const res = await POST(
      `/author/Tutorials(${otherId})/AuthorService.rebuildContent`,
      {},
      { auth: { username: 'author', password: '' }, validateStatus: () => true }
    );
    expect(res.status).toBe(403);
    expect(String(res.data?.error?.message || '')).toMatch(/[Nn]ot the owner/);

    // And the expensive dispatch path must NOT have been invoked (30ms > 5ms debounce)
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toHaveLength(0);
  });

  it('proceeds when the caller owns the tutorial', async () => {
    const { POST } = project;
    const ownedId = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
    const res = await POST(
      `/author/Tutorials(${ownedId})/AuthorService.rebuildContent`,
      {},
      { auth: { username: 'author', password: '' }, validateStatus: () => true }
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ dispatched: true, slug: 'owned-by-author' });
  });
});
