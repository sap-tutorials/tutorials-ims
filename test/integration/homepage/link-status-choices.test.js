// test/integration/homepage/link-status-choices.test.js
//
// Value-help for HomepageShelves / HomepageForYouCandidates.linkStatusOverride.
// The field is a bare String-enum (HomepageLinkStatus) which does NOT reliably
// materialise a Fiori dropdown from @Common.ValueListWithFixedValues alone, so
// it is backed by an explicit in-memory code list (LinkStatusChoices), exactly
// like verb/shelf. This suite locks in:
//   1. the LinkStatusChoices READ handler returns the three admin pin targets,
//   2. UNKNOWN is intentionally absent (job sentinel; blank = auto-detect),
//   3. the $metadata wires a LinkStatusChoices ValueList onto linkStatusOverride
//      for BOTH entities.
//
// Auth: admin/admin (matches .cdsrc.json mock users).

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' }, validateStatus: () => true };

const EXPECTED = [
  { code: 'OK',     label: 'OK (force healthy)' },
  { code: 'SLOW',   label: 'Slow'               },
  { code: 'BROKEN', label: 'Broken'             },
];

describe('LinkStatusChoices value-help entity', () => {
  it('returns HTTP 200 for GET /admin/LinkStatusChoices', async () => {
    const r = await project.get('/admin/LinkStatusChoices', adminAuth);
    expect(r.status).toBe(200);
  });

  it('returns exactly the three admin pin targets (OK/SLOW/BROKEN), no UNKNOWN', async () => {
    const r = await project.get('/admin/LinkStatusChoices', adminAuth);
    const items = r.data?.value ?? r.data;
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(EXPECTED.length);
    expect(new Set(items.map((row) => row.code))).toEqual(new Set(['OK', 'SLOW', 'BROKEN']));
    expect(items.map((row) => row.code)).not.toContain('UNKNOWN');
  });

  it('every row has a non-empty code and label', async () => {
    const r = await project.get('/admin/LinkStatusChoices', adminAuth);
    const items = r.data?.value ?? r.data;
    for (const row of items) {
      expect(typeof row.code).toBe('string');
      expect(row.code.length).toBeGreaterThan(0);
      expect(typeof row.label).toBe('string');
      expect(row.label.length).toBeGreaterThan(0);
    }
  });

  it('labels match the served code list', async () => {
    const r = await project.get('/admin/LinkStatusChoices', adminAuth);
    const items = r.data?.value ?? r.data;
    const byCode = Object.fromEntries(items.map((row) => [row.code, row.label]));
    for (const { code, label } of EXPECTED) expect(byCode[code]).toBe(label);
  });

  it('$metadata wires a LinkStatusChoices ValueList onto linkStatusOverride', async () => {
    const { status, data } = await project.get('/admin/$metadata', adminAuth);
    expect(status).toBe(200);
    expect(data).toContain('LinkStatusChoices');
    // The override binding must target the code list; a missing binding would
    // regress the field back to free text.
    expect(data).toContain('linkStatusOverride');
    expect(data).toContain('CollectionPath');
  });
});
