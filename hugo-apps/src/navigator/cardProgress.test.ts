// hugo-apps/src/navigator/cardProgress.test.ts
import { describe, it, expect } from 'vitest';
import { cardProgress, toLookup, type ProgressPayload } from './cardProgress';
import type { CardItem } from '../shared/types';

function makeProgress(overrides: Partial<ProgressPayload> = {}): ProgressPayload {
  return {
    authenticated: true,
    tutorials: {
      completedSlugs: new Set(['done-tut']),
      inProgress: new Map([['inprog-tut', 60]])
    },
    missionSlugs: new Set(['done-mission']),
    groupSlugs: new Set(['done-group']),
    ...overrides
  };
}

const tutorialCard = (slug: string): CardItem => ({
  type: 'tutorial', id: slug, title: 't', description: '', time: 5,
  level: 'beginner', tutorialCount: 1, primaryTag: 'CAP', displayTags: [],
  href: `/tutorials/${slug}`, stepCount: 3
} as unknown as CardItem);

const missionCard = (slug: string): CardItem => ({
  type: 'mission', id: `mission-${slug}`, title: 'm', description: '', time: 10,
  level: 'beginner', tutorialCount: 3, primaryTag: 'CAP', displayTags: [],
  href: `/tutorials/mission-${slug}`, stepCount: 9
} as unknown as CardItem);

const groupCard = (slug: string): CardItem => ({
  type: 'group', id: `group-${slug}`, title: 'g', description: '', time: 8,
  level: 'beginner', tutorialCount: 2, primaryTag: 'CAP', displayTags: [],
  href: `/tutorials/group-${slug}`, stepCount: 6
} as unknown as CardItem);

describe('cardProgress', () => {
  it('returns null for unstarted tutorial card', () => {
    expect(cardProgress(tutorialCard('not-touched'), makeProgress())).toBeNull();
  });

  it('returns 100/complete for completed tutorial card', () => {
    expect(cardProgress(tutorialCard('done-tut'), makeProgress()))
      .toEqual({ percent: 100, complete: true });
  });

  it('returns in-progress percent for tutorial card with active record', () => {
    expect(cardProgress(tutorialCard('inprog-tut'), makeProgress()))
      .toEqual({ percent: 60, complete: false });
  });

  it('returns 100/complete for completed mission card', () => {
    expect(cardProgress(missionCard('done-mission'), makeProgress()))
      .toEqual({ percent: 100, complete: true });
  });

  it('returns null for incomplete mission card', () => {
    expect(cardProgress(missionCard('untouched-mission'), makeProgress())).toBeNull();
  });

  it('returns 100/complete for completed group card', () => {
    expect(cardProgress(groupCard('done-group'), makeProgress()))
      .toEqual({ percent: 100, complete: true });
  });

  it('does not collide group/mission slugs that share a name', () => {
    const progress = makeProgress({
      missionSlugs: new Set(['shared']),
      groupSlugs:   new Set([])
    });
    expect(cardProgress(missionCard('shared'), progress))
      .toEqual({ percent: 100, complete: true });
    expect(cardProgress(groupCard('shared'),   progress)).toBeNull();
  });

  it('returns null when payload is the empty-shape default', () => {
    const empty: ProgressPayload = {
      authenticated: false,
      tutorials: { completedSlugs: new Set(), inProgress: new Map() },
      missionSlugs: new Set(), groupSlugs: new Set()
    };
    expect(cardProgress(tutorialCard('any'),  empty)).toBeNull();
    expect(cardProgress(missionCard('any'),   empty)).toBeNull();
    expect(cardProgress(groupCard('any'),     empty)).toBeNull();
  });
});

describe('toLookup', () => {
  it('round-trips the wire-format payload', () => {
    const wire = {
      authenticated: true,
      tutorials: {
        completedSlugs: ['done-tut'],
        inProgress: [{ slug: 'inprog-tut', progressPercent: 60 }]
      },
      missionSlugs: ['done-mission'],
      groupSlugs:   ['done-group']
    };
    const p = toLookup(wire);
    expect(p.tutorials.completedSlugs.has('done-tut')).toBe(true);
    expect(p.tutorials.inProgress.get('inprog-tut')).toBe(60);
    expect(p.missionSlugs.has('done-mission')).toBe(true);
    expect(p.groupSlugs.has('done-group')).toBe(true);
  });

  it('client-side filters 0% entries even if server includes them', () => {
    const wire = {
      authenticated: true,
      tutorials: {
        completedSlugs: [],
        inProgress: [{ slug: 'zero-tut', progressPercent: 0 }, { slug: 'real', progressPercent: 30 }]
      },
      missionSlugs: [],
      groupSlugs: []
    };
    const p = toLookup(wire);
    expect(p.tutorials.inProgress.has('zero-tut')).toBe(false);
    expect(p.tutorials.inProgress.get('real')).toBe(30);
  });

  it('returns empty-shape on garbage input', () => {
    const p = toLookup(null);
    expect(p.authenticated).toBe(false);
    expect(p.tutorials.completedSlugs.size).toBe(0);
    expect(p.tutorials.inProgress.size).toBe(0);
  });
});
