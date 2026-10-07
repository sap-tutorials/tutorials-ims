import { describe, it, expect } from 'vitest';
import { applyExclusion } from '../lib/discovery-exclusion.js';

describe('applyExclusion', () => {
  it('drops tutorials whose lowercased slug is excluded', () => {
    const tutorials = [
      { slug: 'Keep-Me', repo: 'Tutorials', branch: 'master' },
      { slug: 'drop-me', repo: 'Tutorials', branch: 'master' },
    ];
    const out = applyExclusion(tutorials, new Set(['drop-me']));
    expect(out.map(t => t.slug)).toEqual(['Keep-Me']);
  });

  it('is a no-op on an empty exclusion set', () => {
    const tutorials = [{ slug: 'a', repo: 'r', branch: 'b' }];
    expect(applyExclusion(tutorials, new Set())).toHaveLength(1);
  });
});
