import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { runKgCommunities } from '../../srv/jobs/kg-communities-job.js';

const TEST_PREFIX = `__test__kg-communities-`;
const RUN_ID = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const P = `${TEST_PREFIX}${RUN_ID}-`;

const A_TUTS = [1, 2, 3, 4, 5].map((n) => `${P}A${n}`);
const B_TUTS = [1, 2, 3, 4, 5].map((n) => `${P}B${n}`);
const BRIDGE = `${P}bridge`;
const CONCEPT_A = `${P}concept-a`;
const CONCEPT_B = `${P}concept-b`;
const CONCEPT_BRIDGE_A = `${P}concept-bridge-a`;
const CONCEPT_BRIDGE_B = `${P}concept-bridge-b`;

let db;

beforeAll(async () => {
  if (!isSafeForWrites()) throw new Error('hybrid write guard refused');
  process.env.ALLOW_HYBRID_WRITES = 'true';
  db = await cds.connect.to('db');
  const kind = db.options?.kind || db.constructor?.name;
  if (!(kind === 'hana' || kind === 'HANAService')) throw new Error(`expected HANA binding, got ${kind}`);

  const { Concepts, Tutorials, ConceptEdges, TutorialConceptLinks } =
    cds.entities('com.sap.developers.ims');

  await INSERT.into(Concepts).entries([
    { slug: CONCEPT_A, label: `A ${RUN_ID}` },
    { slug: CONCEPT_B, label: `B ${RUN_ID}` },
    { slug: CONCEPT_BRIDGE_A, label: `bridge-A ${RUN_ID}` },
    { slug: CONCEPT_BRIDGE_B, label: `bridge-B ${RUN_ID}` },
  ]);
  await INSERT.into(Tutorials).entries(
    [...A_TUTS, ...B_TUTS, BRIDGE].map((slug) => ({ slug, title: slug }))
  );

  const concepts = await SELECT.from(Concepts).columns('ID', 'slug').where({
    slug: { in: [CONCEPT_A, CONCEPT_B, CONCEPT_BRIDGE_A, CONCEPT_BRIDGE_B] },
  });
  const tutorials = await SELECT.from(Tutorials).columns('ID', 'slug').where({
    slug: { in: [...A_TUTS, ...B_TUTS, BRIDGE] },
  });
  const cId = (s) => concepts.find((c) => c.slug === s).ID;
  const tId = (s) => tutorials.find((t) => t.slug === s).ID;

  // Each A-tutorial teaches CONCEPT_A; each B-tutorial teaches CONCEPT_B.
  // Bridge teaches CONCEPT_BRIDGE_A + CONCEPT_BRIDGE_B (one edge each side).
  // CONCEPT_BRIDGE_A relatedTo CONCEPT_A; CONCEPT_BRIDGE_B relatedTo CONCEPT_B.
  await INSERT.into(TutorialConceptLinks).entries([
    ...A_TUTS.map((s) => ({ tutorial_ID: tId(s), concept_ID: cId(CONCEPT_A), predicate: 'teaches' })),
    ...B_TUTS.map((s) => ({ tutorial_ID: tId(s), concept_ID: cId(CONCEPT_B), predicate: 'teaches' })),
    { tutorial_ID: tId(BRIDGE), concept_ID: cId(CONCEPT_BRIDGE_A), predicate: 'teaches' },
    { tutorial_ID: tId(BRIDGE), concept_ID: cId(CONCEPT_BRIDGE_B), predicate: 'teaches' },
  ]);
  await INSERT.into(ConceptEdges).entries([
    { source_ID: cId(CONCEPT_BRIDGE_A), target_ID: cId(CONCEPT_A), predicate: 'relatedTo' },
    { source_ID: cId(CONCEPT_BRIDGE_B), target_ID: cId(CONCEPT_B), predicate: 'relatedTo' },
  ]);
}, 120_000);

afterAll(async () => {
  if (!db) return;
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY"
    WHERE LOWER("vertexKey") LIKE 'tutorial:__test__kg-communities-%'
       OR LOWER("vertexKey") LIKE 'concept:__test__kg-communities-%'`);
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS"
    WHERE "tutorial_ID" IN (SELECT "ID" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
    WHERE LOWER("slug") LIKE '__test__kg-communities-%')`);
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES"
    WHERE "source_ID" IN (SELECT "ID" FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
    WHERE LOWER("slug") LIKE '__test__kg-communities-%')`);
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
    WHERE LOWER("slug") LIKE '__test__kg-communities-%'`);
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
    WHERE LOWER("slug") LIKE '__test__kg-communities-%'`);
}, 60_000);

describe('kg-communities nightly job (hybrid)', () => {
  it('separates two cliques joined by a bridge', async () => {
    const summary = await runKgCommunities();
    expect(summary.rowCount).toBeGreaterThan(0);
    expect(Number.isFinite(summary.durationMs)).toBe(true);

    const rows = await db.run(
      `SELECT "communityId","vertexKey" FROM "COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY"
       WHERE LOWER("vertexKey") LIKE 'tutorial:__test__kg-communities-%'`
    );
    const communityOf = Object.fromEntries(
      rows.map((r) => [r.vertexKey.replace(/^tutorial:/, ''), Number(r.communityId)])
    );

    const aCommunities = new Set(A_TUTS.map((s) => communityOf[s]));
    const bCommunities = new Set(B_TUTS.map((s) => communityOf[s]));
    expect(aCommunities.size).toBe(1);
    expect(bCommunities.size).toBe(1);
    expect([...aCommunities][0]).not.toBe([...bCommunities][0]);
  }, 120_000);
});
