// test/hybrid/puzzle-grid-templates-hybrid.test.js
// Smoke: verifies built-in GridTemplates rows are present in real HANA and
// that the blacks column is valid JSON.
// Run: npm run test:hybrid -- --project hybrid test/hybrid/puzzle-grid-templates-hybrid.test.js
// Requires: cds bind + cf login (targets a non-prod HANA container).
//
// Reads via the in-process db layer (cds.connect.to('db')), NOT an HTTP fetch:
// AdminService is XSUAA-protected, so an unauthenticated fetch returns
// "Unauthorized" — every other hybrid test in this repo uses cds.connect.to
// for the same reason (verified live on DEV 2026-07-31).
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe.runIf(isSafeForWrites())('GridTemplates (hybrid/HANA)', () => {
  it('built-in templates are present and blacks parse as JSON', async () => {
    const db = await cds.connect.to('db');
    const rows = await db.run(
      SELECT.from('com.sap.developers.ims.GridTemplates')
        .columns('name', 'blacks', 'isBuiltin')
        .where({ isBuiltin: true }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(() => JSON.parse(rows[0].blacks)).not.toThrow();
    expect(Array.isArray(JSON.parse(rows[0].blacks))).toBe(true);
  });
});

