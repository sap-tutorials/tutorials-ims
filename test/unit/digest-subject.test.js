import { describe, it, expect } from 'vitest';
import { digestSubject } from '../../srv/lib/contributor-notifications.js';

describe('digestSubject', () => {
  it('singular for one tutorial', () => {
    expect(digestSubject({ tutorials: [{}], worstLevel: 0 }))
      .toBe('1 stale tutorial needs review');
  });

  it('plural for multiple tutorials', () => {
    expect(digestSubject({ tutorials: [{}, {}, {}], worstLevel: 1 }))
      .toBe('3 stale tutorials need review');
  });

  it('switches to "FINAL NOTICE" prose at worstLevel=3', () => {
    expect(digestSubject({ tutorials: [{}, {}], worstLevel: 3 }))
      .toBe('FINAL NOTICE: 2 stale tutorials pending retirement');
  });

  it('singular final notice', () => {
    expect(digestSubject({ tutorials: [{}], worstLevel: 3 }))
      .toBe('FINAL NOTICE: 1 stale tutorial pending retirement');
  });
});
