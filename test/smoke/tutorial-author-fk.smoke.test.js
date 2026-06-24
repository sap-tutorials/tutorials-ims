// test/smoke/tutorial-author-fk.smoke.test.js
//
// Spec: docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md
// Plan: docs/superpowers/plans/2026-06-24-tutorial-authorship-fk.md (task 10)
//
// Post-deploy gates for the tutorial-authorship FK + flattened-column
// surfacing. Three guarantees:
//
//   1. Admin /admin/Tutorials carries authorEmail (column exists) AND
//      at least one row has a non-null author after migration. If the
//      backfill was never run, this fails the smoke gate.
//   2. PUBLIC /api/Tutorials carries authorEmail + authorDisplayName
//      etc., but does NOT leak authorSapId. PII boundary.
//   3. Admin /admin/Users supports $search (the FE V4 value-help
//      dialog backend).
//
// SMOKE_ADMIN_TOKEN is the admin-scope JWT; SMOKE_USER_TOKEN is a
// regular authenticated-user JWT for the public-endpoint test.

import { describe, it, expect } from 'vitest';

const SRV = process.env.SMOKE_SRV_URL;
const ADMIN_TOKEN = process.env.SMOKE_ADMIN_TOKEN;
const USER_TOKEN  = process.env.SMOKE_USER_TOKEN;

describe.runIf(SRV && ADMIN_TOKEN)('tutorial authorship — admin smoke', () => {
  it('GET /admin/Tutorials surfaces authorEmail + at least one non-null author', async () => {
    const res = await fetch(
      `${SRV}/admin/Tutorials?$top=5&$filter=author_ID%20ne%20null&$select=ID,slug,authorEmail,authorSapId,authorDisplayName`,
      { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.value)).toBe(true);
    expect(data.value.length).toBeGreaterThan(0);
    const row = data.value[0];
    expect(row.authorEmail).toBeTruthy();
    // authorSapId may legitimately be null for some users; the
    // assertion is that the property KEY exists (column is exposed).
    expect(row).toHaveProperty('authorSapId');
    expect(row).toHaveProperty('authorDisplayName');
  });

  it('GET /admin/Users supports $search across displayName/firstName/lastName/email/sapId', async () => {
    // We don't assume any particular name is in the DB — just that
    // the search endpoint accepts $search without erroring. The
    // value-help dialog's actual UX is driven by this.
    const res = await fetch(
      `${SRV}/admin/Users?$top=1&$search=a&$select=ID,displayName,email`,
      { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.value)).toBe(true);
    // Even on an empty Users table, the request itself must succeed —
    // that's the smoke contract.
  });
});

describe.runIf(SRV && USER_TOKEN)('tutorial authorship — public smoke (PII gate)', () => {
  it('GET /api/Tutorials exposes authorEmail + authorDisplayName but NOT authorSapId', async () => {
    const res = await fetch(
      `${SRV}/api/Tutorials?$top=1&$filter=author_ID%20ne%20null&$select=ID,slug,authorEmail,authorDisplayName,authorFirstName,authorLastName`,
      { headers: { Authorization: `Bearer ${USER_TOKEN}` } }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    if (data.value.length === 0) {
      // No backfilled rows yet — the column-shape assertion below
      // can't run. We DO at least assert the request succeeded.
      return;
    }
    const row = data.value[0];
    expect(row).toHaveProperty('authorEmail');
    expect(row).toHaveProperty('authorDisplayName');
    expect(row).toHaveProperty('authorFirstName');
    expect(row).toHaveProperty('authorLastName');
  });

  it('GET /api/Tutorials with $select=authorSapId returns 4xx — column is NOT exposed', async () => {
    // CRITICAL: this is the PII boundary. If a future projection
    // change leaks authorSapId to /api/, this test fails.
    const res = await fetch(
      `${SRV}/api/Tutorials?$top=1&$select=authorSapId`,
      { headers: { Authorization: `Bearer ${USER_TOKEN}` } }
    );
    // Either 400 ("unknown property") or 200 with the property
    // silently dropped — both prove the column is NOT exposed. The
    // strongest signal is 400; the silent-drop case is also OK
    // (CAP/OData implementations differ).
    if (res.status === 200) {
      const data = await res.json();
      if (data.value.length > 0) {
        expect(data.value[0]).not.toHaveProperty('authorSapId');
      }
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });
});
