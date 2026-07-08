// test/unit/events-orchestrator-allowlist.test.js
// #1030 — fetchAllEvents typesAllowlist option.

import { describe, it, expect, afterEach } from 'vitest';
import { fetchAllEvents, _setMockFetchers, _resetMockFetchers } from '../../srv/lib/events/index.js';

afterEach(() => _resetMockFetchers());

describe('fetchAllEvents typesAllowlist', () => {
  it('with no allowlist, fetches all sources', async () => {
    let khorosCalled = false, rssCalled = false;
    _setMockFetchers({
      khoros: () => { khorosCalled = true; return []; },
      rss:    () => { rssCalled = true; return []; },
    });
    await fetchAllEvents({ now: new Date('2026-07-07') });
    expect(khorosCalled).toBe(true);
    expect(rssCalled).toBe(true);
  });

  it('with typesAllowlist=[codejam], only khoros is called', async () => {
    let khorosCalled = false, rssCalled = false;
    _setMockFetchers({
      khoros: () => { khorosCalled = true; return []; },
      rss:    () => { rssCalled = true; return []; },
    });
    await fetchAllEvents({ now: new Date('2026-07-07'), typesAllowlist: ['codejam'] });
    expect(khorosCalled).toBe(true);
    expect(rssCalled).toBe(false);
  });

  it('with typesAllowlist=[devtoberfest], only rss is called', async () => {
    let khorosCalled = false, rssCalled = false;
    _setMockFetchers({
      khoros: () => { khorosCalled = true; return []; },
      rss:    () => { rssCalled = true; return []; },
    });
    await fetchAllEvents({ now: new Date('2026-07-07'), typesAllowlist: ['devtoberfest'] });
    expect(khorosCalled).toBe(false);
    expect(rssCalled).toBe(true);
  });

  it('with typesAllowlist=[codejam, devtoberfest], both are called', async () => {
    let khorosCalled = false, rssCalled = false;
    _setMockFetchers({
      khoros: () => { khorosCalled = true; return []; },
      rss:    () => { rssCalled = true; return []; },
    });
    await fetchAllEvents({
      now: new Date('2026-07-07'),
      typesAllowlist: ['codejam', 'devtoberfest'],
    });
    expect(khorosCalled).toBe(true);
    expect(rssCalled).toBe(true);
  });
});
