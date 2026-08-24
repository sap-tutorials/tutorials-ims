import { describe, it, expect } from 'vitest';
import { speakerNames } from './completion';

describe('speakerNames', () => {
  it('returns empty string when there are no speakers', () => {
    expect(speakerNames(null)).toBe('');
    expect(speakerNames({})).toBe('');
    expect(speakerNames({ speakers: [] })).toBe('');
  });

  it('joins multiple speaker names with a comma', () => {
    expect(speakerNames({ speakers: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }] }))
      .toBe('Ada Lovelace, Alan Turing');
  });

  it('trims and drops blank names', () => {
    expect(speakerNames({ speakers: [{ name: '  Grace Hopper  ' }, { name: '' }, { name: '   ' }] }))
      .toBe('Grace Hopper');
  });
});
