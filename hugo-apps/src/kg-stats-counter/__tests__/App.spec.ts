// hugo-apps/src/kg-stats-counter/__tests__/App.spec.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

function mockFetch(payload: unknown, init?: { status?: number; ok?: boolean }) {
  const status = init?.status ?? 200;
  const ok = init?.ok ?? status < 400;
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  });
}

describe('KgStatsCounter', () => {
  beforeEach(() => {
    // Reduced motion off by default.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('renders the skeleton on mount before fetch resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // never resolves
    const wrapper = mount(App);
    expect(wrapper.find('[data-testid="kg-stats-skeleton"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="kg-stats-counters"]').exists()).toBe(false);
  });

  it('renders final counts after fetch resolves', async () => {
    vi.stubGlobal('fetch', mockFetch({
      tutorials: 1432, concepts: 312, relationships: 2847,
      missionsAndGroups: 96, lastExtractedAt: '2026-06-28T03:17:42Z',
      generatedAt: '2026-06-29T18:04:11Z',
    }));
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-testid="kg-stats-skeleton"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('1,432');
    expect(wrapper.text()).toContain('312');
    expect(wrapper.text()).toContain('2,847');
  });

  it('renders the static fallback on 5xx', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'kg_stats_unavailable' }, { status: 503, ok: false }));
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-testid="kg-stats-fallback"]').exists()).toBe(true);
  });

  it('skips the count-up animation when prefers-reduced-motion is set', async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    vi.stubGlobal('fetch', mockFetch({
      tutorials: 100, concepts: 50, relationships: 200,
      missionsAndGroups: 10, lastExtractedAt: null, generatedAt: new Date().toISOString(),
    }));
    const wrapper = mount(App);
    await flushPromises();
    // The final value should be present immediately (no count-up).
    expect(wrapper.text()).toContain('100');
    expect(wrapper.text()).toContain('50');
    expect(wrapper.text()).toContain('200');
  });
});
