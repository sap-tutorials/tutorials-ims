import { describe, it, expect } from 'vitest';
import {
  slugifyTopic, flattenTopicSlug, parseTitlePath, buildTopicSlugMap, normalizeLegacyTopicSlug,
} from '../../srv/lib/topic-slug.js';

// serveHandler gates every slug through this (content-store.js). A slug that
// fails it 404s — the #2099 defect that made all 152 topic detail pages
// un-servable. Every generated slug MUST satisfy it.
const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

describe('slugifyTopic', () => {
  it('folds spaces, colons and slashes to single hyphens (real titlePath shape)', () => {
    const s = slugifyTopic('software product : technology platform / sap business technology platform / open connectors');
    expect(s).toBe('software-product-technology-platform-sap-business-technology-platform-open-connectors');
    expect(VALID_SLUG.test(s)).toBe(true);
  });
  it('trims leading/trailing separators and collapses runs', () => {
    expect(slugifyTopic('  : Topic : ')).toBe('topic');
    expect(slugifyTopic('a---b   c')).toBe('a-b-c');
  });
});

describe('flattenTopicSlug', () => {
  it('collapses -- and lowercases', () => {
    expect(flattenTopicSlug('sap-hana-cloud--data-lake')).toBe('sap-hana-cloud-data-lake');
    expect(flattenTopicSlug('SAP-HANA-Cloud')).toBe('sap-hana-cloud');
  });
  it('produces a VALID_SLUG-safe result from spaces/colons/slashes', () => {
    const s = flattenTopicSlug('topic : technology development / cloud operations');
    expect(s).toBe('topic-technology-development-cloud-operations');
    expect(VALID_SLUG.test(s)).toBe(true);
  });
});

describe('parseTitlePath', () => {
  it('splits facet, value and -- segments', () => {
    expect(parseTitlePath('software-product-function>sap-hana-cloud--data-lake')).toEqual({
      facet: 'software-product-function',
      value: 'sap-hana-cloud--data-lake',
      segments: ['sap-hana-cloud', 'data-lake'],
    });
  });
});

describe('buildTopicSlugMap', () => {
  it('qualifies collisions with facet, first-by-titlePath wins bare', () => {
    const { bySlug } = buildTopicSlugMap([
      { titlePath: 'software-product>foo-bar', label: 'A' },
      { titlePath: 'topic>foo--bar', label: 'B' }, // also flattens to foo-bar
    ]);
    expect(bySlug.has('foo-bar')).toBe(true);          // software-product wins (sorts first)
    expect(bySlug.get('foo-bar').label).toBe('A');
    expect(bySlug.has('topic-foo-bar')).toBe(true);    // loser facet-qualified
    expect(bySlug.get('topic-foo-bar').label).toBe('B');
  });

  it('every slug from real-world titlePaths (spaces/colons/slashes, no > facet) is VALID_SLUG-safe', () => {
    const { bySlug } = buildTopicSlugMap([
      { titlePath: 'software product : technology platform / sap business technology platform / open connectors', label: 'X' },
      { titlePath: 'topic : technology development / cloud operations', label: 'Y' },
      { titlePath: 'operating system : android', label: 'Z' },
    ]);
    const slugs = [...bySlug.keys()];
    expect(slugs).toHaveLength(3);
    for (const s of slugs) expect(VALID_SLUG.test(s)).toBe(true);
  });

  it('never emits a leading-hyphen slug when a facetless titlePath collides', () => {
    const { bySlug } = buildTopicSlugMap([
      { titlePath: 'foo : bar', label: 'A' },
      { titlePath: 'foo / bar', label: 'B' }, // slugifies to the same "foo-bar", no > facet
    ]);
    for (const s of bySlug.keys()) expect(VALID_SLUG.test(s)).toBe(true);
    expect(bySlug.has('foo-bar')).toBe(true);
    expect(bySlug.has('foo-bar-2')).toBe(true); // index-suffixed, not "-foo-bar"
  });
});

describe('normalizeLegacyTopicSlug', () => {
  it('strips a trailing numeric disambiguator', () => {
    expect(normalizeLegacyTopicSlug('sap-hana-smart-data-streaming-development-2'))
      .toBe('sap-hana-smart-data-streaming-development');
    expect(normalizeLegacyTopicSlug('sap-hana-cloud')).toBe('sap-hana-cloud');
  });
});
