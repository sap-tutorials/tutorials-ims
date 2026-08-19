// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

// Minimal valid puzzle payload: a 1x1 white-cell grid is enough to mount.
const LAYOUT = JSON.stringify({
  rows: 1, cols: 1,
  grid: [[{ black: false, number: 1 }]],
  clues: {},
});

function stubFetch(intro: string) {
  const fn = vi.fn(async (url: string) => {
    if (String(url).includes('/Puzzles')) {
      return {
        ok: true,
        json: async () => ({ value: [{ title: 'Test Puzzle', intro, layout: LAYOUT }] }),
      } as any;
    }
    // /auth/user probe → treat as anonymous
    return { ok: false } as any;
  });
  vi.stubGlobal('fetch', fn as any);
  return fn;
}

afterEach(() => vi.restoreAllMocks());

describe('puzzle intro (issue #1911)', () => {
  it('renders the author-maintained intro under the title', async () => {
    stubFetch('Solve across and down. See [how to play](https://example.com).');
    const w = mount(App, { props: { slug: 'test-puzzle', apiUrl: '/puzzle-api' } });
    await flushPromises();
    const intro = w.find('.puzzle-intro');
    expect(intro.exists()).toBe(true);
    expect(intro.text()).toContain('how to play');
  });

  it('renders no intro block when intro is empty', async () => {
    stubFetch('');
    const w = mount(App, { props: { slug: 'test-puzzle', apiUrl: '/puzzle-api' } });
    await flushPromises();
    expect(w.find('.puzzle-intro').exists()).toBe(false);
  });

  it('requests the intro column in the OData $select', async () => {
    const fn = stubFetch('hi');
    mount(App, { props: { slug: 'test-puzzle', apiUrl: '/puzzle-api' } });
    await flushPromises();
    const puzzleCall = fn.mock.calls.find(c => String(c[0]).includes('/Puzzles'));
    expect(puzzleCall).toBeTruthy();
    expect(String(puzzleCall![0])).toContain('$select=layout,title,intro');
  });
});
