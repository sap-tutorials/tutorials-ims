import { describe, it, expect } from 'vitest';
import { validateTags, KNOWN_TAGS } from '../../../srv/lib/homepage/persona-tag-validator.js';

describe('validateTags', () => {
  it('accepts every value in the PROFILE_VOCAB', () => {
    for (const tag of KNOWN_TAGS) {
      expect(validateTags([tag])).toEqual({ ok: true });
    }
  });

  it('accepts empty array', () => {
    expect(validateTags([])).toEqual({ ok: true });
  });

  it('rejects unknown field prefix', () => {
    const r = validateTags(['user:admin']);
    expect(r.ok).toBe(false);
    expect(r.invalid).toContain('user:admin');
  });

  it('rejects unknown value within known field', () => {
    const r = validateTags(['role:manager']);
    expect(r.ok).toBe(false);
    expect(r.invalid).toEqual(['role:manager']);
  });

  it('rejects malformed tag (no colon)', () => {
    const r = validateTags(['developer']);
    expect(r.ok).toBe(false);
    expect(r.invalid).toEqual(['developer']);
  });

  it('lists all invalid tags in a mixed batch', () => {
    const r = validateTags(['role:developer', 'role:manager', 'cloud:oops']);
    expect(r.ok).toBe(false);
    expect(r.invalid).toEqual(['role:manager', 'cloud:oops']);
  });

  it('KNOWN_TAGS contains role:developer and cloud:btp', () => {
    expect(KNOWN_TAGS).toContain('role:developer');
    expect(KNOWN_TAGS).toContain('cloud:btp');
    expect(KNOWN_TAGS).toContain('deployment:onprem');
  });
});
