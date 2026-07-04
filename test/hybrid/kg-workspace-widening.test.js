// test/hybrid/kg-workspace-widening.test.js
//
// Asserts KG_PG_VERTICES_V + KG_PG_EDGES_V surface all 9 predicates and
// 5 new vertex types after #919 widening. Seeds a minimal fixture with
// one row of each new predicate under __test__kg-w9-<runId>-.
//
// Guarded by ALLOW_HYBRID_WRITES=true via _guard.js. FK-safe teardown.
//
// Spec:  docs/superpowers/specs/2026-07-04-919-kg-workspace-widening-design.md
// Issue: #919

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const RUN_ID = crypto.randomBytes(3).toString('hex');
const PFX = `__test__kg-w9-${RUN_ID}-`;

// Slugs of fixture entities.
const HUB_C   = `${PFX}hub`;
const REL_C   = `${PFX}related`;
const TUT_1   = `${PFX}t1`;
const TUT_2   = `${PFX}t2`;
const TUT_A   = `${PFX}ta`;
const TUT_B   = `${PFX}tb`;
const GRP     = `${PFX}g1`;
const MIS     = `${PFX}m1`;
const TAG_R   = `${PFX}regular-tag`;
const TAG_P   = `software-product>${PFX}example-product`;

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
      'kg-workspace-widening.test.js must run against HANA. ' +
      'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
    );
  }

  const NS = 'com.sap.developers.ims';
  const {
    Concepts, Tutorials, TutorialConceptLinks, ConceptEdges,
    Groups, Missions, CompletionPaths, CompletionPathItems,
    Tags, TutorialTags, MissionCategories, CoCompletions,
  } = cds.entities(NS);

  // 1. Concepts.
  await INSERT.into(Concepts).entries([
    { slug: HUB_C, name: 'Hub',     status: 'ACTIVE' },
    { slug: REL_C, name: 'Related', status: 'ACTIVE' },
  ]);

  // 2. Tutorials.
  await INSERT.into(Tutorials).entries([
    { slug: TUT_1, title: 'T1' },
    { slug: TUT_2, title: 'T2' },
    { slug: TUT_A, title: 'TA' },
    { slug: TUT_B, title: 'TB' },
  ]);

  // Look up IDs (raw SELECT, uppercase HANA columns).
  const conceptRows = await db.run(
    `SELECT ID, SLUG FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS" WHERE SLUG LIKE ?`,
    [`${PFX}%`]
  );
  const tutRows = await db.run(
    `SELECT ID, SLUG FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE SLUG LIKE ?`,
    [`${PFX}%`]
  );
  const cId = Object.fromEntries(conceptRows.map(r => [r.SLUG, r.ID]));
  const tId = Object.fromEntries(tutRows.map(r => [r.SLUG, r.ID]));

  // 3. ConceptEdges: hub relatedTo related.
  await INSERT.into(ConceptEdges).entries([
    { source_ID: cId[HUB_C], target_ID: cId[REL_C], predicate: 'relatedTo', status: 'ACTIVE' },
  ]);

  // 4. TutorialConceptLinks: t1 extends t2 (extends predicate).
  await INSERT.into(TutorialConceptLinks).entries([
    { tutorial_ID: tId[TUT_1], extendsTutorial_ID: tId[TUT_2], predicate: 'extends' },
  ]);

  // 5. Groups.
  await INSERT.into(Groups).entries([{ slug: GRP, title: 'Grp', status: 'ACTIVE' }]);
  const [gRow] = await db.run(
    `SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_GROUPS" WHERE SLUG = ?`, [GRP]
  );

  // 6. Missions with group_ID.
  await INSERT.into(Missions).entries([{ slug: MIS, title: 'Mis', status: 'ACTIVE', group_ID: gRow.ID }]);
  const [mRow] = await db.run(
    `SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" WHERE SLUG = ?`, [MIS]
  );

  // 7. CompletionPaths under the mission.
  await INSERT.into(CompletionPaths).entries([{ mission_ID: mRow.ID, name: 'default', slug: `${PFX}default` }]);
  const [pRow] = await db.run(
    `SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" WHERE MISSION_ID = ? AND SLUG = ?`,
    [mRow.ID, `${PFX}default`]
  );

  // 8. CompletionPathItems: link t1 to the path (uses itemOrder, not sortOrder — verified Task 0).
  await INSERT.into(CompletionPathItems).entries([
    { path_ID: pRow.ID, tutorial_ID: tId[TUT_1], itemOrder: 1, taskType: 'TUTORIAL' },
  ]);

  // 9. Tags: regular + software-product prefix.
  await INSERT.into(Tags).entries([
    { name: TAG_R, label: 'Regular' },
    { name: TAG_P, label: 'Example Product' },
  ]);
  const tagRows = await db.run(
    `SELECT ID, NAME FROM "COM_SAP_DEVELOPERS_IMS_TAGS" WHERE NAME LIKE ? OR NAME LIKE ?`,
    [`${PFX}%`, `software-product>${PFX}%`]
  );
  const tagId = Object.fromEntries(tagRows.map(r => [r.NAME, r.ID]));

  // 10. TutorialTags: t1 tagged with both.
  await INSERT.into(TutorialTags).entries([
    { tutorial_ID: tId[TUT_1], tag_ID: tagId[TAG_R] },
    { tutorial_ID: tId[TUT_1], tag_ID: tagId[TAG_P] },
  ]);

  // 11. MissionCategories: pick the first seeded category.
  const catRows = await db.run(
    `SELECT ID, SLUG FROM "COM_SAP_DEVELOPERS_IMS_CATEGORIES" WHERE SLUG IS NOT NULL ORDER BY SORTORDER LIMIT 1`
  );
  if (catRows.length === 0) {
    throw new Error('No Categories seeded — kg-workspace-widening test requires >= 1 category.');
  }
  await INSERT.into(MissionCategories).entries([
    { mission_ID: mRow.ID, category_ID: catRows[0].ID },
  ]);

  // 12. CoCompletions: two above-threshold rows (both directions) + one below (negative-path).
  await INSERT.into(CoCompletions).entries([
    { sourceSlug: TUT_A, targetSlug: TUT_B, score: 15 },
    { sourceSlug: TUT_B, targetSlug: TUT_A, score: 15 },   // reverse direction
    { sourceSlug: TUT_1, targetSlug: TUT_2, score:  5 },   // below k=10 gate
  ]);
}, 120_000);

