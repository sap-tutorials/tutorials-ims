import { describe, it, expect } from 'vitest';
import { HOMEPAGE_SHELVES_DEFAULTS } from '../../../srv/lib/homepage/homepage-shelves-defaults.js';
import { validateTags } from '../../../srv/lib/homepage/persona-tag-validator.js';

// Guards the inline canonical baseline that replaced the retired seed CSV +
// third-party staging JSON. No DB required — pure data validation, mirroring
// the checks the old scripts/__tests__/seed-thirdparty-data test performed.
const VERBS = new Set(['LEARN', 'BUILD', 'INTEGRATE', 'MODEL', 'OPERATE', 'AI', 'CONNECT']);
const SHELVES = new Set(['START_HERE', 'REFERENCE', 'TOOLS', 'KEEP_CURRENT']);
const BADGES = new Set(['NEW', 'UPDATED', 'HIDDEN_GEM', 'THIRD_PARTY']);

describe('HOMEPAGE_SHELVES_DEFAULTS (canonical baseline)', () => {
  it('every row has the mandatory fields with correct primitive types', () => {
    for (const r of HOMEPAGE_SHELVES_DEFAULTS) {
      expect(typeof r.verb, `verb for ${r.title}`).toBe('string');
      expect(typeof r.url, `url for ${r.title}`).toBe('string');
      expect(typeof r.title, `title for ${r.url}`).toBe('string');
      expect(r.title.length).toBeGreaterThan(0);
      expect(typeof r.sortOrder, `sortOrder for ${r.title}`).toBe('number');
      expect(typeof r.isActive, `isActive for ${r.title}`).toBe('boolean');
      expect(typeof r.isExternal, `isExternal for ${r.title}`).toBe('boolean');
    }
  });

  it('every verb / shelf / badge value is a valid enum member', () => {
    for (const r of HOMEPAGE_SHELVES_DEFAULTS) {
      expect(VERBS, `verb ${r.verb}`).toContain(r.verb);
      expect(SHELVES, `shelf ${r.shelf}`).toContain(r.shelf);
      if (r.badge != null) expect(BADGES, `badge ${r.badge}`).toContain(r.badge);
    }
  });

  it('(verb,url) is unique across all rows (matches @assert.unique.verbUrl)', () => {
    const seen = new Set();
    for (const r of HOMEPAGE_SHELVES_DEFAULTS) {
      const key = `${r.verb}|${r.url}`;
      expect(seen.has(key), `duplicate (verb,url): ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('every personaTag is in the known vocabulary', () => {
    for (const r of HOMEPAGE_SHELVES_DEFAULTS) {
      if (r.personaTags?.length) {
        const res = validateTags(r.personaTags);
        expect(res.ok, `bad personaTags on ${r.title}: ${JSON.stringify(res.invalid)}`).toBe(true);
      }
    }
  });

  it('covers all 7 verbs and includes the curated third-party links', () => {
    const verbs = new Set(HOMEPAGE_SHELVES_DEFAULTS.map((r) => r.verb));
    for (const v of VERBS) expect(verbs, `missing verb ${v}`).toContain(v);
    const titles = HOMEPAGE_SHELVES_DEFAULTS.map((r) => r.title).join(' | ');
    for (const t of ['Dremio', 'Reltio', 'Prior Labs', 'n8n']) {
      expect(titles, `missing third-party link ${t}`).toContain(t);
    }
  });
});
