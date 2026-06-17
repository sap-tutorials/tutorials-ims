import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// File lives under test/hybrid/ — picked up only by the "hybrid" Vitest
// project (vitest.config.ts), which runs `cds bind --exec` against the
// real HANA. The beforeAll() guard below FAILS hard if somehow run
// against SQLite, rather than silently passing on an empty schema.

describe('slug uniqueness invariant (issue: duplicate-slugs 2026-06-17)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'duplicate-slugs.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  });

  it('Tutorials has no duplicate slugs (case-insensitive)', async () => {
    const dups = await db.run(`
      SELECT LOWER("SLUG") AS S, COUNT(*) AS C
        FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
       WHERE "SLUG" IS NOT NULL
       GROUP BY LOWER("SLUG")
      HAVING COUNT(*) > 1
       ORDER BY C DESC, S
    `);
    if (dups.length > 0) {
      const sample = dups.slice(0, 5).map(r => `  ${r.S} → ${r.C} rows`).join('\n');
      throw new Error(
        `Found ${dups.length} duplicate-slug group(s) in Tutorials. Sample:\n${sample}\n` +
        `Run: npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --commit`
      );
    }
    expect(dups.length).toBe(0);
  });

  it('Missions has no duplicate slugs (case-insensitive)', async () => {
    const dups = await db.run(`
      SELECT LOWER("SLUG") AS S, COUNT(*) AS C
        FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"
       WHERE "SLUG" IS NOT NULL
       GROUP BY LOWER("SLUG")
      HAVING COUNT(*) > 1
       ORDER BY C DESC, S
    `);
    expect(dups, JSON.stringify(dups.slice(0, 5), null, 2)).toEqual([]);
  });

  it('Groups has no duplicate slugs (case-insensitive)', async () => {
    const dups = await db.run(`
      SELECT LOWER("SLUG") AS S, COUNT(*) AS C
        FROM "COM_SAP_DEVELOPERS_IMS_GROUPS"
       WHERE "SLUG" IS NOT NULL
       GROUP BY LOWER("SLUG")
      HAVING COUNT(*) > 1
       ORDER BY C DESC, S
    `);
    expect(dups, JSON.stringify(dups.slice(0, 5), null, 2)).toEqual([]);
  });
});
