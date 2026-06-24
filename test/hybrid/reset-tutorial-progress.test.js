// Hybrid HANA test for Task 14 (#600): the two recompute paths must NEVER
// touch SUPERSEDED rows.
//
// Without this fix, both `recomputeTutorialProgressBulkSQL` (HANA MERGE) and
// the per-row JS `recomputeTutorialProgress` would wipe the preserved
// `completionDate` on a SUPERSEDED row every time the publish pipeline ran —
// breaking the spec's "preserve past completions on /me/" guarantee.
//
// This test seeds a (user, tutorial) into the SUPERSEDED + IN_PROGRESS shape
// produced by `DeveloperService.resetTutorialProgress`, snapshots the
// SUPERSEDED row's completionDate BEFORE recompute, then calls each recompute
// path and asserts the SUPERSEDED row's completionDate is unchanged.
//
// Run with:
//   ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run \
//     test/hybrid/reset-tutorial-progress.test.js --project hybrid
// Requires: `cf login` to a HANA-bound CF space first.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import cds from '@sap/cds';
import { recomputeTutorialProgressBulkSQL } from '../../srv/lib/recompute-tutorial-progress-bulk-sql.js';
import { recomputeTutorialProgress } from '../../srv/lib/content-store.js';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const NS = 'com.sap.developers.ims';

// Uniquely-prefixed test data so cleanup can recover from a mid-test panic.
const RUN_TAG = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const PREFIX = `__TEST__reset-recompute-${RUN_TAG}`;
const TEST_MARKER = '__TEST__reset-recompute-';

// Carve out a legacyId range well above the production sequence.
let nextLegacy = 91_000_000 + Math.floor(Math.random() * 1_000_000);
const nextLegacyId = () => nextLegacy++;

const writesEnabled = process.env.ALLOW_HYBRID_WRITES === 'true';

