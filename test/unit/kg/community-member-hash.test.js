import { describe, it, expect } from 'vitest';
import { computeMemberSlugsHash } from '../../../srv/lib/kg/community-member-hash.js';

describe('computeMemberSlugsHash', () => {
  it('is order-independent and de-duplicates', () => {
    expect(computeMemberSlugsHash(['b', 'a', 'b'])).toBe(computeMemberSlugsHash(['a', 'b']));
  });
  it('changes when a member is added', () => {
    expect(computeMemberSlugsHash(['a', 'b'])).not.toBe(computeMemberSlugsHash(['a', 'b', 'c']));
  });
  it('returns empty-string sentinel for no usable slugs', () => {
    expect(computeMemberSlugsHash([])).toBe('');
    expect(computeMemberSlugsHash([null, ''])).toBe('');
  });
  it('produces 64-char hex for a real list', () => {
    expect(computeMemberSlugsHash(['a'])).toMatch(/^[0-9a-f]{64}$/);
  });
});
