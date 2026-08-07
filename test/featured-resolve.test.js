import { describe, it, expect } from 'vitest';
import { resolveFeatured, computeFeaturedEtag } from '../srv/lib/featured-resolve.js';

const maps = {
  missionByLegacyId: new Map([[10, { slug: 'm-slug', title: 'M', description: 'md' }]]),
  groupByLegacyId:   new Map([[20, { slug: 'g-slug', title: 'G', description: 'gd' }]]),
  tutorialByLegacyId:new Map([[30, { slug: 't-slug', title: 'T', description: 'td' }]]),
};

describe('resolveFeatured', () => {
  it('resolves a MISSION row', () => {
    expect(resolveFeatured({ taskType: 'MISSION', taskLegacyId: 10 }, maps))
      .toEqual({ type: 'mission', slug: 'm-slug', title: 'M', description: 'md' });
  });
  it('resolves a GROUP row from the Groups entity (not CompletionPaths)', () => {
    expect(resolveFeatured({ taskType: 'GROUP', taskLegacyId: 20 }, maps))
      .toEqual({ type: 'group', slug: 'g-slug', title: 'G', description: 'gd' });
  });
  it('resolves a TUTORIAL row', () => {
    expect(resolveFeatured({ taskType: 'TUTORIAL', taskLegacyId: 30 }, maps))
      .toEqual({ type: 'tutorial', slug: 't-slug', title: 'T', description: 'td' });
  });
  it('returns null for an unresolvable row', () => {
    expect(resolveFeatured({ taskType: 'MISSION', taskLegacyId: 999 }, maps)).toBeNull();
  });
});

describe('computeFeaturedEtag', () => {
  it('is stable for the same list and changes on reorder', () => {
    const a = [{ type: 'mission', slug: 'x' }, { type: 'tutorial', slug: 'y' }];
    const b = [{ type: 'tutorial', slug: 'y' }, { type: 'mission', slug: 'x' }];
    expect(computeFeaturedEtag(a)).toBe(computeFeaturedEtag(a));
    expect(computeFeaturedEtag(a)).not.toBe(computeFeaturedEtag(b));
  });
});
