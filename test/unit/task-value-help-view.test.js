// test/unit/task-value-help-view.test.js
//
// TASK_VALUE_HELP_V1 union contract guard (#cross-container).
//
// The physical TASK_VALUE_HELP_V1.hdbview is a HANA artifact and is not
// present in the in-memory SQLite unit DB. This test proves the equivalent
// semantics by running the view's SELECT/UNION logic against the CDS entities
// `com.sap.developers.ims.Tutorials` and `com.sap.developers.ims.Puzzles`
// directly.
//
// Three properties are guarded:
//   1. The union includes ACTIVE and NULL-status rows of BOTH types and
//      excludes INACTIVE rows of both types.
//   2. A TASKTYPE discriminator constant ('TUTORIAL' / 'PUZZLE') distinguishes
//      the two branches — mirroring the view's literal constants.
//   3. No `solution` / `SOLUTION` property appears in the projected rows —
//      the answer key must never be in the value-help surface.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const project = cds.test('serve', '--project', '.', '--in-memory');

// Well-known UUIDs — cleaned up in beforeEach to avoid cross-file collisions.
const T_ACTIVE   = 'b2000000-cafe-0000-0000-000000000001';
const T_NULL     = 'b2000000-cafe-0000-0000-000000000002';
const T_INACTIVE = 'b2000000-cafe-0000-0000-000000000003';
const P_ACTIVE   = 'b2000000-cafe-0000-0000-000000000004';
const P_NULL     = 'b2000000-cafe-0000-0000-000000000005';
const P_INACTIVE = 'b2000000-cafe-0000-0000-000000000006';

const ALL_IDS = [T_ACTIVE, T_NULL, T_INACTIVE, P_ACTIVE, P_NULL, P_INACTIVE];

