// test/unit/assert-frontmatter.test.js
import { describe, it, expect } from 'vitest';
import { renderHugoFrontmatter } from '../../scripts/parsers/render-frontmatter.ts';

function baseArgs(steps) {
  return {
    slug: 'demo', title: 'Demo', description: 'd', time: 5, level: 'Beginner',
    tags: [], primaryTag: '', author: '', authorProfile: '', youWillLearn: [],
    prerequisites: '', steps, nav: { prev: null, next: null }, lastUpdated: '',
    createdAt: '', contributors: [],
  };
}

describe('renderHugoFrontmatter asserts emit', () => {
  it('emits steps[].asserts when a step carries asserts', () => {
    const steps = [{
      number: 1, title: 'One', content: 'body',
      asserts: [{ index: 0, stepNumber: 1, type: 'cmd', run: 'cds compile', expectExit: 0 }],
    }];
    const out = renderHugoFrontmatter(baseArgs(steps));
    expect(out).toContain('asserts:');
    expect(out).toContain('cds compile');
  });

  it('omits asserts when none authored', () => {
    const steps = [{ number: 1, title: 'One', content: 'body' }];
    const out = renderHugoFrontmatter(baseArgs(steps));
    expect(out).not.toContain('asserts:');
  });
});
