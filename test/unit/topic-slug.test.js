import { describe, it, expect } from 'vitest';
import {
  flattenTopicSlug, parseTitlePath, buildTopicSlugMap, normalizeLegacyTopicSlug,
} from '../../srv/lib/topic-slug.js';

describe('flattenTopicSlug', () => {
  it('collapses -- and lowercases', () => {
    expect(flattenTopicSlug('sap-hana-cloud--data-lake')).toBe('sap-hana-cloud-data-lake');
    expect(flattenTopicSlug('SAP-HANA-Cloud')).toBe('sap-hana-cloud');
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
});

describe('normalizeLegacyTopicSlug', () => {
  it('strips a trailing numeric disambiguator', () => {
    expect(normalizeLegacyTopicSlug('sap-hana-smart-data-streaming-development-2'))
      .toBe('sap-hana-smart-data-streaming-development');
    expect(normalizeLegacyTopicSlug('sap-hana-cloud')).toBe('sap-hana-cloud');
  });
});
