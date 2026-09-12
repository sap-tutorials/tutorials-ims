// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

// Mock the server module so the feature-gate probe is deterministic — no real
// fetch. isKttEnabled is toggled per-test via the mock's return value.
vi.mock('../lib/server', () => ({
  isKttEnabled: vi.fn(),
  isAuthenticated: vi.fn().mockResolvedValue(false),
  completeLesson: vi.fn().mockResolvedValue(null),
  syncProgress: vi.fn().mockResolvedValue(null),
  fetchBanter: vi.fn().mockResolvedValue(null),
}));

import App from '../App.vue';
import { isKttEnabled } from '../lib/server';

const LESSONS = { units: [{ id: 'core', title: 'Core Platform', icon: 'home', order: 1,
  lessons: [{ id: 'core-1', legacyId: 90001, title: 'Meet the Platform', acronyms: [], beats: [] }] }] };

describe('KTT App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders the landing screen with a start CTA when KTT is enabled', async () => {
    (isKttEnabled as any).mockResolvedValue(true);
    const wrapper = mount(App, { props: { apiUrl: '/ktt', lessons: LESSONS } });
    await flushPromises();
    expect(wrapper.text()).toContain('Kasimir');
    expect(wrapper.find('[data-testid="ktt-start"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ktt-coming-soon"]').exists()).toBe(false);
  });

  it('fails closed with a coming-soon message and no drill engine when KTT is disabled', async () => {
    (isKttEnabled as any).mockResolvedValue(false);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const wrapper = mount(App, { props: { apiUrl: '/ktt', lessons: LESSONS } });
    await flushPromises();

    // Coming-soon shows; the start CTA / map / lesson engine must NOT render.
    expect(wrapper.find('[data-testid="ktt-coming-soon"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ktt-start"]').exists()).toBe(false);
    expect(wrapper.find('.ktt-map').exists()).toBe(false);
    expect(wrapper.find('.ktt-lesson-screen').exists()).toBe(false);

    // MUST NOT write localStorage progress while disabled.
    expect(setItem).not.toHaveBeenCalled();
  });
});
