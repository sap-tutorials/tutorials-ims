// hugo-apps/src/tutorial-pip/useStepNavigation.test.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useStepNavigation } from './useStepNavigation';
import type { StepPayload } from '../shared/pip-types';
import { _resetCsrfTokenCacheForTests, _seedCsrfTokenForTests } from '@shared/csrf-fetch';

const steps: StepPayload[] = [
  { stepIndex: 1, heading: 'A', html: '<p>a</p>' },
  { stepIndex: 2, heading: 'B', html: '<p>b</p>' },
  { stepIndex: 3, heading: 'C', html: '<p>c</p>' },
];

beforeEach(() => {
  vi.restoreAllMocks();
  // Pre-seed the CSRF token so csrfFetch() skips the /auth/user handshake
  // in tests — keeps the fetch mock queue simple (only real POSTs observed).
  _resetCsrfTokenCacheForTests();
  _seedCsrfTokenForTests('TEST-CSRF');
});

describe('useStepNavigation', () => {
  it('next() advances within bounds', () => {
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    nav.next();
    expect(active.value).toBe(2);
  });

  it('next() at last step is a no-op', () => {
    const active = ref(3);
    const nav = useStepNavigation('demo', steps, active);
    nav.next();
    expect(active.value).toBe(3);
  });

  it('prev() at first step is a no-op', () => {
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    nav.prev();
    expect(active.value).toBe(1);
  });

  it('goto() clamps out-of-range indexes', () => {
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    nav.goto(99);
    expect(active.value).toBe(1);
    nav.goto(-1);
    expect(active.value).toBe(1);
    nav.goto(2);
    expect(active.value).toBe(2);
  });

  it('goto() rejects non-finite indexes (NaN, Infinity)', () => {
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    nav.goto(NaN);
    expect(active.value).toBe(1);
    nav.goto(Infinity);
    expect(active.value).toBe(1);
    nav.goto(-Infinity);
    expect(active.value).toBe(1);
  });

  it('completeStep returns true on 2xx, does not throw', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 })
    );
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    const ok = await nav.completeStep(1);
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toMatch(/\/completeStep/);
    // Composable does NOT auto-advance; that's PipShell.vue's job.
    expect(active.value).toBe(1);
  });

  it('completeStep returns false on non-2xx, does not throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    const ok = await nav.completeStep(1);
    expect(ok).toBe(false);
  });

  it('completeStep returns false on network error, does not throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('net'));
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    const ok = await nav.completeStep(1);
    expect(ok).toBe(false);
  });
});
