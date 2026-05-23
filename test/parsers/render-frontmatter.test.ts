import { describe, it, expect } from 'vitest';
import { renderHugoFrontmatter } from '../../scripts/parsers/render-frontmatter.js';
import type { TutorialStep, TutorialNavEntry } from '../../scripts/parsers/types.js';

const stubStep = (n: number): TutorialStep => ({
  number: n,
  title: `Step ${n}`,
  content: `Body of step ${n}`,
  validation: undefined,
} as TutorialStep);

const stubNav: TutorialNavEntry = {
  slug: 's',
  title: 't',
  description: 'd',
  time: 5,
  level: 'beginner',
  stepCount: 1,
  prev: null,
  next: null,
  displayTags: [],
} as unknown as TutorialNavEntry;

describe('renderHugoFrontmatter', () => {
  it('returns a string starting with --- and containing the title key', () => {
    const out = renderHugoFrontmatter({
      slug: 'my-slug',
      title: 'My Title',
      description: 'Desc',
      time: 5,
      level: 'beginner',
      tags: ['software-product>sap-cap'],
      primaryTag: 'software-product>sap-cap',
      author: 'Tom',
      authorProfile: '',
      youWillLearn: ['A', 'B'],
      prerequisites: 'Node 20',
      steps: [stubStep(1), stubStep(2)],
      nav: stubNav,
      lastUpdated: '2026-05-23',
      createdAt: '2026-01-01',
      contributors: [],
    });
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('title: My Title');
    expect(out).toContain('slug: my-slug');
    expect(out).toContain('stepCount: 2');
    expect(out).toContain('{{% tutorial-step number="1" title="Step 1" %}}');
    expect(out).toContain('{{% tutorial-step number="2" title="Step 2" %}}');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('escapes double quotes in step titles', () => {
    const step: TutorialStep = { number: 1, title: 'A "fancy" step', content: 'body' } as TutorialStep;
    const out = renderHugoFrontmatter({
      slug: 's', title: 't', description: 'd', time: 5, level: 'beginner',
      tags: [], primaryTag: '', author: '', authorProfile: '',
      youWillLearn: [], prerequisites: '',
      steps: [step], nav: stubNav,
      lastUpdated: '', createdAt: '', contributors: [],
    });
    expect(out).toContain('title="A &quot;fancy&quot; step"');
  });
});
