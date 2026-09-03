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
  it('splits facet on " : " and levels on " / " (real titlePath shape)', () => {
    expect(parseTitlePath('Software Product : Enterprise Management / SAP S 4HANA')).toEqual({
      facet: 'Software Product',
      value: 'Enterprise Management / SAP S 4HANA',
      segments: ['Enterprise Management', 'SAP S 4HANA'],
    });
  });
  it('single-level value yields one segment', () => {
    expect(parseTitlePath('Operating System : Android')).toEqual({
      facet: 'Operating System',
      value: 'Android',
      segments: ['Android'],
    });
  });
  it('facetless titlePath yields empty facet and the whole string as value', () => {
    expect(parseTitlePath('Just A Topic')).toEqual({
      facet: '',
      value: 'Just A Topic',
      segments: ['Just A Topic'],
    });
  });
});

describe('buildTopicSlugMap', () => {
  it('derives the slug from the FULL titlePath and parses facet/segments', () => {
    const { bySlug } = buildTopicSlugMap([
      { titlePath: 'Operating System : Android', label: null, tutorialCount: 5, conceptCount: 2 },
    ]);
    expect(bySlug.has('operating-system-android')).toBe(true);
    const t = bySlug.get('operating-system-android');
    expect(t.facet).toBe('Operating System');
    expect(t.segments).toEqual(['Android']);
    expect(t.label).toBe('Android'); // last segment when no curated label
    expect(VALID_SLUG.test(t.slug)).toBe(true);
  });

  it('parses a multi-level hierarchy into segments while keeping the full-path slug', () => {
    const { bySlug } = buildTopicSlugMap([
      { titlePath: 'Software Product : Enterprise Management / SAP S 4HANA' },
    ]);
    const t = bySlug.get('software-product-enterprise-management-sap-s-4hana');
    expect(t).toBeTruthy();
    expect(t.facet).toBe('Software Product');
    expect(t.segments).toEqual(['Enterprise Management', 'SAP S 4HANA']);
    expect(t.label).toBe('SAP S 4HANA');
  });

  it('index-suffixes a rare full-path slug collision (no leading hyphen)', () => {
    const { bySlug } = buildTopicSlugMap([
      { titlePath: 'Foo : Bar', label: 'A' },
      { titlePath: 'Foo / Bar', label: 'B' }, // slugifies to the same "foo-bar"
    ]);
    for (const s of bySlug.keys()) expect(VALID_SLUG.test(s)).toBe(true);
    expect(bySlug.has('foo-bar')).toBe(true);
    expect(bySlug.has('foo-bar-2')).toBe(true); // index-suffixed, not "-foo-bar"
  });

  it('every slug from real-world titlePaths (spaces/colons/slashes) is VALID_SLUG-safe', () => {
    const { bySlug } = buildTopicSlugMap([
      { titlePath: 'software product : technology platform / sap business technology platform / open connectors', label: 'X' },
      { titlePath: 'topic : technology development / cloud operations', label: 'Y' },
      { titlePath: 'operating system : android', label: 'Z' },
    ]);
    const slugs = [...bySlug.keys()];
    expect(slugs).toHaveLength(3);
    for (const s of slugs) expect(VALID_SLUG.test(s)).toBe(true);
  });
});

describe('normalizeLegacyTopicSlug', () => {
  it('strips a trailing numeric disambiguator', () => {
    expect(normalizeLegacyTopicSlug('sap-hana-smart-data-streaming-development-2'))
      .toBe('sap-hana-smart-data-streaming-development');
    expect(normalizeLegacyTopicSlug('sap-hana-cloud')).toBe('sap-hana-cloud');
  });
});
