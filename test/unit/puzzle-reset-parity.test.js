// test/unit/puzzle-reset-parity.test.js
//
// Executable spec for puzzle-reset parity with tutorial-reset (issue SDD-2026-08-01).
// Run with: npm test -- test/unit/puzzle-reset-parity.test.js
//
// All four suites INTENTIONALLY FAIL against the current (unfixed) code:
//   - Rate Limiting:         resetPuzzleProgress has no checkRateLimit call
//   - Re-completion Attempt: complete() hardcodes attemptNumber: 1 (puzzle-service.js ~line 199)
//   - Audit Event:           resetPuzzleProgress emits no PuzzleProgressReset event
//   - PreviousAttemptCompletedAt: return shape is missing that field
//
// Reference: test/unit/reset-tutorial-progress.test.js (bootstrap + assert patterns)

import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { _resetForTests as resetRateLimitBuckets } from '../../srv/lib/per-user-rate-limit.js';

// Boot CAP with in-memory SQLite — must be at module level so the schema is
// deployed and cds.entities / cds.services are populated before describe blocks
// resolve them.  Same idiom as reset-tutorial-progress.test.js.
const project = cds.test('serve', '--project', '.', '--in-memory'); // eslint-disable-line no-unused-vars

// Clear the per-user rate-limit bucket Map before every test.
// The limiter key for puzzle reset will be `puzzle-reset:${sapId}`.
// Without this, any 5-reset sequence from one test would saturate the bucket
// for the same sapId in the next test (the Map persists across tests in a file).
beforeEach(() => {
  resetRateLimitBuckets();
});

// ─── Shared puzzle constants ──────────────────────────────────────────────────
//
// Minimal 1-word crossword: letters C-A-T at row 0, columns 0-2.
// deriveSlotIds produces exactly ONE slot: "0-0-across"
//   — sol["0,-1"] is undefined (no left neighbour), sol["0,1"] is defined
//     → run starts at 0,0 → across slot id "0-0-across"
// No DOWN slot because every column has only one white cell (no vertical run ≥ 2).
// This keeps the solution trivially fillable in tests without constructing a
// full grid JSON and satisfies gradeEntries / wordAt exactly.

const PUZZLE_SLUG       = 'parity-test-puzzle';
const PUZZLE_ID         = 'parity-puzzle-fixed-id';  // stable so re-seeds don't leave orphans
const PUZZLE_LEGACY_ID  = 99001;
const PUZZLE_SOLUTION   = JSON.stringify({ '0,0': 'C', '0,1': 'A', '0,2': 'T' });
const PUZZLE_GRID_CORRECT = JSON.stringify({ '0,0': 'C', '0,1': 'A', '0,2': 'T' });

// ─── Seed helper ─────────────────────────────────────────────────────────────

async function seedPuzzle() {
  const { Puzzles } = cds.entities('com.sap.developers.ims');
  // Idempotent: DELETE first so re-seeds across beforeEach calls never hit the
  // @assert.unique.slug constraint.  SQLite FK enforcement is off by default in
  // CAP's in-memory adapter, so leftover PuzzleProgress rows are harmless.
  await DELETE.from(Puzzles).where({ slug: PUZZLE_SLUG });
  await INSERT.into(Puzzles).entries({
    ID: PUZZLE_ID,
    slug: PUZZLE_SLUG,
    title: 'Parity Test Puzzle',
    solution: PUZZLE_SOLUTION,
    layout: '{}',           // not needed for gradeEntries / wordAt
    legacyId: PUZZLE_LEGACY_ID,
  });
}

// ─── Auth context helper ──────────────────────────────────────────────────────
//
// Sets cds.context.user so resolveUserSapId(user) returns sapId.
// resolveUserSapId falls back to user.id when no XSUAA authInfo is present
// (see srv/lib/resolve-db-user.js:49).

function setUser(sapId) {
  cds.context = { user: new cds.User({ id: sapId }) };
}

// ─── Action helpers ───────────────────────────────────────────────────────────

async function saveProgress(sapId, filledGrid = PUZZLE_GRID_CORRECT) {
  setUser(sapId);
  return cds.services.PuzzleService.send({
    event: 'saveProgress',
    data: { slug: PUZZLE_SLUG, filledGrid },
  });
}

async function completePuzzle(sapId) {
  setUser(sapId);
  return cds.services.PuzzleService.send({
    event: 'complete',
    data: { slug: PUZZLE_SLUG },
  });
}

