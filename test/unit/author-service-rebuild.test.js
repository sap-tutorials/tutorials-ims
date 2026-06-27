// test/unit/author-service-rebuild.test.js
//
// Task 6 (#617) — AuthorService.rebuildContent handler.
//
// Mock strategy note: vi.mock cannot intercept CDS-runtime-loaded modules
// (see test/unit/admin-secret-value-handlers.test.js header comment). We
// therefore inject a captured dispatchFn via rebuild-trigger's _resetForTests
// hook and assert against the captured inputs, mirroring the pattern in
// test/unit/rebuild-trigger.test.js.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';

// credstore.js is imported lazily by rebuild-trigger.js inside getDispatchToken.
// Mock it so the unit test doesn't need a real BTP binding.
vi.mock('../../srv/lib/credstore.js', () => ({
  readSecret: vi.fn().mockResolvedValue(null),
}));

import { _resetForTests as resetRebuildTrigger } from '../../srv/lib/rebuild-trigger.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

let captured;
let mockDispatch;

beforeAll(() => {
  // Seed a fake dispatchFn so we can capture inputs without hitting GitHub.
  // debounceMs=5 keeps the test fast; token is non-null so getDispatchToken
  // resolves and dispatchFn actually fires.
  mockDispatch = vi.fn().mockImplementation(async (inputs) => {
    captured.push(inputs);
    return { status: 204 };
  });
  resetRebuildTrigger({ dispatchFn: mockDispatch, debounceMs: 5, token: 'test-token' });
});

beforeEach(() => {
  captured = [];
  mockDispatch.mockClear();
});

describe('AuthorService.rebuildContent', () => {
  it('rejects unauthenticated callers (401 or 403)', async () => {
    const res = await fetch(
      `${project.url}/author/Tutorials(11111111-1111-1111-1111-111111111111)/AuthorService.rebuildContent`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    );
    expect([401, 403]).toContain(res.status);
  });

  it('dispatches with reason="author-ui:rebuild-button:<user>" for a Tutorial.Author', async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await DELETE.from(Tutorials).where({ ID: id });
    await INSERT.into(Tutorials).entries({ ID: id, slug: 'auth-test', title: 'A', status: 'ACTIVE' });

    // The `POST` returned by cds.test() resolves to axios; pass auth via the
    // axios second-arg-config to authenticate as the seeded `author` mock user.
    const { POST } = project;
    const res = await POST(
      `/author/Tutorials(${id})/AuthorService.rebuildContent`,
      {},
      { auth: { username: 'author', password: '' } }
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ dispatched: true, slug: 'auth-test' });

    // Wait for the 5ms debounce window so dispatchFn fires.
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      'trigger-source': expect.stringMatching(/^author-ui:rebuild-button:/),
      mode: 'slug-targeted',
      slugs: 'auth-test',
    });
  });
});
