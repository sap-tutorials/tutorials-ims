import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveGroupNav, readFromParam, _resetCacheForTest } from './group-nav-context';

const rows = [
  { slug: 't3', missionId: 15069, missionTitle: 'Jump Start', missionSlug: 'jump-start',
    groupId: 15066, groupTitle: 'Set Up', groupSlug: 'set-up', prev: 't2', next: 't4' },
  { slug: 't3', missionId: 24491, missionTitle: 'TechEd', missionSlug: 'teched',
    groupId: 937, groupTitle: 'D&A', groupSlug: 'data-and-analytics-937-1', prev: 't2', next: 'adv' },
];

beforeEach(() => { _resetCacheForTest(); });
afterEach(() => { vi.restoreAllMocks(); });

function stubFetch(ok = true, body: unknown = { tutorialMappings: rows }) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body })));
}

describe('group-nav-context', () => {
  it('readFromParam extracts a non-empty from', () => {
    expect(readFromParam('?from=set-up')).toBe('set-up');
    expect(readFromParam('?x=1')).toBeNull();
    expect(readFromParam('?from=')).toBeNull();
  });

  it('resolves the row matching (slug, groupSlug)', async () => {
    stubFetch();
    const r = await resolveGroupNav('t3', 'set-up');
    expect(r?.next).toBe('t4');
    expect(r?.missionSlug).toBe('jump-start');
  });

  it('returns null when no row matches the from group', async () => {
    stubFetch();
    expect(await resolveGroupNav('t3', 'nope')).toBeNull();
  });

  it('returns null on fetch failure (silent)', async () => {
    stubFetch(false);
    expect(await resolveGroupNav('t3', 'set-up')).toBeNull();
  });

  it('fetches /build/navigator only once (cache)', async () => {
    stubFetch();
    await resolveGroupNav('t3', 'set-up');
    await resolveGroupNav('t3', 'data-and-analytics-937-1');
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });
});
