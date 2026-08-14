import { describe, it, expect } from 'vitest';
import { computeCanonicalNav, rankContainers, type NavContainer } from '../nav-owner';

const setup: NavContainer = {
  kind: 'mission', missionLegacyId: 15069, groupLegacyId: 15066, missionGroupSeq: 0,
  slugs: ['trial-1', 'trial-2', 'trial-3', 'trial-4'],
  stamp: { missionId: 15069, missionTitle: 'Jump Start', missionSlug: 'jump-start',
           groupId: 15066, groupTitle: 'Set Up', groupSlug: 'set-up' },
};
const teched: NavContainer = {
  kind: 'mission', missionLegacyId: 24491, groupLegacyId: 937, missionGroupSeq: 5,
  slugs: ['trial-2', 'trial-3', 'advanced-analytics'],
  stamp: { missionId: 24491, missionTitle: 'TechEd', missionSlug: 'teched',
           groupId: 937, groupTitle: 'Data & Analytics', groupSlug: 'data-and-analytics-937-1' },
};
const present = new Set(['trial-1', 'trial-2', 'trial-3', 'trial-4', 'advanced-analytics']);

describe('computeCanonicalNav', () => {
  it('picks the lowest-mission-legacyId owner regardless of group id or input order', () => {
    // teched.groupLegacyId (937) < setup.groupLegacyId (15066), so group-id
    // ranking would wrongly pick teched. Mission-id ranking must pick setup.
    const a = computeCanonicalNav([teched, setup], present);
    const t3 = a.get('trial-3');
    expect(t3?.groupSlug).toBe('set-up');
    expect(t3?.prev).toBe('trial-2');
    expect(t3?.next).toBe('trial-4');    // NOT advanced-analytics
    expect(t3?.missionSlug).toBe('jump-start');
  });

  it('emits groupOrder (index in owner) and missionGroupSeq (owner group position)', () => {
    const a = computeCanonicalNav([teched, setup], present);
    // trial-3 is index 2 in setup's slugs; setup is mission group seq 0.
    expect(a.get('trial-3')).toMatchObject({ groupOrder: 2, missionGroupSeq: 0 });
    expect(a.get('trial-1')).toMatchObject({ groupOrder: 0, missionGroupSeq: 0 });
    // advanced-analytics is only owned by teched (seq 5), index 2 there.
    expect(a.get('advanced-analytics')).toMatchObject({ groupOrder: 2, missionGroupSeq: 5 });
  });

  it('is order-independent', () => {
    const a1 = computeCanonicalNav([teched, setup], present);
    const a2 = computeCanonicalNav([setup, teched], present);
    expect(a2.get('trial-3')).toEqual(a1.get('trial-3'));
  });

  it('nulls prev/next when the neighbour is not a present page', () => {
    const g: NavContainer = { kind: 'standalone', missionLegacyId: null, groupLegacyId: 5, missionGroupSeq: 0,
      slugs: ['only', 'ghost'], stamp: { groupId: 5, groupTitle: 'G', groupSlug: 'g' } };
    const a = computeCanonicalNav([g], new Set(['only']));   // 'ghost' absent
    expect(a.get('only')).toMatchObject({ prev: null, next: null, groupSlug: 'g' });
  });

  it('standalone (null mission) ranks after mission-nested homes', () => {
    const standalone: NavContainer = { kind: 'standalone', missionLegacyId: null, groupLegacyId: 1, missionGroupSeq: 0,
      slugs: ['trial-3'], stamp: { groupId: 1, groupTitle: 'S', groupSlug: 'standalone' } };
    const a = computeCanonicalNav([standalone, setup], present);
    expect(a.get('trial-3')?.groupSlug).toBe('set-up');   // mission home wins
  });

  it('rankContainers orders by [missionLegacyId ?? MAX, groupLegacyId, firstSlug]', () => {
    const ranked = rankContainers([teched, setup]);
    expect(ranked[0]).toBe(setup);
  });
});

