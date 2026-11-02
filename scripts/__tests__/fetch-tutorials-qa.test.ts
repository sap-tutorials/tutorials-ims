import { describe, it, expect } from 'vitest';
import { parseChannel, getQaCacheDir, getHugoContentDir, qaDiscoveryIsDegraded } from '../fetch-tutorials';

describe('fetch-tutorials qa channel', () => {
  it('parses --channel qa', () => {
    expect(parseChannel(['node', 'x', '--channel', 'qa'])).toBe('qa');
  });
  it('defaults to prod', () => {
    expect(parseChannel(['node', 'x'])).toBe('prod');
  });
  it('returns separate cache dir for qa', () => {
    expect(getQaCacheDir('qa')).toMatch(/\.tutorial-cache-qa$/);
    expect(getQaCacheDir('prod')).toMatch(/\.tutorial-cache$/);
  });
  it('returns separate Hugo content dir for qa (no shared writes to prod content/)', () => {
    expect(getHugoContentDir('qa')).toMatch(/hugo[\\/]content-qa$/);
    expect(getHugoContentDir('prod')).toMatch(/hugo[\\/]content$/);
  });
});

// #2974 — QA channel fetches private *-Contribution repos over github.com only.
// A wrong-host/expired token makes discovery 401 and silently degrade to the
// on-disk/HANA cache, shipping a stale QA channel. The deploy must fail loudly
// on that degradation instead of fail-soft.
describe('qaDiscoveryIsDegraded (#2974 fail-loud gate)', () => {
  it('flags QA discovery that fell back to the disk cache', () => {
    expect(qaDiscoveryIsDegraded('qa', 'disk', false)).toBe(true);
  });
  it('flags QA discovery that fell back to HANA', () => {
    expect(qaDiscoveryIsDegraded('qa', 'hana', false)).toBe(true);
  });
  it('does NOT flag QA discovery served from live GitHub', () => {
    expect(qaDiscoveryIsDegraded('qa', 'github', false)).toBe(false);
  });
  it('does NOT flag QA discovery served from the live REST fallback (token is valid)', () => {
    expect(qaDiscoveryIsDegraded('qa', 'rest', false)).toBe(false);
  });
  it('never flags the prod channel (prod cache fallback is tolerated by design)', () => {
    expect(qaDiscoveryIsDegraded('prod', 'disk', false)).toBe(false);
    expect(qaDiscoveryIsDegraded('prod', 'hana', false)).toBe(false);
  });
  it('honors ALLOW_STALE_QA opt-out for a genuine github.com outage', () => {
    expect(qaDiscoveryIsDegraded('qa', 'disk', true)).toBe(false);
    expect(qaDiscoveryIsDegraded('qa', 'hana', true)).toBe(false);
  });
});
