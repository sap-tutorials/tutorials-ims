import { describe, it, expect } from 'vitest';
import { applyVideoFilter } from '../video-filter';
import { applyRssFilter } from '../rss-filter';

describe('applyVideoFilter', () => {
  const items = [
    { videoId: 'a', title: 'BTP intro', tags: ['btp'] },
    { videoId: 'b', title: 'AWS deep dive', tags: ['aws'] },
    { videoId: 'c', title: 'Something else', tags: [] },
  ];
  it('passes through when tags empty', () => {
    expect(applyVideoFilter(items, []).map(x => x.videoId)).toEqual(['a', 'b', 'c']);
  });
  it('floats matches to the top, preserves non-matches at the tail', () => {
    expect(applyVideoFilter(items, ['aws']).map(x => x.videoId)).toEqual(['b', 'a', 'c']);
  });
  it('is stable across multiple matching tags', () => {
    expect(applyVideoFilter(items, ['aws', 'btp']).map(x => x.videoId)).toEqual(['a', 'b', 'c']);
  });
  it('handles missing tags field gracefully', () => {
    const noTags = [{ videoId: 'x', title: 'X' }] as any[];
    expect(applyVideoFilter(noTags, ['aws']).map(x => x.videoId)).toEqual(['x']);
  });
});

describe('applyRssFilter', () => {
  const items = [
    { title: 'BTP dev', link: '1', categories: ['btp-development'] },
    { title: 'Arch', link: '2', categories: ['architecture'] },
    { title: 'Random', link: '3', categories: [] },
  ];
  it('floats matches on categories', () => {
    expect(applyRssFilter(items as any, ['architecture']).map(x => x.link)).toEqual(['2', '1', '3']);
  });
});
