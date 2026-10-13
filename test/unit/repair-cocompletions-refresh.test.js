// test/unit/repair-cocompletions-refresh.test.js
//
// Covers the #2740 hardening of
// scripts/repair-mixed-case-tutorial-duplicates.cjs: after the repair script
// renames a mixed-case slug to lowercase, CoCompletions must not keep carrying
// the OLD slug into the next KG graph build. The script closes that window by
// calling runMaterializeCoCompletions() after any slug mutation.
//
// This test proves the integration invariant the hardening relies on: given a
// lone mixed-case Tutorial that co-completed with another tutorial (so
// CoCompletions holds its OLD slug), renaming the Tutorials.slug and then
// running the materialize job rebuilds CoCompletions off the NEW slug — the
// stale mixed-case key is gone. That is exactly the sequence the repair script
// now performs under --apply (rename → runMaterializeCoCompletions).
//
// Uses in-memory SQLite via the standard unit-test workspace, mirroring
// co-completion-materialize.test.js.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import { runMaterializeCoCompletions } from '../../srv/jobs/materialize-co-completions.js';

let db;

async function setupModel() {
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  db = await cds.connect.to('db');
  await cds.deploy(csn).to(db);
}

beforeEach(async () => {
  await setupModel();
});

afterEach(async () => {
  await cds.disconnect();
  db = null;
});

const MIXED = 'abap-environment-sbpa-workflow-extend-RAP-App';
const LOWER = MIXED.toLowerCase();
const PARTNER = 'some-partner-tutorial';

// Seed one tutorial under `slugForTutorial` plus a partner, and two users who
// completed BOTH → a single (slug, PARTNER) co-completion pair (bidirectional).
// Mirrors co-completion-materialize.test.js idioms: integer legacyId, plain
// string IDs. The KG edge view's SCORE>=10 k-anon gate is a view concern, not a
// materialize concern, so two users are enough to exercise this invariant.
async function seed(slugForTutorial) {
  const { Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Tutorials).entries([
    { ID: 't-mixed', legacyId: 1001, slug: slugForTutorial, status: 'ACTIVE', title: 'M' },
    { ID: 't-partner', legacyId: 1002, slug: PARTNER, status: 'ACTIVE', title: 'P' },
  ]);
  await INSERT.into(TaskRecords).entries([
    { ID: 'r1', user_ID: 'u1', taskLegacyId: 1001, taskType: 'TUTORIAL', status: 'COMPLETED' },
    { ID: 'r2', user_ID: 'u1', taskLegacyId: 1002, taskType: 'TUTORIAL', status: 'COMPLETED' },
    { ID: 'r3', user_ID: 'u2', taskLegacyId: 1001, taskType: 'TUTORIAL', status: 'COMPLETED' },
    { ID: 'r4', user_ID: 'u2', taskLegacyId: 1002, taskType: 'TUTORIAL', status: 'COMPLETED' },
  ]);
}

async function coCompletionSlugs() {
  const { CoCompletions } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(CoCompletions).columns('sourceSlug', 'targetSlug');
  const set = new Set();
  for (const r of rows) { set.add(r.sourceSlug); set.add(r.targetSlug); }
  return set;
}

describe('repair script CoCompletions refresh (#2740 hardening)', () => {
  it('materialize rebuild drops the OLD slug after a Tutorials.slug rename', async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');

    // 1. Seed with the MIXED-case slug and build CoCompletions off it.
    await seed(MIXED);
    await runMaterializeCoCompletions();
    const before = await coCompletionSlugs();
    expect(before.has(MIXED)).toBe(true);   // stale key present pre-rename
    expect(before.has(LOWER)).toBe(false);

    // 2. Rename the slug in place — exactly what the repair script's `singles`
    //    path does: UPDATE(Tutorials).set({ slug: slug.toLowerCase() }).
    await UPDATE(Tutorials).where({ slug: MIXED }).set({ slug: LOWER });

    // 3. The hardening calls runMaterializeCoCompletions() right after. Simulate.
    await runMaterializeCoCompletions();

    const after = await coCompletionSlugs();
    expect(after.has(MIXED)).toBe(false);   // stale mixed-case key is gone
    expect(after.has(LOWER)).toBe(true);    // rebuilt off the new slug
  });

  it('without the refresh, the OLD slug would persist (characterizes the bug)', async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    await seed(MIXED);
    await runMaterializeCoCompletions();

    // Rename but DO NOT refresh — this is the pre-hardening behaviour.
    await UPDATE(Tutorials).where({ slug: MIXED }).set({ slug: LOWER });

    const stale = await coCompletionSlugs();
    expect(stale.has(MIXED)).toBe(true);    // the vertex-less key that crashed KG
  });
});
