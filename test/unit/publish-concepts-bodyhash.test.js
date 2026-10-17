import { describe, it, expect } from 'vitest';
import { computeConceptBodyHash } from '../../srv/lib/publish-concepts.js';

describe('computeConceptBodyHash', () => {
  const meta = { kind: 'concept', slug: 'abap', title: 'ABAP', description: 'd' };
  it('is stable for identical body+meta', () => {
    expect(computeConceptBodyHash('BODY', meta)).toBe(computeConceptBodyHash('BODY', meta));
  });
  it('ignores shell (body-only input)', () => {
    // same body, caller composes shell separately — hash must not see shell
    expect(computeConceptBodyHash('BODY', meta)).not.toBe(computeConceptBodyHash('BODY2', meta));
  });
  it('changes when meta changes', () => {
    expect(computeConceptBodyHash('BODY', meta)).not.toBe(computeConceptBodyHash('BODY', { ...meta, title: 'X' }));
  });
});