afterAll(async () => {
  if (!db) return;

  const arg1 = `${PFX}%`;
  const arg2 = `software-product>${PFX}%`;

  // FK-safe reverse order.
  const stmts = [
    [`DELETE FROM "COM_SAP_DEVELOPERS_IMS_MISSIONCATEGORIES"
        WHERE MISSION_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" WHERE LOWER(SLUG) LIKE ?)`, [arg1]],
    [`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS"
        WHERE TUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE LOWER(SLUG) LIKE ?)`, [arg1]],
    [`DELETE FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"
        WHERE TUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE LOWER(SLUG) LIKE ?)`, [arg1]],
    [`DELETE FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"
        WHERE MISSION_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" WHERE LOWER(SLUG) LIKE ?)`, [arg1]],
    [`DELETE FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" WHERE LOWER(SLUG) LIKE ?`, [arg1]],
    [`DELETE FROM "COM_SAP_DEVELOPERS_IMS_GROUPS"   WHERE LOWER(SLUG) LIKE ?`, [arg1]],
    [`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS"
        WHERE TUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE LOWER(SLUG) LIKE ?)
           OR EXTENDSTUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE LOWER(SLUG) LIKE ?)`, [arg1, arg1]],
    [`DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES"
        WHERE SOURCE_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS" WHERE LOWER(SLUG) LIKE ?)`, [arg1]],
    [`DELETE FROM "COM_SAP_DEVELOPERS_IMS_COCOMPLETIONS"
        WHERE LOWER(SOURCESLUG) LIKE ? OR LOWER(TARGETSLUG) LIKE ?`, [arg1, arg1]],
    [`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TAGS"
        WHERE LOWER(NAME) LIKE ? OR LOWER(NAME) LIKE ?`, [arg1, arg2]],
    [`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE LOWER(SLUG) LIKE ?`, [arg1]],
    [`DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"  WHERE LOWER(SLUG) LIKE ?`, [arg1]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.run(sql, params);
    } catch (e) {
      // Best-effort cleanup; log but don't fail the run.
      console.warn(`[kg-workspace-widening teardown] ${sql.slice(0, 60)}... failed: ${e.message}`);
    }
  }
}, 60_000);

