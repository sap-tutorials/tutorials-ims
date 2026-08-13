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
