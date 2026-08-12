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
});