describe.runIf(writesEnabled && isSafeForWrites())(
  'Task 14 (#600): recompute paths preserve SUPERSEDED completionDate',
  () => {
    let db;
    const seeded = {
      userIds: new Set(),
      tutorialIds: new Set(),
      stepIds: new Set(),
      taskRecordIds: new Set(),
    };

    // Seed a tutorial that has been completed once at attempt 1, then
    // reset — leaving 4 SUPERSEDED rows (3 STEP + 1 TUTORIAL, all preserving
    // their original completionDate) plus 1 IN_PROGRESS TUTORIAL row at
    // attempt 2.
    //
    // Returns:
    //   { tutorialId, tutorialLegacy, userId, supersededTrId,
    //     supersededOriginalDate }
    async function seedSupersededState(label) {
      const { Users, Tutorials, Steps, TaskRecords } = cds.entities(NS);

      const userId = cds.utils.uuid();
      seeded.userIds.add(userId);
      await db.run(
        INSERT.into(Users).entries({
          ID: userId,
          uuid: cds.utils.uuid(),
          legacyId: nextLegacyId(),
          firstName: '__TEST__',
          lastName: `${PREFIX}-user-${label}`,
        })
      );

      const tutorialId = cds.utils.uuid();
      const tutorialLegacy = nextLegacyId();
      seeded.tutorialIds.add(tutorialId);
      await db.run(
        INSERT.into(Tutorials).entries({
          ID: tutorialId,
          legacyId: tutorialLegacy,
          slug: `${PREFIX}-tut-${label}`,
          title: `__TEST__ reset-recompute ${label}`,
          stepCount: 3,
          status: 'ACTIVE',
        })
      );

      const stepEntries = [];
      const stepLegacyIds = [];
      for (let i = 0; i < 3; i++) {
        const stepId = cds.utils.uuid();
        const stepLegacy = nextLegacyId();
        stepLegacyIds.push(stepLegacy);
        seeded.stepIds.add(stepId);
        stepEntries.push({
          ID: stepId,
          tutorial_ID: tutorialId,
          stepOrder: i + 1,
          title: `__TEST__ ${label} step ${i + 1}`,
          legacyId: stepLegacy,
          status: 'ACTIVE',
        });
      }
      await db.run(INSERT.into(Steps).entries(stepEntries));

      // Pick a stable "historical" completion timestamp so the test can
      // round-trip-compare it later. HANA truncates to microsecond precision;
      // a fixed second-aligned ISO works for our purposes.
      const historicalDate = '2026-01-15T10:30:00.000Z';
      const supersededTrId = cds.utils.uuid();
      const trAttempt2Id = cds.utils.uuid();
      seeded.taskRecordIds.add(supersededTrId);
      seeded.taskRecordIds.add(trAttempt2Id);

      // The 3 SUPERSEDED STEP rows from attempt 1 (all completed).
      const stepRecords = stepLegacyIds.map((legId, i) => {
        const id = cds.utils.uuid();
        seeded.taskRecordIds.add(id);
        return {
          ID: id,
          user_ID: userId,
          taskType: 'STEP',
          status: 'SUPERSEDED',
          taskLegacyId: legId,
          progress: 100,
          completionDate: historicalDate,
          attemptNumber: 1,
          legacyId: nextLegacyId(),
        };
      });

      await db.run(
        INSERT.into(TaskRecords).entries([
          ...stepRecords,
          // The SUPERSEDED TUTORIAL row from attempt 1 — the row this test
          // is centrally concerned with. Its completionDate must survive.
          {
            ID: supersededTrId,
            user_ID: userId,
            taskType: 'TUTORIAL',
            status: 'SUPERSEDED',
            taskLegacyId: tutorialLegacy,
            progress: 100,
            completionDate: historicalDate,
            attemptNumber: 1,
            legacyId: nextLegacyId(),
          },
          // Fresh attempt-2 TUTORIAL row at IN_PROGRESS, progress 0.
          {
            ID: trAttempt2Id,
            user_ID: userId,
            taskType: 'TUTORIAL',
            status: 'IN_PROGRESS',
            taskLegacyId: tutorialLegacy,
            progress: 0,
            attemptNumber: 2,
            legacyId: nextLegacyId(),
          },
        ])
      );

      // Snapshot the SUPERSEDED row's completionDate BEFORE recompute.
      // HANA returns this as a Date / iso string depending on the driver; we
      // capture the raw value and compare via normalized epoch ms later.
      const snapshotRow = await SELECT.one
        .from(TaskRecords)
        .where({ ID: supersededTrId });
      const supersededOriginalDate = snapshotRow.completionDate;

      return {
        tutorialId,
        tutorialLegacy,
        userId,
        supersededTrId,
        trAttempt2Id,
        supersededOriginalDate,
      };
    }

    // Normalize a HANA datetime value (Date | string | null) to epoch ms.
    // Treats null/undefined as null. The HANA driver may surface either a
    // JS Date or an ISO-ish string depending on environment; epoch ms is
    // the robust common denominator.
    function toEpoch(v) {
      if (v === null || v === undefined) return null;
      if (v instanceof Date) return v.getTime();
      return new Date(v).getTime();
    }

    beforeAll(async () => {
      db = await cds.connect.to('db');
      const isHana =
        db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
      if (!isHana) {
        throw new Error(
          'reset-tutorial-progress.test.js must run against HANA. ' +
            'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
        );
      }
      // Defensive pre-clean — recover from any prior panic.
      const { Users, Tutorials, TaskRecords } = cds.entities(NS);
      const oldUsers = await SELECT.from(Users)
        .columns('ID')
        .where({ lastName: { like: `${TEST_MARKER}%` } });
      if (oldUsers.length > 0) {
        const ids = oldUsers.map((r) => r.ID);
        await db.run(DELETE.from(TaskRecords).where({ user_ID: { in: ids } }));
        await db.run(DELETE.from(Users).where({ ID: { in: ids } }));
      }
      await db.run(
        DELETE.from(Tutorials).where({ slug: { like: `${TEST_MARKER}%` } })
      );
    });

    afterAll(async () => {
      if (!db) return;
      const { Users, Tutorials, Steps, TaskRecords } = cds.entities(NS);
      try {
        if (seeded.taskRecordIds.size > 0) {
          await db.run(
            DELETE.from(TaskRecords).where({
              ID: { in: [...seeded.taskRecordIds] },
            })
          );
        }
        if (seeded.stepIds.size > 0) {
          await db.run(DELETE.from(Steps).where({ ID: { in: [...seeded.stepIds] } }));
        }
        if (seeded.tutorialIds.size > 0) {
          await db.run(
            DELETE.from(Tutorials).where({ ID: { in: [...seeded.tutorialIds] } })
          );
        }
        if (seeded.userIds.size > 0) {
          await db.run(
            DELETE.from(Users).where({ ID: { in: [...seeded.userIds] } })
          );
        }
      } catch (err) {
        console.error('[afterAll cleanup] error:', err.message);
        throw err;
      }
    });

    // ----------------------------------------------------------------------
    // 1. Bulk-SQL MERGE path: SUPERSEDED row's completionDate must survive.
    // ----------------------------------------------------------------------
    it('bulk-SQL MERGE does NOT touch SUPERSEDED TUTORIAL rows', async () => {
      const { TaskRecords } = cds.entities(NS);
      const seed = await seedSupersededState('bulk');

      await recomputeTutorialProgressBulkSQL(db, NS, [seed.tutorialId]);

      const row = await SELECT.one
        .from(TaskRecords)
        .where({ ID: seed.supersededTrId });
      expect(row).toBeTruthy();
      expect(row.status).toBe('SUPERSEDED');
      expect(row.progress).toBe(100);
      // The canonical correctness assertion: completionDate is unchanged.
      expect(toEpoch(row.completionDate)).toBe(toEpoch(seed.supersededOriginalDate));
      expect(toEpoch(row.completionDate)).not.toBeNull();

      // The IN_PROGRESS attempt-2 row stays at 0 (no completed steps yet),
      // so MERGE's WHEN MATCHED predicate is satisfied for it but the new
      // progress equals the old (0), so it's a no-op.
      const attempt2 = await SELECT.one
        .from(TaskRecords)
        .where({ ID: seed.trAttempt2Id });
      expect(attempt2.status).toBe('IN_PROGRESS');
      expect(attempt2.progress).toBe(0);
      expect(attempt2.completionDate).toBeFalsy();
    });

    // ----------------------------------------------------------------------
    // 2. Per-row JS path: same invariant.
    // ----------------------------------------------------------------------
    it('per-row recomputeTutorialProgress does NOT touch SUPERSEDED TUTORIAL rows', async () => {
      const { TaskRecords } = cds.entities(NS);
      const seed = await seedSupersededState('perrow');

      await recomputeTutorialProgress(db, NS, seed.tutorialId, 3);

      const row = await SELECT.one
        .from(TaskRecords)
        .where({ ID: seed.supersededTrId });
      expect(row).toBeTruthy();
      expect(row.status).toBe('SUPERSEDED');
      expect(row.progress).toBe(100);
      expect(toEpoch(row.completionDate)).toBe(toEpoch(seed.supersededOriginalDate));
      expect(toEpoch(row.completionDate)).not.toBeNull();

      const attempt2 = await SELECT.one
        .from(TaskRecords)
        .where({ ID: seed.trAttempt2Id });
      expect(attempt2.status).toBe('IN_PROGRESS');
      expect(attempt2.progress).toBe(0);
      expect(attempt2.completionDate).toBeFalsy();
    });
  }
);