describe('KG_PG_WORKSPACE — 9-predicate widening (#919)', () => {
  it('emits all 7 new edge types', async () => {
    const rows = await db.run(
      `SELECT DISTINCT EDGE_TYPE FROM "KG_PG_EDGES_V"
         WHERE SOURCE LIKE ? OR TARGET LIKE ? OR SOURCE LIKE ? OR TARGET LIKE ?`,
      [`%${PFX}%`, `%${PFX}%`,
       `%software-product>${PFX}%`, `%software-product>${PFX}%`]
    );
    const set = new Set(rows.map(r => r.EDGE_TYPE));
    expect(set.has('relatedTo')).toBe(true);
    expect(set.has('extends')).toBe(true);
    expect(set.has('partOf')).toBe(true);           // covers both partOf arms
    expect(set.has('taggedWith')).toBe(true);
    expect(set.has('aboutProduct')).toBe(true);
    expect(set.has('inCategory')).toBe(true);
    expect(set.has('coCompletedWith')).toBe(true);
  });

  it('emits 4 fixture-scoped new vertex types (mission/group/tag/product)', async () => {
    const rows = await db.run(
      `SELECT DISTINCT VERTEX_TYPE FROM "KG_PG_VERTICES_V"
         WHERE SLUG LIKE ? OR SLUG LIKE ?`,
      [`${PFX}%`, `${PFX}example-product`]
    );
    const set = new Set(rows.map(r => r.VERTEX_TYPE));
    expect(set.has('mission')).toBe(true);
    expect(set.has('group')).toBe(true);
    expect(set.has('tag')).toBe(true);
    expect(set.has('product')).toBe(true);
  });

  it('emits the 5th (category) vertex type at all', async () => {
    // Categories are CSV-seeded — not fixture-scoped. Assert presence globally.
    const [row] = await db.run(
      `SELECT COUNT(*) AS N FROM "KG_PG_VERTICES_V" WHERE VERTEX_TYPE = 'category'`
    );
    expect(row.N).toBeGreaterThan(0);
  });

  it('enforces k-anonymity gate (score=5 pair does NOT appear)', async () => {
    const [row] = await db.run(
      `SELECT COUNT(*) AS N FROM "KG_PG_EDGES_V"
         WHERE EDGE_TYPE = 'coCompletedWith'
           AND SOURCE = ? AND TARGET = ?`,
      [`tutorial:${TUT_1}`, `tutorial:${TUT_2}`]
    );
    expect(row.N).toBe(0);
  });

  it('emits both directions of coCompletedWith when both are stored', async () => {
    const rows = await db.run(
      `SELECT SOURCE, TARGET FROM "KG_PG_EDGES_V"
         WHERE EDGE_TYPE = 'coCompletedWith'
           AND (SOURCE = ? OR SOURCE = ?)`,
      [`tutorial:${TUT_A}`, `tutorial:${TUT_B}`]
    );
    const pairs = new Set(rows.map(r => `${r.SOURCE}=>${r.TARGET}`));
    expect(pairs.has(`tutorial:${TUT_A}=>tutorial:${TUT_B}`)).toBe(true);
    expect(pairs.has(`tutorial:${TUT_B}=>tutorial:${TUT_A}`)).toBe(true);
  });
});
