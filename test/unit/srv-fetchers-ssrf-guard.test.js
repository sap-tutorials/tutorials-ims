// #895 — integration test: RSS + learning-journey fetchers must reject
// URLs that resolve to private/link-local addresses. Belt-and-suspenders
// coverage on top of the safe-fetch unit tests: catches accidental
// refactor to raw `fetch()` if someone forgets safe-fetch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchRssItems, _resetForTests as resetRss } from '../../srv/lib/homepage-rss-fetcher.js';
import { fetchJourneyBody } from '../../srv/lib/learning-journey-body-fetcher.js';
import { _setLookupForTests } from '../../srv/lib/safe-fetch.js';

beforeEach(() => {
  resetRss();
  vi.restoreAllMocks();
});

afterEach(() => {
  _setLookupForTests(null);
});

describe('#895 srv fetchers reject private/link-local IP resolutions', () => {
  it('RSS: URL resolving to 169.254.169.254 (IMDS) returns []', async () => {
    // fetch would run if the guard let us through; we stub it just to be safe.
    const fetchSpy = vi.fn(async () => new Response('should never reach', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    // Steer the resolver to return the IMDS address.
    _setLookupForTests(async () => [{ address: '169.254.169.254', family: 4 }]);

    const items = await fetchRssItems('https://rebind.attacker.example/feed', { limit: 5 });
    expect(items).toEqual([]);
    // Critically: fetch() was NEVER called because the guard tripped first.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('learning-journey: URL resolving to 10.x returns metadata-tier fallback', async () => {
    const fetchSpy = vi.fn(async () => new Response('should never reach', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    _setLookupForTests(async () => [{ address: '10.0.0.5', family: 4 }]);

    const result = await fetchJourneyBody('https://learning.sap.com/learning-journeys/whatever');
    expect(result).toEqual({ body: '', source: 'metadata' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('learning-journey: URL on non-allowlisted host returns metadata-tier fallback', async () => {
    const fetchSpy = vi.fn(async () => new Response('should never reach', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    _setLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

    const result = await fetchJourneyBody('https://evil.example/x');
    expect(result).toEqual({ body: '', source: 'metadata' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
