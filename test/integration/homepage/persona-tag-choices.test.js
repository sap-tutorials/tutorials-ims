// test/integration/homepage/persona-tag-choices.test.js
//
// (#763) Integration test for AdminService.PersonaTagChoices value-help entity.
// Verifies that GET /admin/PersonaTagChoices returns every KNOWN_TAG as a
// { tag } row, including spot-checks for 'role:developer' and 'cloud:btp'.
//
// The expected row count is derived from KNOWN_TAGS (single source of truth
// in srv/lib/homepage/persona-tag-validator.js) so vocab expansions in
// srv/lib/branch/profile-fields.js (e.g. #1030 preferredEventRegion) don't
// silently fail this suite.
//
// Auth: admin/admin (matches .cdsrc.json mock users).

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { KNOWN_TAGS } from '../../../srv/lib/homepage/persona-tag-validator.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' }, validateStatus: () => true };

describe('PersonaTagChoices value-help entity', () => {
  it('returns HTTP 200 for GET /admin/PersonaTagChoices', async () => {
    const r = await project.get('/admin/PersonaTagChoices', adminAuth);
    expect(r.status).toBe(200);
  });

  it('returns one row per KNOWN_TAG', async () => {
    const r = await project.get('/admin/PersonaTagChoices', adminAuth);
    expect(r.status).toBe(200);
    const items = r.data?.value ?? r.data;
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(KNOWN_TAGS.length);
    expect(new Set(items.map((row) => row.tag))).toEqual(new Set(KNOWN_TAGS));
  });

  it('every row has a non-empty tag field', async () => {
    const r = await project.get('/admin/PersonaTagChoices', adminAuth);
    const items = r.data?.value ?? r.data;
    for (const row of items) {
      expect(typeof row.tag).toBe('string');
      expect(row.tag.length).toBeGreaterThan(0);
    }
  });

  it('contains role:developer and cloud:btp', async () => {
    const r = await project.get('/admin/PersonaTagChoices', adminAuth);
    const items = r.data?.value ?? r.data;
    const tags = items.map((row) => row.tag);
    expect(tags).toContain('role:developer');
    expect(tags).toContain('cloud:btp');
  });
});
