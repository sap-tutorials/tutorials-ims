import { describe, it, expect } from 'vitest';
import { extractProfileOverride } from '../../../srv/lib/branch/profile-override.js';

function fakeReq({ scopes = [], query = {} } = {}) {
  return {
    user: {
      id: scopes.length ? 'user-123' : 'anonymous',
      is: (scope) => scopes.includes(scope),
    },
    query,
  };
}

describe('extractProfileOverride', () => {
  it('returns the override for an authenticated Tutorial.Author with a valid query value', () => {
    const out = extractProfileOverride(
      fakeReq({ scopes: ['Tutorial.Author'], query: { 'profile.deployment': 'cloud' } })
    );
    expect(out).toEqual({ deployment: 'cloud' });
  });

  it('returns the override for an authenticated Admin (no Tutorial.Author) — gate widening (pivot 2)', () => {
    const out = extractProfileOverride(
      fakeReq({ scopes: ['Admin'], query: { 'profile.deployment': 'cloud' } })
    );
    expect(out).toEqual({ deployment: 'cloud' });
  });

  it('returns null for an authenticated user with neither scope', () => {
    const out = extractProfileOverride(
      fakeReq({ scopes: ['DeveloperApp'], query: { 'profile.deployment': 'cloud' } })
    );
    expect(out).toBeNull();
  });

  it('returns null for an anonymous request', () => {
    const out = extractProfileOverride(
      fakeReq({ scopes: [], query: { 'profile.deployment': 'cloud' } })
    );
    expect(out).toBeNull();
  });

  it('drops fields with values not in PROFILE_VOCAB; returns null when nothing valid remains', () => {
    const out = extractProfileOverride(
      fakeReq({ scopes: ['Tutorial.Author'], query: { 'profile.deployment': 'hybrid' } })
    );
    expect(out).toBeNull();
  });

  it('treats empty-string the same as missing — express-default qs parser fragility guard', () => {
    const out = extractProfileOverride(
      fakeReq({
        scopes: ['Tutorial.Author'],
        query: { 'profile.deployment': 'cloud', 'profile.role': '' },
      })
    );
    expect(out).toEqual({ deployment: 'cloud' });
  });
});
