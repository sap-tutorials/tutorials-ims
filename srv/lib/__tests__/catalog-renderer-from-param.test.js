import { describe, it, expect } from 'vitest';
import { renderGroupBody, renderMissionBody } from '../catalog-renderer.js';

describe('catalog-renderer ?from= emission', () => {
  it('group cards append ?from=<group.slug> to every tutorial link', () => {
    const ctx = {
      group: { slug: 'set-up', title: 'Set Up', description: '' },
      tutorials: [
        { slug: 'trial-1', title: 'T1', level: 'beginner', time: 5, stepCount: 3, createdAt: '2020-01-01' },
        { slug: 'trial-2', title: 'T2', level: 'beginner', time: 5, stepCount: 3, createdAt: '2020-01-01' },
      ],
      tutorialCount: 2, totalTime: 10, level: 'beginner',
    };
    const html = renderGroupBody(ctx, { now: new Date('2020-02-01') });
    expect(html).toContain('href="/tutorials/trial-1?from=set-up"');
    expect(html).toContain('href="/tutorials/trial-2?from=set-up"');
    // both the title link and the Start button carry it
    expect((html.match(/\?from=set-up/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('mission cards append ?from=<g.slug> per group', () => {
    const ctx = {
      mission: { slug: 'jump-start', title: 'Jump Start', description: '' },
      groups: [{ slug: 'set-up', title: 'Set Up', isSynthetic: false, tutorials: [
        { slug: 'trial-1', title: 'T1', level: 'beginner', time: 5, stepCount: 3 },
      ] }],
      groupCount: 1, tutorialCount: 1, totalTime: 5, level: 'beginner',
    };
    const html = renderMissionBody(ctx);
    expect(html).toContain('href="/tutorials/trial-1?from=set-up"');
  });

  it('mission cards: non-flat synthetic path groups emit ?from=<pathSlug>', () => {
    // Two synthetic cards → syntheticCount > 1 → navigator has a groupSlug for each
    const ctx = {
      mission: { slug: 'multi-path', title: 'Multi Path', description: '' },
      groups: [
        { slug: 'path-101', title: 'Path 101', isSynthetic: true, tutorials: [
          { slug: 'tut-a', title: 'Tut A', level: 'beginner', time: 5, stepCount: 3 },
        ]},
        { slug: 'path-102', title: 'Path 102', isSynthetic: true, tutorials: [
          { slug: 'tut-b', title: 'Tut B', level: 'beginner', time: 5, stepCount: 3 },
        ]},
      ],
      groupCount: 2, tutorialCount: 2, totalTime: 10, level: 'beginner',
    };
    const html = renderMissionBody(ctx);
    expect(html).toContain('href="/tutorials/tut-a?from=path-101"');
    expect(html).toContain('href="/tutorials/tut-b?from=path-102"');
  });

  it('mission cards: flat single-path synthetic group does NOT emit ?from= (navigator groupSlug is undefined)', () => {
    // Single synthetic card → syntheticCount === 1 → navigator emits groupSlug: undefined
    // for this mission; emitting ?from= would produce a param the island can never match.
    const ctx = {
      mission: { slug: 'flat-mission', title: 'Flat Mission', description: '' },
      groups: [
        { slug: 'path-99', title: 'Path 99', isSynthetic: true, tutorials: [
          { slug: 'tut-c', title: 'Tut C', level: 'beginner', time: 5, stepCount: 3 },
        ]},
      ],
      groupCount: 1, tutorialCount: 1, totalTime: 5, level: 'beginner',
    };
    const html = renderMissionBody(ctx);
    expect(html).not.toContain('?from=path-99');
    expect(html).toContain('href="/tutorials/tut-c"');
  });
});
