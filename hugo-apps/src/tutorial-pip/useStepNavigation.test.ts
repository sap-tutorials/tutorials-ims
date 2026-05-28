// hugo-apps/src/tutorial-pip/useStepNavigation.test.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useStepNavigation } from './useStepNavigation';
import type { StepPayload } from '../shared/pip-types';

const steps: StepPayload[] = [
  { stepIndex: 1, heading: 'A', html: '<p>a</p>' },
  { stepIndex: 2, heading: 'B', html: '<p>b</p>' },
  { stepIndex: 3, heading: 'C', html: '<p>c</p>' },
];

beforeEach(() => {
  vi.restoreAllMocks();
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

  it('completeStep returns true on 2xx, advances, no exception', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 })
    );
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    const ok = await nav.completeStep(1);
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toMatch(/\/completeStep/);
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
