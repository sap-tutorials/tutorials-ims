/**
 * Tests for the #1278 single-tutorial fast path: publish-content.ts --slug
 * filter (filterToSlug). Reducing the discovered map to one slug is what lets
 * a single-tutorial republish hash+publish 1 file instead of ~1372; the server
 * carries the rest forward at commit (normal delta behavior).
 *
 * Issue: #1278 (follow-up to #1154).
 */
import { describe, it, expect } from 'vitest';
import { filterToSlug } from '../../scripts/publish-content.ts';

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
