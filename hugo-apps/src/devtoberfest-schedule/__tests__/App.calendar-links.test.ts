// @vitest-environment happy-dom
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const FEED = {
  activeEditionId: 'e1',
  editions: [{ id: 'e1', name: 'Devtoberfest 2026', isCurrent: true, startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-31T00:00:00Z' }],
  sessions: [
    { id: 's1', kind: 'session', title: 'Intro', trackName: 'CAP', scheduledStart: '2026-10-05T14:00:00Z', sessionLength: '30 min' },
  ],
  activities: [],
};

vi.mock('../../devtoberfest-schedule-shared/feed', () => ({
  fetchFeed: vi.fn(async () => FEED),
  fetchMyCompletions: vi.fn(async () => ({ authenticated: false })),
}));

import App from '../App.vue';

describe('schedule App per-session calendar links', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens a session and its .ics/add-to-calendar links carry the active edition', async () => {
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('.sched-row--session').trigger('click');
    await flushPromises();
    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'));
    expect(hrefs).toContain('/api/devtoberfest/session/s1.ics?edition=e1');
    expect(hrefs).toContain('/api/devtoberfest/session/s1.ics?to=google&edition=e1');
  });
});
