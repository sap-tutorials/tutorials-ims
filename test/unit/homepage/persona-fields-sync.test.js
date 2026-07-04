import { describe, it, expect } from 'vitest';
import { KNOWN_TAGS } from '../../../srv/lib/homepage/persona-tag-validator.js';
import { PROFILE_VOCAB } from '../../../srv/lib/branch/profile-fields.js';

describe('KNOWN_TAGS is derived from PROFILE_VOCAB', () => {
  it('has one tag per field/value pair, no more, no less', () => {
    const expected = Object.entries(PROFILE_VOCAB).flatMap(
      ([f, vs]) => vs.map((v) => `${f}:${v}`)
    );
    expect(KNOWN_TAGS.sort()).toEqual(expected.sort());
  });
});