// Issue #1775: Next/Prev must flow continuously across groups WITHIN a mission.
// The last tutorial of group N links to the first tutorial of group N+1 (and
// symmetrically for Prev), using the mission's group order (missionGroupSeq).
// Standalone groups (no parent mission) never chain to another container.
describe('computeCanonicalNav — cross-group chaining within a mission (#1775)', () => {
  const group1: NavContainer = {
    kind: 'mission', missionLegacyId: 15069, groupLegacyId: 15066, missionGroupSeq: 0,
    slugs: ['trial-1', 'trial-2', 'trial-3', 'trial-4'],
    stamp: { missionId: 15069, missionTitle: 'Jump Start', missionSlug: 'jump-start',
             groupId: 15066, groupTitle: 'Set Up', groupSlug: 'set-up' },
  };
  const group2: NavContainer = {
    kind: 'mission', missionLegacyId: 15069, groupLegacyId: 15067, missionGroupSeq: 1,
    slugs: ['trial-5', 'trial-6'],
    stamp: { missionId: 15069, missionTitle: 'Jump Start', missionSlug: 'jump-start',
             groupId: 15067, groupTitle: 'First Steps', groupSlug: 'first-steps' },
  };
  const all = new Set(['trial-1', 'trial-2', 'trial-3', 'trial-4', 'trial-5', 'trial-6']);

  it('links the last tutorial of group N to the first tutorial of group N+1', () => {
    const a = computeCanonicalNav([group1, group2], all);
    expect(a.get('trial-4')?.next).toBe('trial-5');   // crosses the group boundary
    expect(a.get('trial-4')?.groupSlug).toBe('set-up'); // page's own group stamp unchanged
  });

  it('links the first tutorial of group N+1 back to the last of group N', () => {
    const a = computeCanonicalNav([group1, group2], all);
    expect(a.get('trial-5')?.prev).toBe('trial-4');
    expect(a.get('trial-5')?.groupSlug).toBe('first-steps');
  });

  it('bounds the ends of the mission (first tutorial has no prev, last has no next)', () => {
    const a = computeCanonicalNav([group1, group2], all);
    expect(a.get('trial-1')?.prev).toBeNull();
    expect(a.get('trial-6')?.next).toBeNull();
  });

  it('is order-independent across the group boundary', () => {
    const a1 = computeCanonicalNav([group1, group2], all);
    const a2 = computeCanonicalNav([group2, group1], all);
    expect(a2.get('trial-4')).toEqual(a1.get('trial-4'));
    expect(a2.get('trial-5')).toEqual(a1.get('trial-5'));
  });

  it('skips a not-present boundary neighbour to the next present tutorial', () => {
    // group2's first tutorial (trial-5) is absent → trial-4.next skips to trial-6.
    const present = new Set(['trial-1', 'trial-2', 'trial-3', 'trial-4', 'trial-6']);
    const a = computeCanonicalNav([group1, group2], present);
    expect(a.get('trial-4')?.next).toBe('trial-6');
    expect(a.get('trial-6')?.prev).toBe('trial-4');
  });

  it('does NOT chain a standalone group to any other container', () => {
    const standaloneA: NavContainer = {
      kind: 'standalone', missionLegacyId: null, groupLegacyId: 100, missionGroupSeq: 0,
      slugs: ['s1', 's2'], stamp: { groupId: 100, groupTitle: 'A', groupSlug: 'a' },
    };
    const standaloneB: NavContainer = {
      kind: 'standalone', missionLegacyId: null, groupLegacyId: 200, missionGroupSeq: 0,
      slugs: ['s3', 's4'], stamp: { groupId: 200, groupTitle: 'B', groupSlug: 'b' },
    };
    const present = new Set(['s1', 's2', 's3', 's4']);
    const a = computeCanonicalNav([standaloneA, standaloneB], present);
    expect(a.get('s2')?.next).toBeNull();   // last of A does NOT jump to B
    expect(a.get('s3')?.prev).toBeNull();   // first of B does NOT jump to A
  });
});
