/**
 * Tests for the #1278 single-tutorial fast path: publish-content.ts --slug
 * filter (filterToSlug). Reducing the discovered map to one slug is what lets
 * a single-tutorial republish hash+publish 1 file instead of ~1372; the server
 * carries the rest forward at commit (normal delta behavior).
 *
 * Issue: #1278 (follow-up to #1154).
 */
import { describe, it, expect } from 'vitest';
import { filterToSlug, filterToSlugs } from '../../scripts/publish-content.ts';

describe('filterToSlug (#1278)', () => {
  const build = () => new Map([
    ['abap-create-project', 'hugo/public/tutorials/abap-create-project/index.html'],
    ['hana-cloud-deploying', 'hugo/public/tutorials/hana-cloud-deploying/index.html'],
    ['concept-cap', 'hugo/public/concepts/cap/index.html'],
  ]);

  it('reduces the map to only the requested slug and returns true', () => {
    const m = build();
    const applied = filterToSlug(m, 'hana-cloud-deploying');
    expect(applied).toBe(true);
    expect([...m.keys()]).toEqual(['hana-cloud-deploying']);
    expect(m.get('hana-cloud-deploying')).toBe('hugo/public/tutorials/hana-cloud-deploying/index.html');
  });

  it('is a no-op returning false when slug is empty (whole-catalog delta)', () => {
    const m = build();
    const applied = filterToSlug(m, '');
    expect(applied).toBe(false);
    expect(m.size).toBe(3);   // untouched
  });

  it('can target a concept-* slug too', () => {
    const m = build();
    filterToSlug(m, 'concept-cap');
    expect([...m.keys()]).toEqual(['concept-cap']);
  });

  it('throws (loud fail) when the slug is not present — no silent no-op', () => {
    const m = build();
    expect(() => filterToSlug(m, 'does-not-exist')).toThrow(/not found/);
    // map is left as-is on throw (caller exits, never publishes)
    expect(m.size).toBe(3);
  });

  it('throws on a near-miss / wrong-case slug rather than publishing nothing', () => {
    const m = build();
    expect(() => filterToSlug(m, 'ABAP-Create-Project')).toThrow(/not found/);
  });
});

describe('filterToSlugs (multi-slug dispatch)', () => {
  const build = () => new Map([
    ['abap-create-project', 'hugo/public/tutorials/abap-create-project/index.html'],
    ['hana-cloud-deploying', 'hugo/public/tutorials/hana-cloud-deploying/index.html'],
    ['concept-cap', 'hugo/public/concepts/cap/index.html'],
    ['devtoberfest-week1', 'hugo/public/tutorials/devtoberfest-week1/index.html'],
  ]);

  it('reduces the map to exactly the requested slugs and returns true', () => {
    const m = build();
    const applied = filterToSlugs(m, ['hana-cloud-deploying', 'devtoberfest-week1']);
    expect(applied).toBe(true);
    expect([...m.keys()].sort()).toEqual(['devtoberfest-week1', 'hana-cloud-deploying']);
    expect(m.get('hana-cloud-deploying')).toBe('hugo/public/tutorials/hana-cloud-deploying/index.html');
  });

  it('preserves a single-element list (equivalent to filterToSlug)', () => {
    const m = build();
    filterToSlugs(m, ['concept-cap']);
    expect([...m.keys()]).toEqual(['concept-cap']);
  });

  it('is a no-op returning false on an empty list (whole-catalog delta)', () => {
    const m = build();
    expect(filterToSlugs(m, [])).toBe(false);
    expect(m.size).toBe(4);
  });

  it('ignores blank/whitespace entries and dedups', () => {
    const m = build();
    filterToSlugs(m, ['concept-cap', '', '  ', 'concept-cap']);
    expect([...m.keys()]).toEqual(['concept-cap']);
  });

  it('throws (loud fail) if ANY requested slug is absent — no partial silent publish', () => {
    const m = build();
    expect(() => filterToSlugs(m, ['concept-cap', 'does-not-exist'])).toThrow(/not found/);
    expect(m.size).toBe(4);   // untouched on throw
  });
});