async function resetPuzzle(sapId) {
  setUser(sapId);
  return cds.services.PuzzleService.send({
    event: 'resetPuzzleProgress',
    data: { slug: PUZZLE_SLUG },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiting
//
// Expected behaviour after fix: at most 5 resets per user per hour.
// Bucket key: `puzzle-reset:${sapId}` in per-user-rate-limit.js.
//
// Pre-fix failures:
//   "allows 5 resets" — PASSES (all succeed; no limit enforced yet)
//   "rejects 6th"     — FAILS  (6th resolves instead of rejecting 429)
// ─────────────────────────────────────────────────────────────────────────────
describe('Puzzle Reset → Rate Limiting', () => {
  beforeEach(async () => {
    await seedPuzzle();
  });

  it('allows 5 resets within 1 hour', async () => {
    // Each reset uses the SAME sapId; with no rate limit all 5 should succeed.
    // This test must PASS before the fix (validating no regression on the happy path).
    const SAP_ID = 'sap-rl-allow5';
    for (let i = 0; i < 5; i++) {
      const result = await resetPuzzle(SAP_ID);
      expect(result).toHaveProperty('newAttemptNumber');
    }
  });

  it('rejects the 6th reset within 1 hour with 429', async () => {
    // First 5 calls must succeed; the 6th must reject with code 429.
    // FAILS before fix: the handler has no checkRateLimit call, so all 6 succeed.
    const SAP_ID = 'sap-rl-reject6';
    for (let i = 0; i < 5; i++) {
      await resetPuzzle(SAP_ID);
    }
    await expect(resetPuzzle(SAP_ID)).rejects.toMatchObject({ code: 429 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Re-completion Attempt Number
//
// After reset, PuzzleProgress.attemptNumber is bumped (e.g. 1 → 2).
// The `complete` handler must read that value and pass it to the new TaskRecord.
//
// Pre-fix failures:
//   "first completion" — PASSES  (hardcoded 1 == expected 1)
//   "attempt 2 after reset" — FAILS  (complete writes attemptNumber: 1 not 2)
// ─────────────────────────────────────────────────────────────────────────────
describe('Puzzle Reset → Re-completion Attempt Number', () => {
  beforeEach(async () => {
    await seedPuzzle();
  });

  it('records attemptNumber 1 on first completion', async () => {
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    const SAP_ID = 'sap-an-first';

    await saveProgress(SAP_ID);
    const r = await completePuzzle(SAP_ID);
    expect(r.recorded).toBe(true);

    const dbUser = await SELECT.one.from(Users).where({ sapId: SAP_ID });
    const record = await SELECT.one.from(TaskRecords).where({
      user_ID: dbUser.ID,
      taskLegacyId: PUZZLE_LEGACY_ID,
      taskType: 'PUZZLE',
    });
    // Passes before fix: complete hardcodes 1, which is correct for the first attempt.
    expect(record.attemptNumber).toBe(1);
  });

  it('records attemptNumber 2 after a reset and re-completion', async () => {
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    const SAP_ID = 'sap-an-second';

    // ── Attempt 1: complete the puzzle ────────────────────────────────────────
    await saveProgress(SAP_ID);
    const r1 = await completePuzzle(SAP_ID);
    expect(r1.recorded).toBe(true);

    // ── Reset: PuzzleProgress.attemptNumber bumped to 2, TaskRecord superseded ─
    const resetResult = await resetPuzzle(SAP_ID);
    expect(resetResult.newAttemptNumber).toBe(2);

    // ── Attempt 2: re-fill the grid (saveProgress only UPDATEs filledGrid;
    //    attemptNumber on the PuzzleProgress row stays 2) and re-complete ───────
    await saveProgress(SAP_ID);
    const r2 = await completePuzzle(SAP_ID);
    expect(r2.recorded).toBe(true);

    // The live (non-SUPERSEDED) TaskRecord must carry attemptNumber 2.
    // FAILS before fix: puzzle-service.js ~line 199 hardcodes attemptNumber: 1.
    const dbUser = await SELECT.one.from(Users).where({ sapId: SAP_ID });
    const liveRecord = await SELECT.one.from(TaskRecords).where({
      user_ID: dbUser.ID,
      taskLegacyId: PUZZLE_LEGACY_ID,
      taskType: 'PUZZLE',
      status: { '!=': 'SUPERSEDED' },
    });
    expect(liveRecord.attemptNumber).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit Event
//
// resetPuzzleProgress must emit a PuzzleProgressReset event on the GLOBAL CDS
// bus (cds.emit — parity with TutorialProgressReset in resetTutorialProgress).
// The test listens via cds.once so it validates the same bus the admin-service.js
// audit handler uses, and auto-removes itself after one fire (no cross-test leak).
// ─────────────────────────────────────────────────────────────────────────────
describe('Puzzle Reset → Audit Event', () => {
  beforeEach(async () => {
    await seedPuzzle();
  });

  it('emits PuzzleProgressReset with the correct payload', async () => {
    const { PuzzleService } = cds.services;
    const SAP_ID = 'sap-audit-ev';

    // Ensure the user row exists before resetting (saveProgress uses resolveOrCreateUser).
    // Without this, resetPuzzleProgress returns early (no-op for an unseen user) and
    // cds.emit is never reached — the Promise below would hang until timeout.
    await saveProgress(SAP_ID);

    let captured = null;
    // Register on the GLOBAL CDS bus — the same bus the admin-service.js audit
    // listener uses.  cds.once gives clean single-capture semantics and
    // auto-removes itself after firing, so there is no cross-test contamination.
    await new Promise((resolve) => {
      cds.once('PuzzleProgressReset', (msg) => {
        captured = msg?.data ?? msg;
        resolve();
      });

      setUser(SAP_ID);
      PuzzleService.send({
        event: 'resetPuzzleProgress',
        data: { slug: PUZZLE_SLUG },
      });
    });

    // Promise resolves only after the event fires, so captured is always set here.
    expect(captured).toBeTruthy();
    expect(captured).toHaveProperty('puzzleSlug', PUZZLE_SLUG);
    expect(captured).toHaveProperty('attemptNumber');
    expect(captured).toHaveProperty('supersededRecordCount');
    expect(captured).toHaveProperty('previousAttemptCompletedAt');
    expect(captured).toHaveProperty('tokenSource');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PreviousAttemptCompletedAt
//
// The return shape of resetPuzzleProgress must include previousAttemptCompletedAt
// (timestamp of the COMPLETED TaskRecord being superseded, or null if none).
// Parity with resetTutorialProgress (issue #600).
//
// Pre-fix failures:
//   "returns date" — FAILS (field absent in return shape; toHaveProperty fails)
//   "returns null" — FAILS (field absent; toBeNull() fails on undefined)
// ─────────────────────────────────────────────────────────────────────────────
describe('Puzzle Reset → PreviousAttemptCompletedAt', () => {
  beforeEach(async () => {
    await seedPuzzle();
  });

  it('returns previousAttemptCompletedAt matching the prior completion date', async () => {
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    const SAP_ID = 'sap-prev-date';

    // Complete the puzzle to create a TaskRecord with a completionDate.
    await saveProgress(SAP_ID);
    const c = await completePuzzle(SAP_ID);
    expect(c.recorded).toBe(true);

    // Sanity: the TaskRecord was written with a completionDate.
    const dbUser = await SELECT.one.from(Users).where({ sapId: SAP_ID });
    const completedRecord = await SELECT.one.from(TaskRecords).where({
      user_ID: dbUser.ID,
      taskLegacyId: PUZZLE_LEGACY_ID,
      taskType: 'PUZZLE',
      status: 'COMPLETED',
    });
    expect(completedRecord?.completionDate).toBeTruthy();

    // Reset — response must carry previousAttemptCompletedAt.
    const result = await resetPuzzle(SAP_ID);

    // FAILS before fix: return is { newAttemptNumber, supersededRecordCount };
    // previousAttemptCompletedAt key is absent.
    expect(result).toHaveProperty('previousAttemptCompletedAt');
    expect(result.previousAttemptCompletedAt).toBeTruthy();
  });

  it('returns null previousAttemptCompletedAt when no prior completion exists', async () => {
    const SAP_ID = 'sap-prev-null';

    // Reset a puzzle the user has never completed — no COMPLETED TaskRecord exists.
    const result = await resetPuzzle(SAP_ID);

    // FAILS before fix: return shape has no previousAttemptCompletedAt key;
    // undefined !== null so toBeNull() fails, but toHaveProperty already catches it first.
    expect(result).toHaveProperty('previousAttemptCompletedAt');
    expect(result.previousAttemptCompletedAt).toBeNull();
  });
});
