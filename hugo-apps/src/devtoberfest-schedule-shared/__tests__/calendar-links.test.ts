import { describe, it, expect } from 'vitest';
import {
  sessionIcsHref,
  sessionCalendarHref,
  feedIcsHref,
  feedRssHref,
  subscribeWebcalHref,
} from '../calendar-links';

describe('calendar-links', () => {
  it('builds a single-session .ics download href', () => {
    expect(sessionIcsHref('s1')).toBe('/api/devtoberfest/session/s1.ics');
  });

  it('encodes the session id in the .ics href', () => {
    expect(sessionIcsHref('a b/c')).toBe('/api/devtoberfest/session/a%20b%2Fc.ics');
  });

  it('appends edition when given', () => {
    expect(sessionIcsHref('s1', 'e9')).toBe('/api/devtoberfest/session/s1.ics?edition=e9');
  });

  it('builds Google/Outlook add-to-calendar hrefs via the server redirect endpoint', () => {
    expect(sessionCalendarHref('s1', 'google')).toBe('/api/devtoberfest/session/s1.ics?to=google');
    expect(sessionCalendarHref('s1', 'outlook')).toBe('/api/devtoberfest/session/s1.ics?to=outlook');
  });

  it('add-to-calendar href carries edition alongside the target', () => {
    expect(sessionCalendarHref('s1', 'google', 'e9')).toBe('/api/devtoberfest/session/s1.ics?to=google&edition=e9');
  });

  it('builds the whole-schedule feed hrefs', () => {
    expect(feedIcsHref()).toBe('/api/devtoberfest/feed.ics');
    expect(feedRssHref()).toBe('/api/devtoberfest/feed.xml');
    expect(feedIcsHref('e9')).toBe('/api/devtoberfest/feed.ics?edition=e9');
    expect(feedRssHref('e9')).toBe('/api/devtoberfest/feed.xml?edition=e9');
  });

  it('builds a webcal:// subscription URL from the host', () => {
    expect(subscribeWebcalHref('developers.sap.com')).toBe('webcal://developers.sap.com/api/devtoberfest/feed.ics');
    expect(subscribeWebcalHref('developers.sap.com', 'e9')).toBe('webcal://developers.sap.com/api/devtoberfest/feed.ics?edition=e9');
  });
});
