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

// Issue #1836: a single-tutorial "home" (e.g. an auto-generated single-tutorial
// Devtoberfest/event mission wrapping one tutorial in a flat path) must NOT win
// canonical ownership over a real multi-tutorial group/mission that also owns the
// slug — otherwise the tutorial's breadcrumb + nav-dropdown show that junk event
// mission instead of the group the reader browses. "Size" is the mission's TOTAL
// tutorial count (sum across its group containers), not a single container's
// length, so a rich mission's single-slug group is never wrongly demoted.
describe('computeCanonicalNav — single-tutorial home demotion (#1836)', () => {
  const eventMission: NavContainer = {
    kind: 'mission', missionLegacyId: 23105, groupLegacyId: 816, missionGroupSeq: 0,
    slugs: ['cli'],
    stamp: { missionId: 23105, missionTitle: '#A1532C - Devtoberfest 2024', missionSlug: 'a1532c-devtoberfest' },
  };
  const realGroup: NavContainer = {
    kind: 'standalone', missionLegacyId: null, groupLegacyId: 21221, missionGroupSeq: 0,
    slugs: ['data-lake', 'scheduling', 'cli', 'pilot', 'rest', 'terraform'],
    stamp: { groupId: 21221, groupTitle: 'Automating SAP HANA Cloud Tasks', groupSlug: 'automating-sap-hana-cloud-tasks' },
  };
  const present = new Set(['cli', 'data-lake', 'scheduling', 'pilot', 'rest', 'terraform']);

  it('multi-tutorial group wins over a single-tutorial event mission', () => {
    const a = computeCanonicalNav([eventMission, realGroup], present);
    expect(a.get('cli')?.groupSlug).toBe('automating-sap-hana-cloud-tasks');
    expect(a.get('cli')?.missionSlug).toBeUndefined();
    expect(a.get('cli')?.prev).toBe('scheduling');   // in-group neighbours
    expect(a.get('cli')?.next).toBe('pilot');
  });

  it('is order-independent', () => {
    const a1 = computeCanonicalNav([eventMission, realGroup], present);
    const a2 = computeCanonicalNav([realGroup, eventMission], present);
    expect(a2.get('cli')).toEqual(a1.get('cli'));
  });

  it('a lone single-tutorial mission still owns its tutorial when nothing richer exists', () => {
    const a = computeCanonicalNav([eventMission], new Set(['cli']));
    expect(a.get('cli')?.missionSlug).toBe('a1532c-devtoberfest');
  });

  it('does NOT demote a single-slug group of a RICH mission (size = mission total, not container length)', () => {
    const richA: NavContainer = {
      kind: 'mission', missionLegacyId: 500, groupLegacyId: 10, missionGroupSeq: 0,
      slugs: ['x'],
      stamp: { missionId: 500, missionTitle: 'Rich', missionSlug: 'rich', groupId: 10, groupTitle: 'GA', groupSlug: 'ga' },
    };
    const richB: NavContainer = {
      kind: 'mission', missionLegacyId: 500, groupLegacyId: 11, missionGroupSeq: 1,
      slugs: ['y', 'z'],
      stamp: { missionId: 500, missionTitle: 'Rich', missionSlug: 'rich', groupId: 11, groupTitle: 'GB', groupSlug: 'gb' },
    };
    const standalone: NavContainer = {
      kind: 'standalone', missionLegacyId: null, groupLegacyId: 999, missionGroupSeq: 0,
      slugs: ['x', 'w'], stamp: { groupId: 999, groupTitle: 'Standalone', groupSlug: 'standalone' },
    };
    const a = computeCanonicalNav([standalone, richA, richB], new Set(['x', 'y', 'z', 'w']));
    // mission 500 total = 3 tutorials (>1) → rich → still wins 'x' over the standalone.
    expect(a.get('x')?.missionSlug).toBe('rich');
    expect(a.get('x')?.groupSlug).toBe('ga');
  });

  it('rankContainers demotes a single-tutorial home below a multi-tutorial one', () => {
    const ranked = rankContainers([eventMission, realGroup]);
    expect(ranked[0]).toBe(realGroup);   // 6-tutorial group outranks the 1-tutorial mission
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
