import { describe, it, expect } from 'vitest';
import { buildPreviewLinks } from '../../srv/lib/preview-links.js';

describe('buildPreviewLinks', () => {
  it('builds both links for a published mission', () => {
    expect(buildPreviewLinks({ published: true, slug: 'my-mission', kind: 'mission' })).toEqual({
      qaPreviewUrl:     '/tutorials-qa/mission-my-mission',
      qaPreviewLabel:   'View QA Preview',
      mainPreviewUrl:   '/tutorials/mission-my-mission',
      mainPreviewLabel: 'View Live Mission',
    });
  });

  it('builds both links for a published group with group- prefix and Group label', () => {
    expect(buildPreviewLinks({ published: true, slug: 'my-group', kind: 'group' })).toEqual({
      qaPreviewUrl:     '/tutorials-qa/group-my-group',
      qaPreviewLabel:   'View QA Preview',
      mainPreviewUrl:   '/tutorials/group-my-group',
      mainPreviewLabel: 'View Live Group',
    });
  });

  it('returns all-undefined for an unpublished mission', () => {
    const out = buildPreviewLinks({ published: false, slug: 'my-mission', kind: 'mission' });
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });

  it('returns all-undefined when slug is missing', () => {
    const out = buildPreviewLinks({ published: true, slug: null, kind: 'mission' });
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });

  it('returns all-undefined for an invalid kind', () => {
    const out = buildPreviewLinks({ published: true, slug: 'x', kind: 'tutorial' });
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });

  it('returns all-undefined when published is not strictly true', () => {
    const out = buildPreviewLinks({ published: 1, slug: 'x', kind: 'mission' });
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });
});
