// hugo-apps/src/devtoberfest-sessions-calendar/__tests__/App.speakers.test.ts
//
// @vitest-environment happy-dom
//
// Regression guard for issue #2007: speaker names must stay discoverable on
// session items across the calendar views. Week/Day show them as a visible
// line; the dense Month grid (compacted in #2046) surfaces them via the chip
// tooltip instead of eating horizontal grid space.
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

  it('keeps month-chip speakers in the tooltip, not the visible chip text (#2046 compaction)', async () => {
    // #2007 required speakers to be discoverable in every view. #2046 compacts
    // the dense month chips to time + title only, moving speakers into the chip
    // tooltip (title attribute) — still discoverable, but not eating grid width.
    const wrapper = await mountAt('Month');
    const chips = wrapper.findAll('.mg-chip');
    const joule = chips.find((c) => c.attributes('title')?.includes('Joule Work'));
    const duet = chips.find((c) => c.attributes('title')?.includes('Duet Talk'));
    expect(joule?.attributes('title')).toContain('Christian Hoffman');
    expect(duet?.attributes('title')).toContain('Ada Lovelace, Alan Turing');
    // Visible chip text is terse: title present, speaker names absent.
    expect(joule?.text()).toContain('Joule Work');
    expect(joule?.text()).not.toContain('Christian Hoffman');
    // The old inline speaker span is gone from the month grid entirely.
    expect(wrapper.find('.mg-chip-sp').exists()).toBe(false);
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
