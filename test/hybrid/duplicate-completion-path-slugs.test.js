import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Hybrid-only — see beforeAll guard. Mirrors duplicate-slugs.test.js.
//
// Invariant: every CompletionPaths row has a non-NULL slug, and slugs
// are unique case-insensitively. The Java IMS cutover left 311 rows
// with NULL slug (2026-06-20 audit); the schema-level
// `@assert.unique.slug : [slug]` (PR feat/schema-uniqueness-guardrails)
// will reject any future writes that violate the unique half. This test
// also asserts the NULL half, which @assert.unique alone permits.
//
// Runnable independently: `npx cds bind --exec -- npx vitest run \
//   --project hybrid test/hybrid/duplicate-completion-path-slugs.test.js`

describe('CompletionPaths slug invariant (issue: 2026-06-20 migration audit)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'duplicate-completion-path-slugs.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  });

  it('CompletionPaths has no NULL slug rows', async () => {
    const nullRows = await db.run(`
      SELECT COUNT(*) AS C
        FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"
       WHERE "SLUG" IS NULL
    `);
    const c = nullRows[0]?.C ?? 0;
    if (c > 0) {
      throw new Error(
        `Found ${c} CompletionPaths row(s) with NULL slug — these are ` +
        `migrated rows from the Java IMS cutover that need slug assignment.\n` +
        `Run: node scripts/migrate-reference-data.js populate-slugs`
      );
    }
    expect(c).toBe(0);
  });

  it('CompletionPaths has no duplicate slugs (case-insensitive)', async () => {
    const dups = await db.run(`
      SELECT LOWER("SLUG") AS S, COUNT(*) AS C
        FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"
       WHERE "SLUG" IS NOT NULL
       GROUP BY LOWER("SLUG")
      HAVING COUNT(*) > 1
       ORDER BY C DESC, S
    `);
    if (dups.length > 0) {
      const sample = dups.slice(0, 5).map(r => `  ${r.S} → ${r.C} rows`).join('\n');
      throw new Error(
        `Found ${dups.length} duplicate-slug group(s) in CompletionPaths. Sample:\n${sample}`
      );
    }
    expect(dups.length).toBe(0);
  });
});
