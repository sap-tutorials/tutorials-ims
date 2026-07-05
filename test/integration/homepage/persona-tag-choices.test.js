// test/integration/homepage/persona-tag-choices.test.js
//
// (#763) Integration test for AdminService.PersonaTagChoices value-help entity.
// Verifies that GET /admin/PersonaTagChoices returns all 13 KNOWN_TAGS as
// { tag } rows, including spot-checks for 'role:developer' and 'cloud:btp'.
//
// Auth: admin/admin (matches .cdsrc.json mock users).

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' }, validateStatus: () => true };

describe('PersonaTagChoices value-help entity', () => {
  it('returns HTTP 200 for GET /admin/PersonaTagChoices', async () => {
    const r = await project.get('/admin/PersonaTagChoices', adminAuth);
    expect(r.status).toBe(200);
  });

  it('returns exactly 13 tag rows', async () => {
    const r = await project.get('/admin/PersonaTagChoices', adminAuth);
    expect(r.status).toBe(200);
    const items = r.data?.value ?? r.data;
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(13);
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
