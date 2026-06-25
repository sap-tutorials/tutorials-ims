// @vitest-environment happy-dom
// hugo-apps/src/tutorial-reset/TutorialReset.test.ts
//
// Component-level tests for Task 20 of issue #600 (Tutorial Reset).
//
// Strategy mirrors the Validation island's test shape (PR #235):
//  - Mount with @vue/test-utils + happy-dom
//  - Stub fetch globally to drive the read (getProgress) and write
//    (resetTutorialProgress) paths deterministically
//  - Stub UI5 web components — they render as unknown elements in
//    happy-dom, which is fine for state-flow testing
//  - Use the component's defineExpose() refs to inspect reactive state
//    instead of leaning on DOM rendering of stubbed custom elements

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import TutorialReset from './TutorialReset.vue';

// ── Fetch mock helpers ────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;

function mockFetchResponse(body: object, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function setupFetch() {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
}

// ── Reload stub ───────────────────────────────────────────────────────
//
// Trap window.location.reload so the test runner doesn't actually try to
// reload the happy-dom window. We assert against the spy in the 200 branch.

let reloadSpy: ReturnType<typeof vi.fn>;

function setupReloadStub() {
  reloadSpy = vi.fn();
  // happy-dom's location is read-only at the top level; we override the
  // reload method directly which is the only path the component uses.
  Object.defineProperty(window.location, 'reload', {
    configurable: true,
    value: reloadSpy,
  });
}

// ── Step-count helper ─────────────────────────────────────────────────
//
// The component reads document.documentElement.dataset.stepCount on mount.
// Set it in each test that exercises the read path.

function setStepCount(n: number) {
  document.documentElement.dataset.stepCount = String(n);
}

function clearStepCount() {
  delete document.documentElement.dataset.stepCount;
}

// ── Setup / teardown ──────────────────────────────────────────────────

beforeEach(() => {
  setupFetch();
  setupReloadStub();
  clearStepCount();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearStepCount();
});

// ── Mount helper ──────────────────────────────────────────────────────

interface VmExposed {
  showReset: boolean;
  dialogOpen: boolean;
  submitting: boolean;
  errorMessage: string | null;
  openDialog: () => void;
  closeDialog: () => void;
  confirmReset: () => Promise<void>;
}

async function mountReset(slug: string = 'test-tutorial') {
  const wrapper = mount(TutorialReset, {
    props: { slug },
    attachTo: document.body,
    global: {
      stubs: {
        'ui5-button': true,
        'ui5-dialog': true,
        'ui5-message-strip': true,
      },
    },
  });
  // Let onMounted's fetch resolve before returning.
  await flushPromises();
  await wrapper.vm.$nextTick();
  return wrapper;
}

function getVm(wrapper: ReturnType<typeof mount>): VmExposed {
  return wrapper.vm as unknown as VmExposed;
}

// ─────────────────────────────────────────────────────────────────────
// Read path: getProgress on mount
// ─────────────────────────────────────────────────────────────────────

describe('TutorialReset.vue — mount: getProgress branch', () => {
  it('hides the reset button when progress is partial (completed < stepCount)', async () => {
    setStepCount(5);
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ completedSteps: [1, 2, 3] }));

    const wrapper = await mountReset();
    expect(getVm(wrapper).showReset).toBe(false);

    // Sanity: getProgress was the only fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/getProgress');
    expect(fetchMock.mock.calls[0][0]).toContain('slug=test-tutorial');
  });

  it('shows the reset button when progress is complete (completed === stepCount)', async () => {
    setStepCount(3);
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ completedSteps: [1, 2, 3] }));

    const wrapper = await mountReset();
    expect(getVm(wrapper).showReset).toBe(true);
  });

  it('keeps button hidden when getProgress returns non-OK', async () => {
    setStepCount(3);
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ error: 'unauthorized' }, 401));

    const wrapper = await mountReset();
    expect(getVm(wrapper).showReset).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Click → openDialog
// ─────────────────────────────────────────────────────────────────────

describe('TutorialReset.vue — openDialog', () => {
  it('opens the dialog when openDialog() is called', async () => {
    setStepCount(2);
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ completedSteps: [1, 2] }));

    const wrapper = await mountReset();
    const vm = getVm(wrapper);
    expect(vm.dialogOpen).toBe(false);

    vm.openDialog();
    await wrapper.vm.$nextTick();
    expect(vm.dialogOpen).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Confirm path: POST /api/resetTutorialProgress
// ─────────────────────────────────────────────────────────────────────

describe('TutorialReset.vue — confirmReset', () => {
  it('POSTs to /api/resetTutorialProgress with { slug } and reloads on 200', async () => {
    setStepCount(2);
    fetchMock
      // 1) getProgress on mount
      .mockResolvedValueOnce(mockFetchResponse({ completedSteps: [1, 2] }))
      // 2) resetTutorialProgress POST
      .mockResolvedValueOnce(mockFetchResponse({ success: true }));

    const wrapper = await mountReset('persist-slug');
    const vm = getVm(wrapper);

    // Listen for the tutorial-reset CustomEvent BEFORE the confirm call.
    const eventSpy = vi.fn();
    document.addEventListener('tutorial-reset', eventSpy);

    vm.openDialog();
    await wrapper.vm.$nextTick();
    await vm.confirmReset();
    await flushPromises();

    // 2nd fetch call is the POST. Verify URL, method, body.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/resetTutorialProgress');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ slug: 'persist-slug' });

    // CustomEvent dispatched with detail.slug
    expect(eventSpy).toHaveBeenCalledTimes(1);
    expect((eventSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({ slug: 'persist-slug' });

    // Page reloaded
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    document.removeEventListener('tutorial-reset', eventSpy);
  });

  it('surfaces a rate-limit message on 429 and does NOT reload', async () => {
    setStepCount(2);
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse({ completedSteps: [1, 2] }))
      .mockResolvedValueOnce(mockFetchResponse({ error: 'rate_limited' }, 429));

    const wrapper = await mountReset();
    const vm = getVm(wrapper);

    vm.openDialog();
    await wrapper.vm.$nextTick();
    await vm.confirmReset();
    await flushPromises();

    expect(vm.errorMessage).toMatch(/reset progress too many times/i);
    expect(vm.dialogOpen).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('surfaces a generic message on 500 and does NOT reload', async () => {
    setStepCount(2);
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse({ completedSteps: [1, 2] }))
      .mockResolvedValueOnce(mockFetchResponse({ error: 'boom' }, 500));

    const wrapper = await mountReset();
    const vm = getVm(wrapper);

    vm.openDialog();
    await wrapper.vm.$nextTick();
    await vm.confirmReset();
    await flushPromises();

    expect(vm.errorMessage).toMatch(/couldn't reset progress/i);
    expect(vm.dialogOpen).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('re-entry guard: calling confirmReset while submitting returns immediately', async () => {
    setStepCount(2);
    let resolvePost!: (v: unknown) => void;
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse({ completedSteps: [1, 2] }))
      .mockReturnValueOnce(new Promise((r) => { resolvePost = r; }));

    const wrapper = await mountReset();
    const vm = getVm(wrapper);

    vm.openDialog();
    await wrapper.vm.$nextTick();

    // First call — kicks off, don't await.
    const p1 = vm.confirmReset();
    await wrapper.vm.$nextTick();
    expect(vm.submitting).toBe(true);

    // Second call — should bail out immediately (guarded by `if (submitting.value) return`).
    vm.confirmReset();

    resolvePost(mockFetchResponse({ success: true }));
    await p1;
    await flushPromises();

    // Only ONE POST happened (the read path counts as the first fetch).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
