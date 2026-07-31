// test/hybrid/puzzle-grid-templates-hybrid.test.js
// Smoke: verifies built-in GridTemplates rows are present in real HANA and
// that the blacks column is valid JSON.
// Run: npm run test:hybrid -- --project hybrid test/hybrid/puzzle-grid-templates-hybrid.test.js
// Requires: cds bind + cf login (targets a non-prod HANA container).
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe.runIf(isSafeForWrites())('GridTemplates (hybrid/HANA)', () => {
  it('built-in templates are present and blacks parse as JSON', async () => {
    const res = await fetch(
      `${cds.server.url}/admin/GridTemplates?$filter=isBuiltin eq true&$top=1`,
    );
    const body = await res.json();
    expect(body.value.length).toBe(1);
    expect(() => JSON.parse(body.value[0].blacks)).not.toThrow();
  });
});