describe('TASK_VALUE_HELP_V1 union contract (SQLite equivalent)', () => {
  let Tutorials, Puzzles;

  beforeAll(() => {
    ({ Tutorials, Puzzles } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    // Remove only our test rows — leave other tests' data untouched.
    await DELETE.from(Tutorials).where({ ID: { in: [T_ACTIVE, T_NULL, T_INACTIVE] } });
    await DELETE.from(Puzzles).where({ ID: { in: [P_ACTIVE, P_NULL, P_INACTIVE] } });

    // Seed tutorials: ACTIVE, NULL-status, INACTIVE
    await INSERT.into(Tutorials).entries([
      { ID: T_ACTIVE,   slug: 'tvh2-t-active',   title: 'Tutorial Active',   status: 'ACTIVE',   primaryTag: 'technology>sap-cap' },
      { ID: T_NULL,     slug: 'tvh2-t-null',     title: 'Tutorial NullStat', status: null,        primaryTag: 'technology>sap-cap' },
      { ID: T_INACTIVE, slug: 'tvh2-t-inactive', title: 'Tutorial Inactive', status: 'INACTIVE',  primaryTag: 'technology>sap-cap' },
    ]);

    // Seed puzzles: ACTIVE (with solution), NULL-status, INACTIVE — all carry solution
    await INSERT.into(Puzzles).entries([
      { ID: P_ACTIVE,   slug: 'tvh2-p-active',   title: 'Puzzle Active',   status: 'ACTIVE',
        layout: '{"rows":2,"cols":2,"grid":[]}', solution: '{"0,0":"A","0,1":"B"}' },
      { ID: P_NULL,     slug: 'tvh2-p-null',     title: 'Puzzle NullStat', status: null,
        layout: '{"rows":1,"cols":1,"grid":[]}', solution: '{"0,0":"X"}' },
      { ID: P_INACTIVE, slug: 'tvh2-p-inactive', title: 'Puzzle Inactive', status: 'INACTIVE',
        layout: '{"rows":1,"cols":1,"grid":[]}', solution: '{"0,0":"Z"}' },
    ]);
  });

  // ─── Helper: replicate the view's SELECT union ──────────────────────────
  // Tutorial branch: columns ID, slug, title, primaryTag, experienceTag,
  //   averageTimeToComplete, description, TASKTYPE='TUTORIAL', mdFileUrl,
  //   stepCount, layout=null
  // Puzzle branch: same columns except mdFileUrl=null, stepCount=null,
  //   layout from entity; TASKTYPE='PUZZLE'; solution intentionally omitted
  async function queryUnionEquivalent() {
    const tuts = await SELECT.from(Tutorials)
      .columns('ID', 'slug', 'title', 'primaryTag', 'experienceTag',
               'averageTimeToComplete', 'description', 'mdFileUrl', 'stepCount')
      .where(`status = 'ACTIVE' or status is null`);

    const puzs = await SELECT.from(Puzzles)
      .columns('ID', 'slug', 'title', 'primaryTag', 'experienceTag',
               'averageTimeToComplete', 'description', 'layout')
      .where(`status = 'ACTIVE' or status is null`);

    return [
      ...tuts.map(r => ({ ...r, TASKTYPE: 'TUTORIAL', layout: null })),
      ...puzs.map(r => ({ ...r, TASKTYPE: 'PUZZLE',   mdFileUrl: null, stepCount: null })),
    ];
  }

  // ─── Property 1: ACTIVE + NULL-status rows included, INACTIVE excluded ──

  it('includes ACTIVE and NULL-status tutorials; excludes INACTIVE tutorials', async () => {
    const rows = await queryUnionEquivalent();
    const ids  = rows.map(r => r.ID);

    expect(ids).toContain(T_ACTIVE);
    expect(ids).toContain(T_NULL);
    expect(ids).not.toContain(T_INACTIVE);
  });

  it('includes ACTIVE and NULL-status puzzles; excludes INACTIVE puzzles', async () => {
    const rows = await queryUnionEquivalent();
    const ids  = rows.map(r => r.ID);

    expect(ids).toContain(P_ACTIVE);
    expect(ids).toContain(P_NULL);
    expect(ids).not.toContain(P_INACTIVE);
  });

  it('INACTIVE rows genuinely exist in the DB — their absence is filter-driven', async () => {
    // Sanity: the INACTIVE rows are seeded; the filter is what hides them.
    const [t] = await SELECT.from(Tutorials).where({ ID: T_INACTIVE });
    const [p] = await SELECT.from(Puzzles).where({ ID: P_INACTIVE });
    expect(t.status).toBe('INACTIVE');
    expect(p.status).toBe('INACTIVE');
  });

  // ─── Property 2: TASKTYPE discriminator ─────────────────────────────────

  it('tutorial rows carry TASKTYPE = "TUTORIAL"', async () => {
    const rows = await queryUnionEquivalent();
    const tutRows = rows.filter(r => r.ID === T_ACTIVE || r.ID === T_NULL);

    expect(tutRows).toHaveLength(2);
    for (const r of tutRows) {
      expect(r.TASKTYPE).toBe('TUTORIAL');
    }
  });

  it('puzzle rows carry TASKTYPE = "PUZZLE"', async () => {
    const rows = await queryUnionEquivalent();
    const puzRows = rows.filter(r => r.ID === P_ACTIVE || r.ID === P_NULL);

    expect(puzRows).toHaveLength(2);
    for (const r of puzRows) {
      expect(r.TASKTYPE).toBe('PUZZLE');
    }
  });

  it('counts per TASKTYPE from our seed rows are 2 TUTORIAL and 2 PUZZLE (active+null)', async () => {
    const rows    = await queryUnionEquivalent();
    // Filter to only our well-known IDs so other data in the DB doesn't skew counts.
    const ours    = rows.filter(r => ALL_IDS.includes(r.ID));
    const tutCnt  = ours.filter(r => r.TASKTYPE === 'TUTORIAL').length;
    const puzCnt  = ours.filter(r => r.TASKTYPE === 'PUZZLE').length;

    expect(tutCnt).toBe(2);
    expect(puzCnt).toBe(2);
  });

  // ─── Property 3: No solution in the projected surface ───────────────────

  it('projected puzzle rows do not carry a "solution" property', async () => {
    const rows    = await queryUnionEquivalent();
    const puzRows = rows.filter(r => r.TASKTYPE === 'PUZZLE');

    // Must have at least our two seeded puzzle rows to make this assertion meaningful.
    expect(puzRows.length).toBeGreaterThanOrEqual(2);

    for (const r of puzRows) {
      expect(r).not.toHaveProperty('solution');
      expect(r).not.toHaveProperty('SOLUTION');
    }
  });

  it('solution is genuinely present in the raw Puzzles entity — its absence above is by omission', async () => {
    // Verify the seeded puzzle with a known solution — if we query the column
    // directly from the entity it IS there. The view-equivalent omits it.
    const [raw] = await SELECT.from(Puzzles)
      .columns('ID', 'slug', 'solution')
      .where({ ID: P_ACTIVE });

    expect(raw).toHaveProperty('solution');
    expect(raw.solution).toContain('"A"');
  });

  it('projected tutorial rows also do not carry a "solution" property', async () => {
    const rows    = await queryUnionEquivalent();
    const tutRows = rows.filter(r => r.TASKTYPE === 'TUTORIAL');

    expect(tutRows.length).toBeGreaterThanOrEqual(2);
    for (const r of tutRows) {
      expect(r).not.toHaveProperty('solution');
      expect(r).not.toHaveProperty('SOLUTION');
    }
  });
});

// ─── Artifact-level guard: the deployed view SOURCE must never expose SOLUTION ─

describe('TASK_VALUE_HELP_V1.hdbview source artifact', () => {
  it('contains no occurrence of "solution" (case-insensitive) — the answer key must never be in the deployed view', () => {
    const viewPath = join(process.cwd(), 'db/src/TASK_VALUE_HELP_V1.hdbview');
    const source   = readFileSync(viewPath, 'utf-8');

    // Non-empty guard: a wrong path would return empty and make the next assert vacuous.
    expect(source.length, `View file at ${viewPath} is empty — check the path`).toBeGreaterThan(0);

    // Security guard: the answer key must never appear in the cross-container surface.
    const matches = source.match(/solution/gi) ?? [];
    expect(
      matches,
      `TASK_VALUE_HELP_V1.hdbview must NOT contain "solution" but found ${matches.length} occurrence(s): ${JSON.stringify(matches)}`
    ).toHaveLength(0);
  });
});
