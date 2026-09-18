/**
 * Tests for the #2349 --unpublish-slugs mode: the csv parser/validator and the
 * validateFlagCombo mutex with the other publish modes.
 *
 * The CI-only GITHUB_ACTIONS guard, the endpoint POST, and the cap enforcement
 * against a live server are covered by the endpoint unit test
 * (orphan-purge-endpoint.test.js — the same handler) and the hybrid test; here
 * we cover the pure parse/validate + flag mutex, which need no HTTP or DB.
 *
 * Issue: #2349 (tutorial deletions in GitHub should unpublish the tutorial)
 */
import { describe, it, expect } from 'vitest';
import { parseUnpublishSlugs, validateFlagCombo } from '../../scripts/publish-content.ts';

describe('parseUnpublishSlugs', () => {
  it('parses a single slug', () => {
    expect(parseUnpublishSlugs('devtoberfest-2025-intro')).toEqual(['devtoberfest-2025-intro']);
  });

  it('parses a comma-separated list and trims whitespace', () => {
    expect(parseUnpublishSlugs('foo, bar ,baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('lowercases slugs (lowercase-canonical contract)', () => {
    expect(parseUnpublishSlugs('Foo-Bar')).toEqual(['foo-bar']);
  });

  it('de-dupes while preserving first-seen order', () => {
    expect(parseUnpublishSlugs('a,b,a,c,b')).toEqual(['a', 'b', 'c']);
  });

  it('drops empty tokens from stray/trailing commas', () => {
    expect(parseUnpublishSlugs('a,,b,')).toEqual(['a', 'b']);
  });

  it('throws on a non-slug character', () => {
    expect(() => parseUnpublishSlugs('valid,../etc/passwd')).toThrow(/invalid slug/);
  });

  it('throws on whitespace inside a token', () => {
    expect(() => parseUnpublishSlugs('good bad')).toThrow(/invalid slug/);
  });

  it('throws when nothing valid remains', () => {
    expect(() => parseUnpublishSlugs('')).toThrow(/no valid slugs/);
    expect(() => parseUnpublishSlugs(' , , ')).toThrow(/no valid slugs/);
  });
});

describe('validateFlagCombo with --unpublish-slugs', () => {
  it('unpublishSlugs alone is valid', () => {
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: false, unpublishSlugs: true })).not.toThrow();
  });
  it('unpublishSlugs + force throws', () => {
    expect(() => validateFlagCombo({ force: true, heal: false, verifyOnly: false, unpublishSlugs: true }))
      .toThrow(/mutually exclusive/);
  });
  it('unpublishSlugs + heal throws', () => {
    expect(() => validateFlagCombo({ force: false, heal: true, verifyOnly: false, unpublishSlugs: true }))
      .toThrow(/mutually exclusive/);
  });
  it('unpublishSlugs + verifyOnly throws', () => {
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: true, unpublishSlugs: true }))
      .toThrow(/mutually exclusive/);
  });
  it('unpublishSlugs + purgeOrphans throws', () => {
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: false, purgeOrphans: true, unpublishSlugs: true }))
      .toThrow(/mutually exclusive/);
  });
});
