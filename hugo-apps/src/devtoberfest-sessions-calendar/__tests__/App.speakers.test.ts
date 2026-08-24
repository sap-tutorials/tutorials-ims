// hugo-apps/src/devtoberfest-sessions-calendar/__tests__/App.speakers.test.ts
//
// @vitest-environment happy-dom
//
// Regression guard for issue #2007: speaker names must appear on the
// individual session items in every calendar view (month / week / day),
// not only in the DetailPanel popup.
//
// TZ-pinning: set BEFORE any import so Intl resolves viewer-local zone to UTC.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const FEED = {
  activeEditionId: 'e1',
  editions: [{ id: 'e1', name: 'Devtoberfest 2026', isCurrent: true, startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-31T00:00:00Z' }],
  sessions: [
    {
      id: 's1', kind: 'session', title: 'Joule Work', trackName: 'AI',
      scheduledStart: '2026-10-01T14:00:00Z', scheduledTimeZone: 'Europe/Berlin',
      speakers: [{ id: 'sp1', name: 'Christian Hoffman', company: 'SAP' }],
    },
    {
      id: 's2', kind: 'session', title: 'Duet Talk', trackName: 'CAP',
      scheduledStart: '2026-10-01T15:00:00Z', scheduledTimeZone: 'Europe/Berlin',
      speakers: [{ id: 'sp2', name: 'Ada Lovelace' }, { id: 'sp3', name: 'Alan Turing' }],
    },
  ],
  activities: [],
};

vi.mock('../../devtoberfest-schedule-shared/feed', () => ({
  fetchFeed: vi.fn(async () => FEED),
  fetchMyCompletions: vi.fn(async () => ({ authenticated: false })),
}));

import App from '../App.vue';

async function mountAt(view: 'Month' | 'Week' | 'Day') {
  const wrapper = mount(App);
  await flushPromises();
  const labels = ['Month', 'Week', 'Day'];
  const buttons = wrapper.findAll('.cal-switch button');
  await buttons[labels.indexOf(view)].trigger('click');
  return wrapper;
}

describe('calendar session items show speakers (#2007)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders speaker names in the month view chips', async () => {
    const wrapper = await mountAt('Month');
    const html = wrapper.html();
    expect(html).toContain('Christian Hoffman');
    expect(html).toContain('Ada Lovelace, Alan Turing');
  });

  it('renders a speaker line in the week view cards', async () => {
    const wrapper = await mountAt('Week');
    expect(wrapper.find('.wk-sp').exists()).toBe(true);
    expect(wrapper.html()).toContain('Christian Hoffman');
    expect(wrapper.html()).toContain('Ada Lovelace, Alan Turing');
  });

  it('renders a speaker line in the day view cards', async () => {
    const wrapper = await mountAt('Day');
    expect(wrapper.find('.da-speakers').exists()).toBe(true);
    expect(wrapper.html()).toContain('Christian Hoffman');
  });
});
