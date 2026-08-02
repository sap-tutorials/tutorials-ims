// hugo-apps/src/devtoberfest-sessions-calendar/__tests__/App.view.test.ts
//
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const FEED = {
  activeEditionId: 'e1',
  editions: [{ id: 'e1', name: 'Devtoberfest 2026', isCurrent: true, startDate: '2026-10-01', endDate: '2026-10-31' }],
  sessions: [
    { id: 's1', kind: 'session', title: 'A', trackName: 'CAP', scheduledDate: '2026-10-05', scheduledTime: '14:00' },
    { id: 's2', kind: 'session', title: 'B', trackName: 'ABAP', scheduledDate: '2026-10-05', scheduledTime: '15:00' },
    { id: 's3', kind: 'session', title: 'C', trackName: 'AI', scheduledDate: '2026-10-05', scheduledTime: '16:00' },
    { id: 's4', kind: 'session', title: 'D', trackName: 'BTP', scheduledDate: '2026-10-05', scheduledTime: '17:00' },
  ],
  activities: [],
};

vi.mock('../../devtoberfest-schedule-shared/feed', () => ({
  fetchFeed: vi.fn(async () => FEED),
  fetchMyCompletions: vi.fn(async () => ({ authenticated: false })),
}));

import { fetchFeed } from '../../devtoberfest-schedule-shared/feed';
import App from '../App.vue';

describe('calendar App views', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to month view on the edition start month and shows +N more on a busy day', async () => {
    const wrapper = mount(App);
    await flushPromises();
    // month grid renders 42 day cells
    expect(wrapper.findAll('.mg-cell')).toHaveLength(42);
    // Oct 5 has 4 sessions, maxChips=3 → "+1 more"
    expect(wrapper.html()).toContain('+1 more');
  });

  it('switches to week and day views', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const buttons = wrapper.findAll('.cal-switch button');
    // [Month, Week, Day]
    await buttons[1].trigger('click');
    expect(wrapper.find('.wk').exists()).toBe(true);
    await buttons[2].trigger('click');
    expect(wrapper.find('.da').exists()).toBe(true);
  });

  it('surfaces undated sessions in the Unscheduled bucket instead of dropping them', async () => {
    const wrapper = mount(App);
    await flushPromises();
    // FEED has no undated sessions → no bucket
    expect(wrapper.find('.cal-unscheduled').exists()).toBe(false);

    // remount with an undated session and assert it appears in the bucket
    (fetchFeed as any).mockResolvedValueOnce({
      ...FEED,
      sessions: [
        ...FEED.sessions,
        { id: 'u1', kind: 'session', title: 'Undated Talk', trackName: 'CAP' },
      ],
    });
    const w2 = mount(App);
    await flushPromises();
    expect(w2.find('.cal-unscheduled').exists()).toBe(true);
    expect(w2.find('.cal-unscheduled').text()).toContain('Undated Talk');
  });
});
