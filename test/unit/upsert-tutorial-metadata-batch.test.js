// test/unit/upsert-tutorial-metadata-batch.test.js
//
// Task 8 (#2802): verify that upsertTutorialMetadata issues a batched lookup
// for Tutorials (one LOWER(slug) IN), Steps (one tutorial_ID IN), and
// TutorialMeta (one tutorial_ID IN), rather than the old per-slug N+1 pattern.
//
// Key assertions:
//   - Tutorials/Steps/TutorialMeta rows are identical to what the per-row path
//     would produce (values + legacyId assignment semantics).
//   - The existing tutorial is matched case-insensitively via LOWER(slug).
//   - SELECT statement counts confirm one batch read per entity, not per-slug reads.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

function html(s) {
  return gzipSync(Buffer.from(`<html><body><main class="tutorial-main">${s}</main></body></html>`, 'utf-8')).toString('base64');
}

// Table names as CQN refs (SQLite in-memory)
const TUTORIALS_TABLE   = 'com.sap.developers.ims.Tutorials';
const STEPS_TABLE       = 'com.sap.developers.ims.Steps';
const TUTORIALMETA_TABLE = 'com.sap.developers.ims.TutorialMeta';

/** Returns true if a CQN object has `in` anywhere in its WHERE clause. */
function cqnHasIn(q) {
  const where = q?.SELECT?.where ?? q?.UPDATE?.where ?? q?.DELETE?.where;
  return Array.isArray(where) && where.some(tok => tok === 'in');
}

/** Returns true if a CQN SELECT WHERE references the column `stepOrder` (equality). */
function cqnWhereHasStepOrder(q) {
  const where = q?.SELECT?.where;
  if (!Array.isArray(where)) return false;
  return where.some(tok => tok?.ref?.[0] === 'stepOrder');
}

/** Returns true if a CQN SELECT WHERE references the column `tutorial_ID` (equality). */
function cqnWhereHasTutorialId(q) {
  const where = q?.SELECT?.where;
  if (!Array.isArray(where)) return false;
  return where.some(tok => tok?.ref?.[0] === 'tutorial_ID');
}

