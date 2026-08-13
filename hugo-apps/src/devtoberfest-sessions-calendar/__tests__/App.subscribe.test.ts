// @vitest-environment happy-dom
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const FEED = {
  activeEditionId: 'e1',
  editions: [{ id: 'e1', name: 'Devtoberfest 2026', isCurrent: true, startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-31T00:00:00Z' }],
  sessions: [
    { id: 's1', kind: 'session', title: 'A', trackName: 'CAP', scheduledStart: '2026-10-05T14:00:00Z' },
  ],
  activities: [],
};

vi.mock('../../devtoberfest-schedule-shared/feed', () => ({
  fetchFeed: vi.fn(async () => FEED),
  fetchMyCompletions: vi.fn(async () => ({ authenticated: false })),
}));

import App from '../App.vue';

describe('calendar App subscribe affordance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders Subscribe (webcal) and RSS links scoped to the active edition', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'));
    // webcal subscription and RSS, both edition-scoped. Host is whatever the
    // test DOM reports, so assert against window.location.host rather than a literal.
    expect(hrefs).toContain(`webcal://${window.location.host}/api/devtoberfest/feed.ics?edition=e1`);
    expect(hrefs).toContain('/api/devtoberfest/feed.xml?edition=e1');
  });
});
