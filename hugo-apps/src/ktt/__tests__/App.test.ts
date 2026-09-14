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

// A lesson with a single drill so we can drive the pass/fail completion flow.
const DRILL_LESSON = { units: [{ id: 'core', title: 'Core Platform', icon: 'home', order: 1,
  lessons: [{ id: 'core-1', legacyId: 90001, title: 'Meet the Platform', acronyms: ['BTP'], beats: [
    { type: 'drill', kind: 'mc', tla: 'BTP', prompt: 'What is BTP?',
      answer: 'Business Technology Platform', distractors: ['Better Tech Portal'],
      kasimirRight: 'Yes!', kasimirWrong: 'No' },
  ] }] }] };

async function gotoLesson(wrapper: any) {
  await wrapper.find('[data-testid="ktt-start"]').trigger('click'); // landing → map
  await wrapper.find('[data-testid="ktt-node-core-1"]').trigger('click'); // map → lesson
}

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

  it('shows the XP/level/streak stats bar on the map', async () => {
    (isKttEnabled as any).mockResolvedValue(true);
    localStorage.setItem('ktt_progress', JSON.stringify({ xp: 60, streak: 2, mastered: [] }));
    const wrapper = mount(App, { props: { apiUrl: '/ktt', lessons: LESSONS } });
    await flushPromises();
    await wrapper.find('[data-testid="ktt-start"]').trigger('click');
    const stats = wrapper.find('[data-testid="ktt-stats"]');
    expect(stats.exists()).toBe(true);
    expect(wrapper.find('[data-testid="ktt-stats-xp"]').text()).toContain('60 XP');
    // 60 XP → tier 2 "Curious Cat"
    expect(wrapper.find('[data-testid="ktt-stats-level"]').text()).toContain('Curious Cat');
    expect(wrapper.find('[data-testid="ktt-stats-streak"]').text()).toContain('2 streak');
  });

  it('passing a lesson masters it, banks XP, and shows the success results', async () => {
    (isKttEnabled as any).mockResolvedValue(true);
    const wrapper = mount(App, { props: { apiUrl: '/ktt', lessons: DRILL_LESSON } });
    await flushPromises();
    await gotoLesson(wrapper);

    const correct = wrapper.findAll('[data-testid="ktt-choice"]')
      .find(c => c.text() === 'Business Technology Platform');
    await correct!.trigger('click');
    await wrapper.find('[data-testid="ktt-next"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="ktt-results"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ktt-results-failed"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ktt-results-xp"]').text()).toContain('10');
    // Mastery + XP persisted
    const saved = JSON.parse(localStorage.getItem('ktt_progress')!);
    expect(saved.mastered).toContain('core-1');
    expect(saved.xp).toBe(10);
    expect(saved.streak).toBe(1);
  });

  it('failing a lesson banks nothing and offers a retry back into the lesson', async () => {
    (isKttEnabled as any).mockResolvedValue(true);
    const wrapper = mount(App, { props: { apiUrl: '/ktt', lessons: DRILL_LESSON } });
    await flushPromises();
    await gotoLesson(wrapper);

    // Answer wrong twice (single drill re-queued once) → 0/1 correct
    let wrong = wrapper.findAll('[data-testid="ktt-choice"]').find(c => c.text() === 'Better Tech Portal');
    await wrong!.trigger('click');
    await wrapper.find('[data-testid="ktt-next"]').trigger('click');
    wrong = wrapper.findAll('[data-testid="ktt-choice"]').find(c => c.text() === 'Better Tech Portal');
    await wrong!.trigger('click');
    await wrapper.find('[data-testid="ktt-next"]').trigger('click');
    await flushPromises();

    // Failed results, not a false success
    expect(wrapper.find('[data-testid="ktt-results-failed"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ktt-results"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ktt-results-score"]').text()).toContain('0 of 1');
    // Nothing banked
    expect(localStorage.getItem('ktt_progress')).toBeNull();

    // Retry returns to the lesson with a fresh drill
    await wrapper.find('[data-testid="ktt-results-retry"]').trigger('click');
    expect(wrapper.find('.ktt-lesson-screen').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ktt-choice"]').exists()).toBe(true);
  });
});
