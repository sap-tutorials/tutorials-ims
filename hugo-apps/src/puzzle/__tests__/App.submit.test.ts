// @vitest-environment happy-dom
// Regression coverage for issue #2185: the puzzle "Submit" button was a dead
// stub (no @click, disabled until solved). This pins the "Check grades → Submit
// finalizes" flow: Submit stays disabled until Check confirms the grid, and
// clicking it records completion via postComplete + fires confetti.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { mount } from '@vue/test-utils';

// A 1x2 puzzle: cells (0,0) and (0,1), across slot answer "HI".
const LAYOUT = {
  grid: [[{ number: 1 }, {}]],
  clues: { 'A1': 'Greeting' },
};

vi.mock('../lib/server', () => ({
  probeAuth: vi.fn().mockResolvedValue(true),
  buildCheckEntries: vi.fn().mockReturnValue([{ id: 'A1', text: 'HI' }]),
  buildCellStatus: vi.fn().mockReturnValue({ '0,0': 'correct', '0,1': 'correct' }),
  postCheck: vi.fn().mockResolvedValue({ complete: true, cells: [] }),
  fetchProgress: vi.fn().mockResolvedValue({ filledGrid: null, completed: false }),
  postSaveProgress: vi.fn().mockResolvedValue(undefined),
  postComplete: vi.fn().mockResolvedValue(undefined),
  postResetProgress: vi.fn().mockResolvedValue(undefined),
}));

// canvas-confetti is dynamically imported inside the component; stub it so the
// import resolves in the test environment without drawing to a real canvas.
vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

// The puzzle layout is fetched via global fetch (OData). Return our tiny layout.
beforeEach(() => {
  vi.clearAllMocks();   // reset call history between tests (module mocks persist otherwise)
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ value: [{ layout: JSON.stringify(LAYOUT), title: 'T', intro: '' }] }),
  }) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

import App from '../App.vue';
import { postCheck, postComplete, fetchProgress } from '../lib/server';

function submitBtn(w: ReturnType<typeof mount>) {
  return w.findAll('button').find((b) => b.text().startsWith('Submit') || b.text().startsWith('Submitted'))!;
}

describe('puzzle Submit finalizer (#2185)', () => {
  it('keeps Submit disabled before the grid is checked complete', async () => {
    const w = mount(App, { props: { slug: 'p', apiUrl: '/puzzle-api' } });
    await flushPromises();
    expect(submitBtn(w).attributes('disabled')).toBeDefined();
  });

  it('does NOT record completion on Check — only enables Submit', async () => {
    const w = mount(App, { props: { slug: 'p', apiUrl: '/puzzle-api' } });
    await flushPromises();
    // fill both cells
    w.vm.answers = { '0,0': 'H', '0,1': 'I' };
    await w.vm.checkPuzzle();
    await flushPromises();
    expect(vi.mocked(postCheck)).toHaveBeenCalled();
    expect(vi.mocked(postComplete)).not.toHaveBeenCalled();   // completion deferred to Submit
    expect(submitBtn(w).attributes('disabled')).toBeUndefined(); // now enabled
  });

  it('records completion + shows Submitted when Submit is clicked', async () => {
    const w = mount(App, { props: { slug: 'p', apiUrl: '/puzzle-api' } });
    await flushPromises();
    w.vm.answers = { '0,0': 'H', '0,1': 'I' };
    await w.vm.checkPuzzle();
    await flushPromises();
    await submitBtn(w).trigger('click');
    await flushPromises();
    expect(vi.mocked(postComplete)).toHaveBeenCalledWith('/puzzle-api', 'p');
    expect(submitBtn(w).text()).toContain('Submitted');
    expect(submitBtn(w).attributes('disabled')).toBeDefined(); // no double-submit
  });

  it('shows Submitted on load when the server already recorded completion', async () => {
    vi.mocked(fetchProgress).mockResolvedValueOnce({ filledGrid: JSON.stringify({ '0,0': 'H', '0,1': 'I' }), completed: true } as any);
    const w = mount(App, { props: { slug: 'p', apiUrl: '/puzzle-api' } });
    await flushPromises();
    expect(submitBtn(w).text()).toContain('Submitted');
    expect(vi.mocked(postComplete)).not.toHaveBeenCalled(); // already recorded; don't re-post
  });
});
