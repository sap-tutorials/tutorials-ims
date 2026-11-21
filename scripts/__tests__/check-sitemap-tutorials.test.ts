// scripts/__tests__/check-sitemap-tutorials.test.ts
//
// Unit tests for the build-time sitemap guard (scripts/check-sitemap-tutorials.cjs)
// and the shared tutorial-<loc> counter used by the catalog-only preserve step
// (scripts/seed-sitemap-from-deployed.ts). Both defend the 2026-09-03 sitemap-wipe
// class: a catalog-only rebuild republished the page-sitemap.xml blob with zero
// /tutorials/ URLs, dropping the live sitemap from ~1.6k links to ~180.
//
// We import the pure cores and assert against synthetic sitemap XML — same
// approach as check-verb-shelves.test.ts. The CLI wiring (file read + exit code)
// is exercised by the live rebuild-content.yml guard step.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { countTutorialLocs } = require('../check-sitemap-tutorials.cjs');
import { countTutorialLocs as countTutorialLocsTs } from '../seed-sitemap-from-deployed';
import { buildListedSlugSet } from '../fetch-sitemap-catalog.js';

const urlset = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  locs.map((l) => `  <url><loc>${l}</loc><lastmod>2026-09-03T13:31:00Z</lastmod></url>`).join('\n') +
  `\n</urlset>\n`;

const HOST = 'https://developers.sap.com';

// The two implementations are deliberately duplicated (a .cjs guard + a .ts
// preserve script that can't cleanly import the .cjs under tsx). Run every case
// through BOTH so they can never silently diverge.
const impls: Array<[string, (xml: string) => number]> = [
  ['check-sitemap-tutorials.cjs', countTutorialLocs],
  ['seed-sitemap-from-deployed.ts', countTutorialLocsTs],
];

for (const [name, count] of impls) {
  describe(`countTutorialLocs (${name})`, () => {
    it('counts absolute tutorial URLs', () => {
      const xml = urlset([
        `${HOST}/`,
        `${HOST}/tutorials/abap-custom-ui-trust-cf/`,
        `${HOST}/tutorials/hana-cloud-mission/`,
        `${HOST}/topics/cap/`,
      ]);
      expect(count(xml)).toBe(2);
    });

    it('returns 0 for the wipe signature: no tutorial URLs', () => {
      const xml = urlset([`${HOST}/`, `${HOST}/browse/`, `${HOST}/authors/tomjung/`, `${HOST}/topics/`]);
      expect(count(xml)).toBe(0);
    });

    it('does NOT count the bare /tutorials/ section index', () => {
      const xml = urlset([`${HOST}/tutorials/`, `${HOST}/tutorials/real-slug/`]);
      expect(count(xml)).toBe(1);
    });

    it('does NOT count /tutorials-<sibling> paths', () => {
      const xml = urlset([`${HOST}/tutorial-navigator/`, `${HOST}/tutorials-qa/foo/`]);
      expect(count(xml)).toBe(0);
    });

    it('matches root-relative tutorial locs defensively', () => {
      const xml = urlset([`/tutorials/some-slug/`, `/browse/`]);
      expect(count(xml)).toBe(1);
    });

    it('handles empty / non-string input', () => {
      expect(count('')).toBe(0);
      // @ts-expect-error deliberate wrong type
      expect(count(null)).toBe(0);
      expect(count('<urlset></urlset>')).toBe(0);
    });
  });
}

// ── [#3099] buildListedSlugSet — visibility filter for sitemap-catalog ──────
//
// Regression tests: UNLISTED and ROLE_GATED slugs MUST NOT appear in the
// sitemap_catalog payload that fetch-sitemap-catalog.ts produces.

describe('buildListedSlugSet (#3099)', () => {
  it('includes LISTED slugs', () => {
    const set = buildListedSlugSet([{ slug: 'listed-slug', title: 'T', visibility: 'LISTED' }]);
    expect(set.has('listed-slug')).toBe(true);
  });

  it('excludes UNLISTED slugs', () => {
    const set = buildListedSlugSet([{ slug: 'unlisted-slug', title: 'T', visibility: 'UNLISTED' }]);
    expect(set.has('unlisted-slug')).toBe(false);
  });

  it('excludes ROLE_GATED slugs', () => {
    const set = buildListedSlugSet([{ slug: 'gated-slug', title: 'T', visibility: 'ROLE_GATED' }]);
    expect(set.has('gated-slug')).toBe(false);
  });

  it('includes slugs with no visibility (null/undefined/missing — public by default)', () => {
    const set = buildListedSlugSet([
      { slug: 'no-vis', title: 'T' },
    ]);
    expect(set.has('no-vis')).toBe(true);
  });

  it('filters mixed-visibility catalog correctly', () => {
    const tutorials = [
      { slug: 'pub-a', title: 'A', visibility: 'LISTED' },
      { slug: 'unlisted-b', title: 'B', visibility: 'UNLISTED' },
      { slug: 'gated-c', title: 'C', visibility: 'ROLE_GATED' },
      { slug: 'pub-d', title: 'D' },                 // no visibility — allowed
      { slug: 'pub-e', title: 'E', visibility: undefined },
    ];
    const set = buildListedSlugSet(tutorials);
    expect(set.has('pub-a')).toBe(true);
    expect(set.has('unlisted-b')).toBe(false);
    expect(set.has('gated-c')).toBe(false);
    expect(set.has('pub-d')).toBe(true);
    expect(set.has('pub-e')).toBe(true);
  });

  it('returns empty set for empty input', () => {
    expect(buildListedSlugSet([]).size).toBe(0);
  });
});
