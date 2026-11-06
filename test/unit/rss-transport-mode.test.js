// test/unit/rss-transport-mode.test.js
//
// Unit coverage for the shared rssMode() resolver (#3010). Verifies the
// env-wins-then-DB-flag precedence that both community-blogs-fetcher and
// homepage-rss-fetcher rely on.

import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock the DB flag reader so the test controls the flag value without a DB.
const isFlagEnabled = vi.fn();
vi.mock('../../srv/lib/feature-flags/db-flags.js', () => ({
  isFlagEnabled: (...a) => isFlagEnabled(...a),
}));

const { rssMode } = await import('../../srv/lib/rss-transport-mode.js');

afterEach(() => {
  delete process.env.RSS_TRANSPORT;
  isFlagEnabled.mockReset();
});

describe('rssMode()', () => {
  it('env RSS_TRANSPORT wins when set to a recognized value', () => {
    for (const v of ['curl', 'khoros', 'fetch']) {
      process.env.RSS_TRANSPORT = v;
      isFlagEnabled.mockReturnValue(true);
      expect(rssMode()).toBe(v);
      // Env override must short-circuit before consulting the flag.
      expect(isFlagEnabled).not.toHaveBeenCalled();
    }
  });

  it('falls back to the DB flag when env is unset', () => {
    isFlagEnabled.mockReturnValue(true);
    expect(rssMode()).toBe('curl');
    expect(isFlagEnabled).toHaveBeenCalledWith('COMMUNITY_RSS_USE_CURL');

    isFlagEnabled.mockReturnValue(false);
    expect(rssMode()).toBe('khoros');
  });

  it('ignores an unrecognized env value and consults the flag', () => {
    process.env.RSS_TRANSPORT = 'bogus';
    isFlagEnabled.mockReturnValue(false);
    expect(rssMode()).toBe('khoros');
    expect(isFlagEnabled).toHaveBeenCalledWith('COMMUNITY_RSS_USE_CURL');
  });
});
