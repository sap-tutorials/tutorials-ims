// test/hybrid/kg-vertex-dedupe.test.js
//
// Layer A guard (KG vertex-dup bug): KG_PG_VERTICES_V's concept arm must emit
// exactly ONE 'concept:<slug>' vertex even when the Concepts table carries TWO
// ACTIVE rows with the same slug. Before the ROW_NUMBER() dedupe the arm
// emitted the key twice, and the graph engine rejected the whole KG_PG_WORKSPACE
// at KG_LOUVAIN_GRAPH runtime ([4907] range 1) — crashing kg-pagerank,
// kg-communities/Louvain and kg-wcc in PROD.
//
// HANA-only: the fix uses a ROW_NUMBER() OVER (PARTITION BY ...) window in a
// derived table, which SQLite's unit path can't exercise. Guarded by
// ALLOW_HYBRID_WRITES=true via _guard.js. FK-safe teardown.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const RUN_ID = crypto.randomBytes(3).toString('hex');
const SLUG = `__test__kg-vdup-${RUN_ID}`;

let db;

beforeAll(async () => {
  if (!isSafeForWrites()) {
    throw new Error('ALLOW_HYBRID_WRITES / space guard rejected — refusing to seed fixture.');
  }
  process.env.ALLOW_HYBRID_WRITES = 'true';
  db = await cds.connect.to('db');

  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    throw new Error(
      'kg-vertex-dedupe.test.js must run against HANA. ' +
      'Run via `npm run test:hybrid` after `cds bind` to the DEV space.',
    );
  }

  const { Concepts } = cds.entities('com.sap.developers.ims');
  // Two ACTIVE rows, SAME slug, DIFFERENT name (so a bare DISTINCT would still
  // emit both — proving ROW_NUMBER, not DISTINCT, is what dedupes).
  await INSERT.into(Concepts).entries([
    { ID: cds.utils.uuid(), slug: SLUG, name: 'Dup A', status: 'ACTIVE' },
    { ID: cds.utils.uuid(), slug: SLUG, name: 'Dup B', status: 'ACTIVE' },
  ]);
}, 120_000);

afterAll(async () => {
  if (!db) return;
  try {
    await db.run(
      `DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS" WHERE LOWER(SLUG) LIKE ?`,
      [`${SLUG.toLowerCase()}%`],
    );
  } catch (e) {
    console.warn(`[kg-vertex-dedupe teardown] failed: ${e.message}`);
  }
}, 60_000);

describe('KG_PG_VERTICES_V concept-arm dedupe (Layer A)', () => {
  it('emits exactly ONE concept vertex for a slug with two ACTIVE rows', async () => {
    const rows = await db.run(
      `SELECT VERTEX_KEY, LABEL FROM "KG_PG_VERTICES_V"
         WHERE VERTEX_TYPE = 'concept' AND SLUG = ?`,
      [SLUG],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].VERTEX_KEY).toBe(`concept:${SLUG}`);
  });

  it('produces a workspace-loadable (no-dup) VERTEX_KEY set for the fixture slug', async () => {
    // The graph engine rejects the workspace if any VERTEX_KEY repeats. Assert
    // uniqueness the same way the loader would see it: count vs distinct-count.
    const [row] = await db.run(
      `SELECT COUNT(*) AS N, COUNT(DISTINCT VERTEX_KEY) AS D
         FROM "KG_PG_VERTICES_V" WHERE VERTEX_KEY = ?`,
      [`concept:${SLUG}`],
    );
    expect(row.N).toBe(1);
    expect(row.D).toBe(1);
  });
});
