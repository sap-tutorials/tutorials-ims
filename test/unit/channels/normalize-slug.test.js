// test/unit/channels/normalize-slug.test.js
// Pure unit tests — no DB, no cds.test(), pure function calls only.
import { describe, it, expect } from 'vitest';
import {
  toKebabSlug,
  generateSlug,
  normalizeChannel,
} from '../../../srv/lib/channels/normalize.cjs';

describe('toKebabSlug', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(toKebabSlug('SAP HANA Cloud')).toBe('sap-hana-cloud');
  });

  it('collapses multiple non-alphanumeric runs into a single hyphen', () => {
    expect(toKebabSlug('Coffee & Code — Weekly!')).toBe('coffee-code-weekly');
  });

  it('strips leading and trailing hyphens', () => {
    expect(toKebabSlug('  Hello World  ')).toBe('hello-world');
  });

  it('handles names that are purely punctuation → empty string', () => {
    expect(toKebabSlug('---')).toBe('');
  });

  it('preserves digits', () => {
    expect(toKebabSlug('UI5 2.0 Samples')).toBe('ui5-2-0-samples');
  });
});

describe('generateSlug', () => {
  it('returns the kebab slug when seenSlugs is empty', () => {
    const seen = new Set();
    expect(generateSlug('SAP HANA Cloud', seen)).toBe('sap-hana-cloud');
    expect(seen.has('sap-hana-cloud')).toBe(true);
  });

  it('appends -2 on first collision, -3 on second', () => {
    const seen = new Set(['sap-hana-cloud']);
    expect(generateSlug('SAP HANA Cloud', seen)).toBe('sap-hana-cloud-2');
    seen.add('sap-hana-cloud-2');
    expect(generateSlug('SAP HANA Cloud', seen)).toBe('sap-hana-cloud-3');
  });

  it('skips the suffix entirely when seenSlugs is undefined (no-dedup mode)', () => {
    // Used when normalizing a single channel in isolation (e.g., unit tests
    // that don't care about dedup). Must not throw.
    expect(generateSlug('My Channel', undefined)).toBe('my-channel');
  });

  it('does not mutate seen for no-dedup mode', () => {
    // Just ensures no crash when seen is undefined
    expect(() => generateSlug('X', undefined)).not.toThrow();
  });
});

describe('normalizeChannel — slug + feedUrl fields', () => {
  const BASE_RAW = {
    id: 'portal-001',
    name: 'SAP Developers',
    url: 'https://developers.sap.com',
    related_urls: [],
    aliases: [],
    purpose: null,
    notes: null,
    owner_type: null,
    isSapOwned: true,
    category: 'Official',
    subcategory: null,
    platform: 'Web',
    status: 'Active',
    focus_areas: [],
    tags: [],
    update_frequency: null,
    github_stars: null,
    subscribers: null,
  };

  it('populates slug from name when no seenSlugs provided', () => {
    const row = normalizeChannel(BASE_RAW, '2026-09');
    expect(row.slug).toBe('sap-developers');
  });

  it('populates slug with dedup suffix when name collides', () => {
    const seen = new Set(['sap-developers']);
    const row = normalizeChannel(BASE_RAW, '2026-09', seen);
    expect(row.slug).toBe('sap-developers-2');
  });

  it('feedUrl is null when raw.feed is absent', () => {
    const row = normalizeChannel(BASE_RAW, '2026-09');
    expect(row.feedUrl).toBeNull();
  });

  it('feedUrl is populated from raw.feed when present', () => {
    const raw = { ...BASE_RAW, feed: 'https://developers.sap.com/feed.xml' };
    const row = normalizeChannel(raw, '2026-09');
    expect(row.feedUrl).toBe('https://developers.sap.com/feed.xml');
  });

  it('contentHash changes when feedUrl changes (feedUrl is content-owned)', () => {
    const row1 = normalizeChannel(BASE_RAW, '2026-09');
    const raw2 = { ...BASE_RAW, feed: 'https://example.com/feed.xml' };
    const row2 = normalizeChannel(raw2, '2026-09');
    expect(row1.contentHash).not.toBe(row2.contentHash);
  });

  it('slug is NOT included in contentHash (re-ingest must not re-hash on dedup suffix change)', () => {
    const seen1 = new Set();
    const seen2 = new Set(['sap-developers']); // causes suffix
    const row1 = normalizeChannel(BASE_RAW, '2026-09', seen1);
    const row2 = normalizeChannel(BASE_RAW, '2026-09', seen2);
    expect(row1.contentHash).toBe(row2.contentHash);
  });
});
