// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h } from 'vue';
import DetailPanel from './DetailPanel.vue';

function mount(props: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({ render: () => h(DetailPanel as any, props) });
  app.mount(host);
  return { host, app };
}

afterEach(() => {
  document.body.replaceChildren();
});

const scheduledSession = {
  id: 's1',
  kind: 'session',
  title: 'Intro to CAP',
  scheduledStart: '2026-10-05T09:00:00.000Z',
  sessionLength: '30 min',
};

describe('DetailPanel calendar affordances', () => {
  it('offers .ics download and Google/Outlook links for a scheduled session', () => {
    const { host } = mount({ row: scheduledSession });
    const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/api/devtoberfest/session/s1.ics');
    expect(hrefs).toContain('/api/devtoberfest/session/s1.ics?to=google');
    expect(hrefs).toContain('/api/devtoberfest/session/s1.ics?to=outlook');
  });

  it('threads the editionId through the calendar hrefs when provided', () => {
    const { host } = mount({ row: scheduledSession, editionId: 'e9' });
    const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/api/devtoberfest/session/s1.ics?edition=e9');
    expect(hrefs).toContain('/api/devtoberfest/session/s1.ics?to=google&edition=e9');
  });

  it('does not offer calendar links for a session without a scheduledStart', () => {
    const { host } = mount({ row: { id: 's2', kind: 'session', title: 'Unscheduled' } });
    const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href') || '');
    expect(hrefs.some((h) => h.includes('/session/s2.ics'))).toBe(false);
  });

  it('does not offer calendar links for an activity row', () => {
    const { host } = mount({ row: { id: 'a1', kind: 'activity', title: 'Do a tutorial', points: 100, scheduledStart: '2026-10-05T09:00:00.000Z' } });
    const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href') || '');
    expect(hrefs.some((h) => h.includes('/session/'))).toBe(false);
  });
});
