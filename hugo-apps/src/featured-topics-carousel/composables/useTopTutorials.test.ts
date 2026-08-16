import { describe, it, expect } from 'vitest';
import { buildTopTutorialSlides } from './useTopTutorials';

const windows = [
  { windowDays: 180, items: [
    { rank: 1, slug: 'a', completions: 1200, card: { slug: 'a', title: 'Build a CAP app', description: 'd', level: 'beginner', time: 30, primaryTag: 'CAP', href: '/tutorials/a', isNew: false } },
    { rank: 2, slug: 'b', completions: 900,  card: { slug: 'b', title: 'Deploy', description: 'd', level: 'intermediate', time: 45, primaryTag: 'BTP', href: '/tutorials/b', isNew: false } },
  ] },
];

describe('buildTopTutorialSlides', () => {
  it('builds a slide per chunk with a window-specific heading', () => {
    const slides = buildTopTutorialSlides(windows, 180, 4);
    expect(slides).toHaveLength(1);
    expect(slides[0].displayTitle).toBe('Top Tutorials · Last 180 days');
    expect(slides[0].conceptSlug).toBe('top-180-0');
  });

  it('renders a source label + completions count + escaped title in each card', () => {
    const html = buildTopTutorialSlides(windows, 180, 4)[0].missionsHtml;
    expect(html).toContain('Top Tutorial');            // per-card source label
    expect(html).toContain('1,200');                    // localized completions
    expect(html).toContain('Build a CAP app');
    expect(html).toContain('href="/tutorials/a"');
  });

  it('chunks into multiple slides beyond chunkSize', () => {
    const many = [{ windowDays: 90, items: Array.from({ length: 6 }, (_, i) => ({
      rank: i + 1, slug: `s${i}`, completions: 10 - i,
      card: { slug: `s${i}`, title: `T${i}`, description: '', level: 'beginner', time: 10, primaryTag: 'X', href: `/tutorials/s${i}`, isNew: false },
    })) }];
    expect(buildTopTutorialSlides(many, 90, 4)).toHaveLength(2); // 6 → [4,2]
  });

  it('returns [] for a window with no data', () => {
    expect(buildTopTutorialSlides(windows, 90, 4)).toEqual([]);
  });
});
