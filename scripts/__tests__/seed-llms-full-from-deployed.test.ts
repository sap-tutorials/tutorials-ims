// scripts/__tests__/seed-llms-full-from-deployed.test.ts
//
// Unit tests for the catalog-only preserve helper used by the /llms-full.txt
// preserve step (scripts/seed-llms-full-from-deployed.ts). Defends the issue
// #2584 wipe class: a catalog-only rebuild republished the page-llms-full.txt
// blob rendered from only the committed test-tutorial fixture (~722 bytes),
// wiping the live full catalog (~1.4k tutorials, >10 KB) down to one entry.
//
// We import the pure core (countCatalogEntries) and MIN_BYTES and assert against
// synthetic llms-full.txt bodies — same approach as check-sitemap-tutorials.test.ts.
// The CLI wiring (fetch + write + exit code) is exercised by the live
// rebuild-content.yml "Preserve llms-full.txt" step and the "Verify SEO catalog
// freshness" gate.

import { describe, it, expect } from 'vitest';
import { countCatalogEntries, MIN_BYTES } from '../seed-llms-full-from-deployed';

const HEADER =
  `# SAP Developers Tutorials — Full Catalog\n\n` +
  `> Machine-readable catalog of every tutorial and mission.\n\n` +
  `# Tutorials\n\n`;

const entry = (slug: string) =>
  `URL: https://developers.sap.com/tutorials/${slug}/\n` +
  `Markdown: https://developers.sap.com/tutorials/${slug}.md\n` +
  `Title: ${slug}\nType: Tutorial\nLevel: Beginner\nTime: 15 minutes\n` +
  `Tags: cap\nDescription: A tutorial\nAuthor: Thomas Jung\nLast updated: 2026-05-20\n`;

const body = (slugs: string[]) => HEADER + slugs.map(entry).join('\n') + '\n';

describe('countCatalogEntries', () => {
  it('counts one "URL:" line per tutorial entry', () => {
    expect(countCatalogEntries(body(['a-slug', 'b-slug', 'c-slug']))).toBe(3);
  });

  it('counts the fixture-only wipe signature as exactly 1', () => {
    // The 722-byte catalog-only wipe: header + the single test-tutorial fixture.
    expect(countCatalogEntries(body(['test-tutorial']))).toBe(1);
  });

  it('returns 0 for a header-only body with no entries', () => {
    expect(countCatalogEntries(HEADER)).toBe(0);
  });

  it('does NOT count non-anchored "URL:" substrings (e.g. the Markdown line)', () => {
    // Only lines that START with "URL: " + non-space count; the "Markdown:" line
    // and any inline "...URL: ..." prose must not inflate the count.
    const text = HEADER + 'Some prose mentioning URL: inline should not count.\n' + entry('real-slug');
    expect(countCatalogEntries(text)).toBe(1);
  });

  it('handles empty / non-string input', () => {
    expect(countCatalogEntries('')).toBe(0);
    // @ts-expect-error deliberate wrong type
    expect(countCatalogEntries(null)).toBe(0);
    // @ts-expect-error deliberate wrong type
    expect(countCatalogEntries(undefined)).toBe(0);
  });
});

describe('MIN_BYTES threshold', () => {
  it('is the same catalog-fresh threshold the SEO smoke gate enforces', () => {
    // Kept in sync with test/smoke/seo-files.test.js
    // (`expect(text.length).toBeGreaterThan(10000)`).
    expect(MIN_BYTES).toBe(10000);
  });

  it('classifies a fixture-only wipe body as below threshold', () => {
    const wiped = body(['test-tutorial']);
    expect(wiped.length).toBeLessThan(MIN_BYTES);
  });

  it('classifies a full catalog body as at/above threshold', () => {
    const slugs = Array.from({ length: 200 }, (_, i) => `tutorial-${i}`);
    const full = body(slugs);
    expect(full.length).toBeGreaterThanOrEqual(MIN_BYTES);
    expect(countCatalogEntries(full)).toBe(200);
  });
});