describe('upsertTutorialMetadata batched SELECT+write (#2802)', () => {
  let helpers;
  let Tutorials, Steps, TutorialMeta, ContentFiles, ContentManifest, PipelineLog, JobLocks;
  let db;

  beforeAll(async () => {
    helpers = createSessionHelpers({ namespace: NS });
    ({
      Tutorials, Steps, TutorialMeta,
      ContentFiles, ContentManifest, PipelineLog, JobLocks,
    } = cds.entities(NS));
    db = await cds.connect.to('db');
  });

  beforeEach(async () => {
    await DELETE.from(Steps);
    await DELETE.from(TutorialMeta);
    await DELETE.from(Tutorials);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(PipelineLog);
    await DELETE.from(JobLocks);
  });

  // -------------------------------------------------------------------------
  // Helper: run appendToSession and instrument db.run to count SELECT shapes
  // on Tutorials, Steps, and TutorialMeta tables.
  //
  // "withIn" counts SELECTs that use an IN-list WHERE (batch reads).
  // "perStep" counts SELECTs on Steps with stepOrder equality in WHERE
  //   (the old N+1 per-(tutorialId, stepOrder) lookup pattern).
  // "perTutMeta" counts SELECTs on TutorialMeta with tutorial_ID equality
  //   in WHERE without IN (the old N+1 per-tutorialId meta lookup pattern).
  // -------------------------------------------------------------------------
  async function runWithCounts(sessionId, metadata) {
    // Structural: batch IN reads
    let tutorialsSelectsWithIn = 0;
    let stepsSelectsWithIn     = 0;
    let metaSelectsWithIn      = 0;

    // N+1 pattern reads — what we want to eliminate
    let stepsPerStepSelects   = 0; // per-(tutorial_ID, stepOrder) lookups
    let metaPerTutSelects     = 0; // per-tutorial_ID meta lookups (no IN)

    // Also count raw SQL string invocations (used for LOWER(slug) IN)
    let rawSlugInSelects = 0;

    const origRun = db.run.bind(db);
    db.run = async (q, ...rest) => {
      if (typeof q === 'string') {
        // Raw SQL — the LOWER(slug) IN lookup
        const upper = q.toUpperCase();
        if (upper.includes('LOWER(') && upper.includes(' IN ')) {
          rawSlugInSelects++;
        }
      } else {
        // CQN objects
        const fromRef = q?.SELECT?.from?.ref?.[0];
        if (fromRef === TUTORIALS_TABLE) {
          if (cqnHasIn(q)) tutorialsSelectsWithIn++;
        }
        if (fromRef === STEPS_TABLE) {
          if (cqnHasIn(q))                      stepsSelectsWithIn++;
          else if (cqnWhereHasStepOrder(q))      stepsPerStepSelects++;  // old N+1
        }
        if (fromRef === TUTORIALMETA_TABLE) {
          if (cqnHasIn(q))                          metaSelectsWithIn++;
          else if (cqnWhereHasTutorialId(q))        metaPerTutSelects++; // old N+1
        }
      }
      return origRun(q, ...rest);
    };
    try {
      // Pass empty files so appendToSession only runs the metadata path
      await helpers.appendToSession({ sessionId, files: {}, metadata });
    } finally {
      db.run = origRun;
    }
    return {
      rawSlugInSelects,
      tutorialsSelectsWithIn,
      stepsSelectsWithIn, stepsPerStepSelects,
      metaSelectsWithIn,  metaPerTutSelects,
    };
  }

  // -------------------------------------------------------------------------
  // Test 1: values test — one existing tutorial (with steps + meta), one new.
  // Verify Tutorials/Steps/TutorialMeta rows identical to per-row path.
  // -------------------------------------------------------------------------
  it('updates existing tutorial + inserts new tutorial with correct Tutorials/Steps/TutorialMeta rows', async () => {
    const EXISTING_SLUG = 'meta-existing-tutorial';
    const NEW_SLUG      = 'meta-new-tutorial';

    // Seed an existing tutorial with one step and meta
    const existingTutorialId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: existingTutorialId,
      slug: EXISTING_SLUG,
      title: 'Old Title',
      status: 'ACTIVE',
      stepCount: 1,
      legacyId: 9000001,
    });
    const existingStepId = cds.utils.uuid();
    await INSERT.into(Steps).entries({
      ID: existingStepId,
      tutorial_ID: existingTutorialId,
      stepOrder: 1,
      title: 'Old Step 1',
      status: 'ACTIVE',
      legacyId: 9000002,
    });
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(),
      tutorial_ID: existingTutorialId,
      owner: null,
      ownerEmail: null,
      reviewedDate: '2024-01-01',
      monitoredStatus: 'ACTIVE',
      notificationNumber: 0,
      lastNotificationDate: null,
      legacyId: 9000003,
    });

    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-metadata-values',
      hugoVersion: '0.147.0',
      expectedSlugCount: 2,
      initiator: 'test-suite',
    });

    const metadata = {
      [EXISTING_SLUG]: {
        title: 'Updated Title',
        description: 'Updated description',
        time: 15,
        level: 'Beginner',
        primaryTag: 'technology:node.js',
        lastUpdated: '2025-06-01',
        steps: [
          { number: 1, title: 'Updated Step 1' },
          { number: 2, title: 'New Step 2' },
        ],
      },
      [NEW_SLUG]: {
        title: 'Brand New Tutorial',
        description: 'A fresh tutorial',
        time: 10,
        level: 'Intermediate',
        primaryTag: 'technology:sap-btp',
        lastUpdated: '2025-06-02',
        steps: [
          { number: 1, title: 'Step One' },
        ],
      },
    };

    await helpers.appendToSession({ sessionId, files: {}, metadata });

    // --- Verify Tutorials ---
    const existingTut = await SELECT.one.from(Tutorials).where({ ID: existingTutorialId });
    expect(existingTut, 'existing tutorial must still exist').toBeTruthy();
    expect(existingTut.title).toBe('Updated Title');
    expect(existingTut.description).toBe('Updated description');
    expect(existingTut.averageTimeToComplete).toBe(15);
    expect(existingTut.experienceTag).toBe('Beginner');
    expect(existingTut.primaryTag).toBe('technology:node.js');
    expect(existingTut.stepCount).toBe(2);
    expect(existingTut.status).toBe('ACTIVE');
    // existing row already had legacyId — must NOT be reassigned (keep 9000001)
    expect(existingTut.legacyId).toBe(9000001);

    const allTuts = await SELECT.from(Tutorials);
    expect(allTuts).toHaveLength(2);
    const newTut = allTuts.find(t => t.slug === NEW_SLUG);
    expect(newTut, 'new tutorial row must exist').toBeTruthy();
    expect(newTut.title).toBe('Brand New Tutorial');
    expect(newTut.status).toBe('ACTIVE');
    expect(newTut.legacyId, 'new tutorial must have a legacyId assigned').toBeTruthy();

    // --- Verify Steps ---
    const existingTutSteps = await SELECT.from(Steps).where({ tutorial_ID: existingTutorialId }).orderBy('stepOrder');
    expect(existingTutSteps).toHaveLength(2);

    const updatedStep1 = existingTutSteps.find(s => s.stepOrder === 1);
    expect(updatedStep1.title).toBe('Updated Step 1');
    expect(updatedStep1.status).toBe('ACTIVE');
    // step 1 already had legacyId 9000002 — must NOT be reassigned
    expect(updatedStep1.legacyId).toBe(9000002);
    expect(updatedStep1.ID).toBe(existingStepId); // same row, not a new one

    const newStep2 = existingTutSteps.find(s => s.stepOrder === 2);
    expect(newStep2.title).toBe('New Step 2');
    expect(newStep2.legacyId, 'new step must have a legacyId').toBeTruthy();

    const newTutSteps = await SELECT.from(Steps).where({ tutorial_ID: newTut.ID });
    expect(newTutSteps).toHaveLength(1);
    expect(newTutSteps[0].title).toBe('Step One');
    expect(newTutSteps[0].legacyId, 'new tutorial step must have a legacyId').toBeTruthy();

    // --- Verify TutorialMeta ---
    const existingTutMeta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: existingTutorialId });
    expect(existingTutMeta, 'existing tutorial meta must still exist').toBeTruthy();
    // reviewedDate updated because 2025-06-01 > 2024-01-01
    expect(existingTutMeta.reviewedDate, 'reviewedDate must be updated to 2025-06-01')
      .toMatch(/^2025-06-01/);
    expect(existingTutMeta.notificationNumber).toBe(0);
    // existing meta already had legacyId 9000003 — must NOT be touched
    expect(existingTutMeta.legacyId).toBe(9000003);

    const newTutMeta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: newTut.ID });
    expect(newTutMeta, 'new tutorial meta must be created').toBeTruthy();
    // SQLite may store dates as ISO strings (e.g. '2025-06-02T00:00:00.000Z')
    expect(newTutMeta.reviewedDate, 'new tutorial meta reviewedDate must start with 2025-06-02')
      .toMatch(/^2025-06-02/);
    expect(newTutMeta.monitoredStatus).toBe('ACTIVE');
    expect(newTutMeta.notificationNumber).toBe(0);
    expect(newTutMeta.legacyId, 'new tutorial meta must have a legacyId').toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Test 2: case-insensitive LOWER(slug) match — existing row seeded with
  // mixed-case slug must be resolved by a lowercase lookup.
  // -------------------------------------------------------------------------
  it('resolves existing tutorial case-insensitively via LOWER(slug) match', async () => {
    // Seed with mixed-case slug (legacy data shape)
    const mixedSlug = 'Extend-RAP-App';
    const lowerSlug = mixedSlug.toLowerCase(); // 'extend-rap-app'
    const tutorialId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: tutorialId,
      slug: mixedSlug, // stored mixed-case (legacy)
      title: 'Old Mixed Case Title',
      status: 'ACTIVE',
      legacyId: 8000001,
    });

    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-metadata-caseinsensitive',
      hugoVersion: '0.147.0',
      expectedSlugCount: 1,
      initiator: 'test-suite',
    });

    // Publish with the lowercase slug (what fetch-tutorials emits)
    await helpers.appendToSession({
      sessionId,
      files: {},
      metadata: {
        [lowerSlug]: {
          title: 'Updated Mixed Case',
          steps: [{ number: 1, title: 'Step One' }],
        },
      },
    });

    // Must NOT create a duplicate row — exactly one Tutorials row
    const allTuts = await SELECT.from(Tutorials);
    expect(allTuts).toHaveLength(1);

    // Must have updated the existing row (matched by LOWER(slug))
    expect(allTuts[0].title).toBe('Updated Mixed Case');
    // ID must be the same existing row
    expect(allTuts[0].ID).toBe(tutorialId);
    // legacyId must be preserved (row already had one)
    expect(allTuts[0].legacyId).toBe(8000001);
  });

  // -------------------------------------------------------------------------
  // Test 3: SELECT count assertion — batched shape, not per-slug.
  // With 2 slugs, should see exactly:
  //   - 1 raw LOWER(slug) IN lookup (Tutorials)
  //   - 1 CQN IN SELECT on Steps (or 0 if all tutorials are new — but we have
  //     1 existing so there will be a tutorial_ID IN lookup for Steps)
  //   - 1 CQN IN SELECT on TutorialMeta
  //   - 0 per-slug SELECT.one calls on any of these tables
  // -------------------------------------------------------------------------
  it('issues batched IN-list SELECTs (not per-slug SELECT.one calls) for Tutorials/Steps/TutorialMeta', async () => {
    const EXISTING_SLUG = 'batch-count-existing';
    const NEW_SLUG      = 'batch-count-new';

    // Seed existing tutorial with step and meta
    const existingId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: existingId,
      slug: EXISTING_SLUG,
      title: 'Old',
      status: 'ACTIVE',
      legacyId: 7000001,
    });
    await INSERT.into(Steps).entries({
      ID: cds.utils.uuid(),
      tutorial_ID: existingId,
      stepOrder: 1,
      title: 'Old Step',
      status: 'ACTIVE',
      legacyId: 7000002,
    });
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(),
      tutorial_ID: existingId,
      monitoredStatus: 'ACTIVE',
      notificationNumber: 0,
      reviewedDate: '2024-01-01',
      legacyId: 7000003,
    });

    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-metadata-selectcount',
      hugoVersion: '0.147.0',
      expectedSlugCount: 2,
      initiator: 'test-suite',
    });

    const metadata = {
      [EXISTING_SLUG]: {
        title: 'Updated',
        lastUpdated: '2025-07-01',
        steps: [{ number: 1, title: 'Updated Step' }],
      },
      [NEW_SLUG]: {
        title: 'New Tutorial',
        steps: [{ number: 1, title: 'First Step' }],
      },
    };

    const counts = await runWithCounts(sessionId, metadata);

    // 2 raw LOWER(slug) IN lookups per full appendToSession call:
    //   1st: upsertTutorialMetadata (Task 8) — Tutorials batch slug lookup
    //   2nd: linkTutorialAuthorship (Task 9) — authorship batch slug lookup
    // Both are intentional N+1 wins; asserting 2 confirms neither has regressed
    // back to a per-slug pattern.
    expect(
      counts.rawSlugInSelects,
      `Expected exactly 2 raw LOWER(slug) IN SELECTs (1 metadata + 1 authorship), got ${counts.rawSlugInSelects}.`
    ).toBe(2);

    // 1 IN-list SELECT on Steps for the resolved tutorial IDs (not per-slug)
    expect(
      counts.stepsSelectsWithIn,
      `Expected exactly 1 IN-list SELECT on Steps, got ${counts.stepsSelectsWithIn}.`
    ).toBe(1);

    // 1 IN-list SELECT on TutorialMeta for the resolved tutorial IDs (not per-slug)
    expect(
      counts.metaSelectsWithIn,
      `Expected exactly 1 IN-list SELECT on TutorialMeta, got ${counts.metaSelectsWithIn}.`
    ).toBe(1);

    // Zero per-(tutorial_ID, stepOrder) SELECTs on Steps (old N+1 pattern was
    // SELECT.one.from(Steps).where({ tutorial_ID, stepOrder }) — one per step).
    expect(
      counts.stepsPerStepSelects,
      `Expected 0 per-(tutorial_ID,stepOrder) SELECT.one on Steps, got ${counts.stepsPerStepSelects}. N+1 still running.`
    ).toBe(0);

    // Zero per-tutorial_ID SELECTs on TutorialMeta (old N+1 pattern was
    // SELECT.one.from(TutorialMeta).where({ tutorial_ID }) — one per tutorial).
    expect(
      counts.metaPerTutSelects,
      `Expected 0 per-tutorial_ID SELECT.one on TutorialMeta, got ${counts.metaPerTutSelects}. N+1 still running.`
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 4: insertedTutorialIds guard — when the Tutorials INSERT chunk fails
  // for a new tutorial, its steps and meta must NOT be written (no FK violation).
  // An existing tutorial in the same batch must still have its steps updated.
  // -------------------------------------------------------------------------
  it('skips steps and meta for a new tutorial whose Tutorials INSERT chunk fails, existing tutorial steps still update', async () => {
    const EXISTING_SLUG = 'guard-existing-tutorial';
    const NEW_SLUG      = 'guard-new-tutorial';

    // Seed an existing tutorial with one step
    const existingId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: existingId,
      slug: EXISTING_SLUG,
      title: 'Old Guard Title',
      status: 'ACTIVE',
      legacyId: 6000001,
    });
    await INSERT.into(Steps).entries({
      ID: cds.utils.uuid(),
      tutorial_ID: existingId,
      stepOrder: 1,
      title: 'Old Guard Step',
      status: 'ACTIVE',
      legacyId: 6000002,
    });

    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-metadata-guard',
      hugoVersion: '0.147.0',
      expectedSlugCount: 2,
      initiator: 'test-suite',
    });

    // Stub db.run to throw on Tutorials INSERT (simulates a chunk failure for
    // the new tutorial). The stub only fires once (on the INSERT CQN), then
    // restores to normal so subsequent reads/writes proceed.
    const origRun = db.run.bind(db);
    let insertThrown = false;
    db.run = async (q, ...rest) => {
      if (
        !insertThrown &&
        q?.INSERT?.into?.ref?.[0] === TUTORIALS_TABLE
      ) {
        insertThrown = true;
        throw new Error('simulated Tutorials INSERT chunk failure');
      }
      return origRun(q, ...rest);
    };

    try {
      await helpers.appendToSession({
        sessionId,
        files: {},
        metadata: {
          [EXISTING_SLUG]: {
            title: 'Updated Guard Title',
            steps: [{ number: 1, title: 'Updated Guard Step' }],
          },
          [NEW_SLUG]: {
            title: 'New Guard Tutorial',
            steps: [{ number: 1, title: 'New Guard Step' }],
          },
        },
      });
    } finally {
      db.run = origRun;
    }

    // The Tutorials INSERT threw — NEW_SLUG tutorial row must NOT exist.
    const allTuts = await SELECT.from(Tutorials);
    const newTut = allTuts.find(t => t.slug === NEW_SLUG);
    expect(newTut, 'new tutorial must NOT have been inserted (INSERT failed)').toBeUndefined();

    // Steps for the new tutorial must NOT exist (FK guard fired).
    const newTutSteps = await SELECT.from(Steps);
    // All steps in the DB belong to the existing tutorial only.
    const orphanSteps = newTutSteps.filter(s => s.tutorial_ID !== existingId);
    expect(
      orphanSteps,
      `Expected no steps for the failed-insert new tutorial, found ${orphanSteps.length}`
    ).toHaveLength(0);

    // TutorialMeta for the new tutorial must NOT exist.
    const allMeta = await SELECT.from(TutorialMeta);
    const newTutMeta = allMeta.find(m => m.tutorial_ID !== existingId);
    expect(
      newTutMeta,
      'TutorialMeta for failed-insert new tutorial must NOT have been created'
    ).toBeUndefined();

    // Existing tutorial must still have its step updated.
    const existingStep = await SELECT.one.from(Steps).where({ tutorial_ID: existingId, stepOrder: 1 });
    expect(existingStep, 'existing step must still exist').toBeTruthy();
    expect(existingStep.title).toBe('Updated Guard Step');
  });
});
