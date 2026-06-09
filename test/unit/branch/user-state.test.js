import { describe, it, expect } from 'vitest';
import { buildUserState, fingerprintUserState } from '../../../srv/lib/branch/user-state.js';

describe('buildUserState', () => {
  it('returns frozen empty state for anonymous user', async () => {
    const state = await buildUserState(null, {
      loadCompletedSlugs: async () => [],
      loadCompletedMissionSlugs: async () => [],
      loadProfile: async () => null,
    });
    expect(state.completedSlugs).toBeInstanceOf(Set);
    expect(state.completedSlugs.size).toBe(0);
    expect(state.profile).toEqual({ deployment: null, role: null, cloud: null });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.profile)).toBe(true);
  });

  it('populates Sets and profile for authenticated user', async () => {
    const state = await buildUserState({ id: 'u1' }, {
      loadCompletedSlugs:        async () => ['a', 'b'],
      loadCompletedMissionSlugs: async () => ['m1'],
      loadProfile:               async () => ({ deployment: 'cloud', role: 'developer', cloud: 'btp' }),
    });
    expect([...state.completedSlugs].sort()).toEqual(['a', 'b']);
    expect([...state.completedMissionSlugs]).toEqual(['m1']);
    expect(state.profile.deployment).toBe('cloud');
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('treats missing profile fields as null (does not crash)', async () => {
    const state = await buildUserState({ id: 'u2' }, {
      loadCompletedSlugs:        async () => [],
      loadCompletedMissionSlugs: async () => [],
      loadProfile:               async () => ({ deployment: 'onprem' }),
    });
    expect(state.profile).toEqual({ deployment: 'onprem', role: null, cloud: null });
  });
});

describe('fingerprintUserState', () => {
  it('is deterministic across runs', () => {
    const s = {
      completedSlugs: new Set(['b', 'a', 'c']),
      completedMissionSlugs: new Set(['m1']),
      profile: { deployment: 'cloud', role: 'developer', cloud: 'btp' },
    };
    expect(fingerprintUserState(s)).toBe(fingerprintUserState(s));
  });

  it('is order-insensitive over Set members', () => {
    const a = { completedSlugs: new Set(['a', 'b']), completedMissionSlugs: new Set(), profile: {} };
    const b = { completedSlugs: new Set(['b', 'a']), completedMissionSlugs: new Set(), profile: {} };
    expect(fingerprintUserState(a)).toBe(fingerprintUserState(b));
  });

  it('changes when a slug is added', () => {
    const s1 = { completedSlugs: new Set(['a']), completedMissionSlugs: new Set(), profile: {} };
    const s2 = { completedSlugs: new Set(['a', 'b']), completedMissionSlugs: new Set(), profile: {} };
    expect(fingerprintUserState(s1)).not.toBe(fingerprintUserState(s2));
  });

  it('changes when profile changes', () => {
    const s1 = { completedSlugs: new Set(), completedMissionSlugs: new Set(), profile: { deployment: 'cloud' } };
    const s2 = { completedSlugs: new Set(), completedMissionSlugs: new Set(), profile: { deployment: 'onprem' } };
    expect(fingerprintUserState(s1)).not.toBe(fingerprintUserState(s2));
  });

  it('produces a 64-char hex string', () => {
    const s = { completedSlugs: new Set(), completedMissionSlugs: new Set(), profile: {} };
    const fp = fingerprintUserState(s);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });
});
