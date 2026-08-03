// hugo-apps/src/devtoberfest-sessions-calendar/__tests__/App.view.test.ts
//
// @vitest-environment happy-dom
//
// TZ-pinning: set BEFORE any import so Intl resolves viewer-local zone
// to UTC — noon UTC strings then land on the same day in the viewer zone.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const FEED = {
  activeEditionId: 'e1',
  editions: [{ id: 'e1', name: 'Devtoberfest 2026', isCurrent: true, startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-31T00:00:00Z' }],
  sessions: [
    { id: 's1', kind: 'session', title: 'A', trackName: 'CAP',  scheduledStart: '2026-10-05T14:00:00Z', scheduledTimeZone: 'Europe/Berlin' },
    { id: 's2', kind: 'session', title: 'B', trackName: 'ABAP', scheduledStart: '2026-10-05T15:00:00Z', scheduledTimeZone: 'Europe/Berlin' },
    { id: 's3', kind: 'session', title: 'C', trackName: 'AI',   scheduledStart: '2026-10-05T16:00:00Z', scheduledTimeZone: 'Europe/Berlin' },
    { id: 's4', kind: 'session', title: 'D', trackName: 'BTP',  scheduledStart: '2026-10-05T17:00:00Z', scheduledTimeZone: 'Europe/Berlin' },
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
    // initialCursor must land on October 2026 from the edition's startsAt,
    // NOT fall through to new Date() — the calendar title must show October 2026.
    // This assertion would FAIL if startsAt is unread (bug C1 regression guard).
    expect(wrapper.find('.cal-title').text()).toMatch(/October\s+2026/);
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
