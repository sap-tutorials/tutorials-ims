# #756 Task 1: Scheduler refactor + JobLastRun retrofit + pre-seed

> **Sibling files:** [Index](./2026-06-29-756-admin-cron-trigger.md) · [Task 2](./2026-06-29-756-task2-jobcontrols.md) · [Task 3](./2026-06-29-756-task3-ui.md)

**Goal:** Refactor `srv/jobs/scheduler.js` to populate a `JOB_REGISTRY` map (single source of truth). Extend `runWithLock` with optional 4th opts arg `{manualTrigger, user}`. Make `recordJobLastRun` invoked unconditionally in `runWithLock`'s finally-block. Remove the inline `recordJobLastRun` call from the `fetch-api-docs` cron body (now dead code). Add `preSeedJobLastRun()` UPSERT at end of `registerJobs()`.

**No new entity. No new dep. No CDS changes.** Pure JavaScript refactor + chassis improvement.

**Prerequisites:** Read the #756 spec §4.1-4.4 + §4.7-4.8 before starting.

**Skills:** `@superpowers:test-driven-development`

---

## 1.1 Scheduler registry foundations

- [ ] **Step 1: Create the failing test `test/unit/srv/scheduler-registry.test.js`** — 5 cases.

```javascript
// test/unit/srv/scheduler-registry.test.js
//
// Unit tests for the JOB_REGISTRY chassis in srv/jobs/scheduler.js.
// Tests registry population, duplicate-name rejection, lockstep with
// registerJobs(), and cron-parser compat for every registered schedule.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import cds from '@sap/cds';
import parser from 'cron-parser';

import {
  registerJob,
  registerJobs,
  runJobByName,
  _getJobRegistry,
  _resetJobRegistry,
} from '../../../srv/jobs/scheduler.js';

describe('scheduler — JOB_REGISTRY chassis', () => {
  beforeEach(() => {
    _resetJobRegistry();
  });

  it('registerJob populates JOB_REGISTRY', () => {
    registerJob({
      jobName: 'test-job-1',
      schedule: '0 0 * * *',
      ttlMs: 1000,
      description: 'unit test',
      fn: async () => 'ok',
    });
    const registry = _getJobRegistry();
    expect(registry.has('test-job-1')).toBe(true);
    expect(registry.get('test-job-1').schedule).toBe('0 0 * * *');
  });

  it('duplicate jobName throws', () => {
    registerJob({ jobName: 'dup', schedule: '0 0 * * *', ttlMs: 1000, description: 'x', fn: async () => 'a' });
    expect(() => registerJob({ jobName: 'dup', schedule: '0 1 * * *', ttlMs: 1000, description: 'x', fn: async () => 'b' })).toThrow(/Duplicate jobName/);
  });

  it('registerJobs() registers exactly 24 jobs (lockstep)', async () => {
    // The full registerJobs() schedules crons against node-cron. We run it
    // in a fresh test context; the test isolates by resetting the registry
    // in beforeEach and again in afterAll (below).
    registerJobs();
    expect(_getJobRegistry().size).toBe(24);
  });

  it('runJobByName(unknownName) throws', async () => {
    await expect(runJobByName('does-not-exist')).rejects.toThrow(/Unknown jobName/);
  });

  it('every registered schedule parses cleanly via cron-parser', () => {
    registerJobs();
    const registry = _getJobRegistry();
    for (const job of registry.values()) {
      expect(() => parser.parseExpression(job.schedule, { utc: true }).next())
        .not.toThrow();
    }
  });

  afterAll(() => {
    _resetJobRegistry();
  });
});
```

**Why these cases:**
- Cases 1+2 prove the registry primitive works.
- Case 3 is the **lockstep test** — if a new cron is added without going through `registerJob`, the count drifts and CI fails.
- Case 4 covers the runJob handler's unknown-name path.
- Case 5 catches malformed cron strings at registration time (no malformed strings ship to production).

- [ ] **Step 2: Run test to verify it fails.**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/spec-756-admin-cron-trigger
npx vitest run test/unit/srv/scheduler-registry.test.js
```

Expected: 5/5 FAIL with "registerJob is not a function" / "_getJobRegistry is not a function" — these don't exist yet.

- [ ] **Step 3: Add the `JOB_REGISTRY` + `registerJob` + test seams + `runJobByName` to `srv/jobs/scheduler.js`.** Insert after the existing top-of-file imports (around line 14) and before the `runWithLock` function (line 23).

```javascript
// #756: JOB_REGISTRY is the single source of truth for all scheduled jobs.
// Both cron.schedule() (in registerJobs() below) and the new
// AdminService.JobControls.runJob() handler read from this map.
//
// Spec: docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md §4.1
const JOB_REGISTRY = new Map();

/**
 * @typedef {Object} JobDef
 * @property {string} jobName
 * @property {string} schedule         cron expression — e.g. '23 4 1 * *'
 * @property {number} ttlMs            lock duration in milliseconds
 * @property {string} description      human-readable, shown in admin tile
 * @property {Function} fn             async () => Promise<unknown> | async (logId) => Promise<unknown>
 */

/**
 * Register a job in the JOB_REGISTRY AND schedule it via node-cron.
 * Both invocation paths (scheduled and manual) read from the registry.
 */
export function registerJob({ jobName, schedule, ttlMs, description, fn }) {
  if (JOB_REGISTRY.has(jobName)) {
    throw new Error(`Duplicate jobName: ${jobName}`);
  }
  JOB_REGISTRY.set(jobName, { jobName, schedule, ttlMs, description, fn });
  // Schedule the cron alongside registration.
  cron.schedule(schedule, () => runJobByName(jobName));
}

/**
 * Runner used by BOTH scheduled cron invocations AND manual admin triggers.
 * Looks up the job in JOB_REGISTRY and delegates to runWithLock.
 *
 * @param {string} jobName
 * @param {{manualTrigger?: boolean, user?: string}} [opts]
 * @returns {Promise<{skipped: boolean, outcome?: string, result?: unknown, errorMessage?: string, reason?: string}>}
 */
export async function runJobByName(jobName, opts = {}) {
  const job = JOB_REGISTRY.get(jobName);
  if (!job) throw new Error(`Unknown jobName: ${jobName}`);
  return runWithLock(job.jobName, job.ttlMs, job.fn, opts);
}

// Test seams (production code MUST NOT use these).
export function _getJobRegistry() { return JOB_REGISTRY; }
export function _resetJobRegistry() { JOB_REGISTRY.clear(); }
export function _setJobFn(jobName, mockFn) {
  const existing = JOB_REGISTRY.get(jobName);
  if (!existing) throw new Error(`Cannot mock unknown job: ${jobName}`);
  JOB_REGISTRY.set(jobName, { ...existing, fn: mockFn });
}
```

- [ ] **Step 4: Re-run the test.**

```bash
npx vitest run test/unit/srv/scheduler-registry.test.js
```

Expected: cases 1, 2, 4 PASS. Cases 3 + 5 still FAIL (registerJobs() hasn't been refactored yet to use registerJob).

That's intentional — the registry primitive works; the refactor of registerJobs() is Step 5+.

---

## 1.2 Refactor `registerJobs()` to use `registerJob({...})`

This is the bulk of the LoC change. 24 declarations replacing 24 `cron.schedule(...)` blocks.

- [ ] **Step 5: Find every `cron.schedule(...)` block in `registerJobs()` and convert.** The current `registerJobs()` spans lines 253-459. Walk through it sequentially.

**Critical: 3 patterns to recognize:**

**Eager-import (21 jobs):**
```javascript
// Before:
cron.schedule('0 0 * * *', () =>
  runWithLock('cleanup-step-failures', 3600000, () => cleanupStepFailures(90))
);

// After:
registerJob({
  jobName: 'cleanup-step-failures',
  schedule: '0 0 * * *',
  ttlMs: 3600000,
  description: 'Delete StepFailures older than 90 days',
  fn: () => cleanupStepFailures(90),
});
```

**Lazy-import (3 jobs: `fetch-discovery-missions`, `fetch-videos`, `fetch-api-docs`):**
```javascript
// Before:
cron.schedule('11 3 * * 0,3', async () => {
  await runWithLock('fetch-videos', 30 * 60 * 1000, async () => {
    const { runFetchVideos } = await import('./fetch-videos-job.js');
    return runFetchVideos();
  });
});

// After:
registerJob({
  jobName: 'fetch-videos',
  schedule: '11 3 * * 0,3',
  ttlMs: 30 * 60 * 1000,
  description: 'Fetch SAP Developers YouTube videos + extract concepts (twice weekly)',
  fn: async () => {
    const { runFetchVideos } = await import('./fetch-videos-job.js');
    return runFetchVideos();
  },
});
```

**With `(logId)` arg (5 jobs: `ngds-retry`, `account-merge-batch`, `contributor-notifications`, `email-retry`, `embedding-reconciliation`):**
```javascript
// Before:
cron.schedule('0 */2 * * *', () =>
  runWithLock('ngds-retry', 1800000, (logId) => retryNgds(logId))
);

// After:
registerJob({
  jobName: 'ngds-retry',
  schedule: '0 */2 * * *',
  ttlMs: 1800000,
  description: 'Retry NGDS failed messages',
  fn: (logId) => retryNgds(logId),
});
```

**The 24 expected job names** (from existing scheduler.js — verify against your grep before declaring done):

1. `cleanup-step-failures` (eager, no logId)
2. `ngds-retry` (eager, logId)
3. `account-merge-batch` (eager, logId)
4. `tag-cleanup` (eager, no logId)
5. `content-gc` (eager, no logId)
6. `publish-stuck-manifest-watchdog` (eager, no logId)
7. `embedding-reconciliation` (eager, logId)
8. `pipeline-log-gc` (eager, no logId)
9. `change-log-gc` (eager, no logId)
10. `embedding-orphan-prune` (eager, no logId)
11. `analytics-history-prune` (eager, no logId)
12. `tutorial-metadata-review` (eager, no logId)
13. `contributor-notifications` (eager, logId)
14. `email-retry` (eager, no logId — verify; if it takes logId, mark accordingly)
15. `extractConcepts` (eager, no logId — verify)
16. `consolidateConcepts` (eager, no logId — verify)
17. `fetch-learning-journeys` (eager, no logId — verify)
18. `fetch-blog-posts` (eager, no logId — verify)
19. `fetch-discovery-missions` (lazy-import)
20. `fetch-videos` (lazy-import)
21. `fetch-api-docs` (lazy-import — AND has inline recordJobLastRun call to delete, see Step 7)
22. `gc-external-content` (eager, no logId — verify)
23. `homepage-link-health` (eager, no logId — verify)

That's 23. The 24th is whichever I missed in the survey — confirm via `grep -c "cron.schedule" srv/jobs/scheduler.js`. The lockstep test (case 3) fails if the count is off.

**Verification helper:** before starting the refactor, dump the existing schedules:

```bash
grep -n "cron.schedule\|runWithLock" srv/jobs/scheduler.js | head -80
```

Convert each block. Keep the existing comments (they document the schedule rationale — preserve them above the `registerJob({...})` block, like:

```javascript
// Sunday + Wednesday at 03:11 — Phase 4.4 YouTube Videos extraction (#447).
// Twice-weekly cadence catches Developer News + Tech Bytes within 3 days
// of publish. Operator must run scripts/seed-videos.cjs once first; the
// cron refuses to self-bootstrap on an empty Videos table (MAX-or-abort gate).
// 30-min TTL covers a steady-state pass of ~10 new videos. Lazy-import
// keeps boot fast.
registerJob({
  jobName: 'fetch-videos',
  schedule: '11 3 * * 0,3',
  ttlMs: 30 * 60 * 1000,
  description: 'Fetch SAP Developers YouTube videos + extract concepts (twice weekly)',
  fn: async () => {
    const { runFetchVideos } = await import('./fetch-videos-job.js');
    return runFetchVideos();
  },
});
```

- [ ] **Step 6: Confirm `registerJobs()` no longer contains any bare `cron.schedule(...)` calls.**

```bash
grep -c "cron.schedule" srv/jobs/scheduler.js
```

Expected: **1** (the call inside `registerJob` itself). Anything else is a missed conversion.

---

## 1.3 Remove `fetch-api-docs` inline `recordJobLastRun` (dead code)

- [ ] **Step 7: Delete the inline `recordJobLastRun` call from the `fetch-api-docs` `fn:` body.**

The Phase 4.5 cron body currently has this shape:

```javascript
fn: async () => {
  const { runFetchApiDocs } = await import('./fetch-api-docs-job.js');
  const summary = await runFetchApiDocs();
  // ↓ DELETE these 5 lines — chassis writes JobLastRun unconditionally now.
  await recordJobLastRun(
    'fetch-api-docs',
    summary.errors === 0 ? 'success' : 'error',
    summary.errors > 0 ? `${summary.errors} errors during cycle` : null,
  );
  return summary;
},
```

After deletion:

```javascript
fn: async () => {
  const { runFetchApiDocs } = await import('./fetch-api-docs-job.js');
  return runFetchApiDocs();
},
```

The `recordJobLastRun` function declaration itself stays — it's the chassis primitive `runWithLock` now uses.

- [ ] **Step 8: Run the lockstep test again.**

```bash
npx vitest run test/unit/srv/scheduler-registry.test.js
```

Expected: all 5 cases PASS. (Case 3 now passes because `registerJobs()` populates the registry.)

- [ ] **Step 9: Commit the registry foundation + refactor.**

```bash
git add srv/jobs/scheduler.js test/unit/srv/scheduler-registry.test.js
git commit -m "feat(#756): JOB_REGISTRY chassis + refactor registerJobs() to declarations

Phase 1 of 3 (Task 1): the scheduler registry foundation.

Changes:
- Add JOB_REGISTRY: Map<jobName, JobDef> as single source of truth.
  registerJob({jobName, schedule, ttlMs, description, fn}) populates the
  map AND schedules the cron — replacing 24 inline cron.schedule(...)
  calls in registerJobs().
- Add runJobByName(jobName, opts) — the runner used by BOTH scheduled
  cron invocations AND the upcoming AdminService.JobControls.runJob()
  manual trigger (Task 2).
- Test seams _getJobRegistry, _resetJobRegistry, _setJobFn for unit tests.
- Remove inline recordJobLastRun(...) call from fetch-api-docs cron body
  — chassis writes it unconditionally in Task 1 §1.4 below; the inline
  call is now dead code that would double-write.

Three cron-fn shapes preserved:
- Eager-import (21 jobs): fn: () => fnRef()
- Lazy-import (3 jobs): fn: async () => { const {x} = await import(...); ... }
- With logId arg (5 jobs): fn: (logId) => fnRef(logId)

5 unit tests added (test/unit/srv/scheduler-registry.test.js):
1. registerJob populates JOB_REGISTRY
2. Duplicate jobName throws
3. registerJobs() registers exactly 24 jobs (lockstep — catches drift)
4. runJobByName(unknownName) throws
5. Every registered schedule parses cleanly via cron-parser (catches
   malformed cron strings at registration time)

Refs #756, spec §4.1-4.2"
```

---

## 1.4 `runWithLock` extension + JobLastRun retrofit

- [ ] **Step 10: Write the failing test `test/unit/srv/run-with-lock.test.js`** — 3 cases.

```javascript
// test/unit/srv/run-with-lock.test.js
//
// Tests for the runWithLock chassis extension in #756:
// - 4th opts arg {manualTrigger, user}
// - Always writes JobLastRun row on completion (success or error)
// - When manualTrigger=true, emits audit events for lockheld + completion

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';

import {
  registerJob,
  runJobByName,
  _resetJobRegistry,
} from '../../../srv/jobs/scheduler.js';

describe('runWithLock — JobLastRun retrofit + manual-trigger opts', () => {
  let db;

  beforeAll(async () => {
    // cds.test() boots an in-memory SQLite with the full model loaded.
    cds.test();
    db = await cds.connect.to('db');
  });

  beforeEach(async () => {
    _resetJobRegistry();
    // Reset JobLastRun between tests.
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    await DELETE.from(JobLastRun);
    // Reset JobLocks too (in case a previous test held a lock).
    const { JobLocks } = cds.entities('com.sap.developers.ims');
    await DELETE.from(JobLocks);
  });

  it('successful fn: returns outcome=success, writes JobLastRun.lastSuccessAt', async () => {
    registerJob({
      jobName: 'test-success',
      schedule: '0 0 1 1 *',     // year-rare; never fires during the test
      ttlMs: 60000,
      description: 'unit test — success path',
      fn: async () => ({ processed: 5 }),
    });

    const result = await runJobByName('test-success');
    expect(result.skipped).toBe(false);
    expect(result.outcome).toBe('success');
    expect(result.result).toEqual({ processed: 5 });

    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(JobLastRun).where({ jobName: 'test-success' });
    expect(row).toBeTruthy();
    expect(row.lastSuccessAt).toBeTruthy();
    expect(row.lastErrorAt).toBeFalsy();
  });

  it('failing fn: returns outcome=error, writes JobLastRun.lastErrorMessage', async () => {
    registerJob({
      jobName: 'test-fail',
      schedule: '0 0 1 1 *',
      ttlMs: 60000,
      description: 'unit test — error path',
      fn: async () => { throw new Error('boom'); },
    });

    const result = await runJobByName('test-fail');
    expect(result.skipped).toBe(false);
    expect(result.outcome).toBe('error');
    expect(result.errorMessage).toBe('boom');

    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(JobLastRun).where({ jobName: 'test-fail' });
    expect(row).toBeTruthy();
    expect(row.lastErrorMessage).toBe('boom');
    expect(row.lastErrorAt).toBeTruthy();
  });

  it('lock-held: returns {skipped: true, reason: lock-held}', async () => {
    registerJob({
      jobName: 'test-lock',
      schedule: '0 0 1 1 *',
      ttlMs: 60000,
      description: 'unit test — lock-held path',
      fn: async () => ({ processed: 1 }),
    });

    // Manually insert a JobLocks row that's not expired.
    const { JobLocks } = cds.entities('com.sap.developers.ims');
    const futureExpiry = new Date(Date.now() + 60000);
    await INSERT.into(JobLocks).entries({
      jobName: 'test-lock',
      lockedBy: 'someone-else',
      lockedAt: new Date(),
      expiresAt: futureExpiry,
    });

    const result = await runJobByName('test-lock');
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('lock-held');
  });
});
```

**Why these cases:**
- Cases 1+2 prove `recordJobLastRun` is invoked for both success and error paths (the retrofit).
- Case 3 proves backward-compat — existing lock-held behavior preserved.

The `manualTrigger=true` audit-emission cases are covered in Task 2's tests (where `emitJobAudit` is defined). Here we just verify the lock-held PATH returns the expected shape.

- [ ] **Step 11: Run; expect FAIL.**

```bash
npx vitest run test/unit/srv/run-with-lock.test.js
```

Expected: 3 FAIL — `runWithLock` doesn't yet return a structured `{skipped, outcome, result, errorMessage}` object; it returns undefined.

- [ ] **Step 12: Refactor `runWithLock` in `srv/jobs/scheduler.js`.** Current body is lines 23-37; full rewrite:

```javascript
/**
 * Distributed-lock wrapper around a cron job's runner function. Acquires
 * a DB-backed lock via JobLocks, runs fn(logId), records JobLastRun on
 * completion (success or error), and releases the lock.
 *
 * #756 (Task 1) extensions vs the previous 3-arg signature:
 *  - 4th opts arg {manualTrigger, user} for the admin-triggered path
 *  - Always invokes recordJobLastRun(jobName, outcome, errorMessage) in
 *    finally block — Phase 4.1-4.5 + future cron retrofit
 *  - When manualTrigger=true, emits SecurityEvent audit events
 *    (lockheld OR success/error) via emitJobAudit (lazily imported from
 *    admin-service.js to avoid circular import)
 *  - Returns a structured response shape: {skipped, outcome, result,
 *    errorMessage, reason} — old void return is now a return value
 *
 * Backward-compat: existing 3-arg callers continue working. opts is
 * optional with sensible defaults.
 *
 * Spec: docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md §4.3
 */
async function runWithLock(jobName, durationMs, fn, opts = {}) {
  const acquired = await acquireLock(jobName, instanceId, durationMs);
  if (!acquired) {
    if (opts.manualTrigger) {
      await emitJobAuditSafely({ jobName, user: opts.user, outcome: 'lockheld' });
    }
    return { skipped: true, reason: 'lock-held' };
  }

  let outcome = 'success';
  let errorMessage = null;
  let result = null;
  const startedAt = new Date();
  const logId = await logPipelineStart('SCHEDULED_JOB', 'system', { jobName });
  try {
    result = await fn(logId);
    const summary = formatJobSummary(jobName, result);
    await logPipelineEnd(logId, 'SUCCESS', summary);
  } catch (err) {
    outcome = 'error';
    errorMessage = err.message ?? String(err);
    LOG.error(`Job ${jobName} failed:`, errorMessage);
    await logPipelineEnd(logId, 'FAILED', jobName, errorMessage);
  } finally {
    await releaseLock(jobName, instanceId);
    try {
      await recordJobLastRun(jobName, outcome, errorMessage);
    } catch (err) {
      LOG.warn(`recordJobLastRun ${jobName} failed: ${err.message}`);
    }
    if (opts.manualTrigger) {
      await emitJobAuditSafely({
        jobName,
        user: opts.user,
        outcome,
        durationMs: Date.now() - startedAt.getTime(),
      });
    }
  }
  return { skipped: false, outcome, result, errorMessage };
}

/**
 * Lazy + safe audit emission. Imports from admin-service.js only when
 * needed (avoids circular import scheduler.js <-> admin-service.js).
 * Swallows all errors — audit emission must never fail the cron.
 */
async function emitJobAuditSafely(opts) {
  try {
    const mod = await import('../admin-service.js');
    if (typeof mod.emitJobAudit === 'function') {
      await mod.emitJobAudit(opts);
    }
  } catch (err) {
    LOG.warn(`emitJobAudit failed: ${err.message}`);
  }
}
```

**Critical: `emitJobAuditSafely` uses dynamic import** to avoid a circular import. Task 2 defines `emitJobAudit` in `srv/admin-service.js`, which itself imports `_getJobRegistry` from `srv/jobs/scheduler.js`. If scheduler.js statically imported admin-service.js, Node would deadlock the load.

The wrapper also degrades gracefully: if `emitJobAudit` isn't exported (e.g. unit test before Task 2 lands), or the import fails (e.g. test environment without the audit-log binding), we log a warning and continue. The cron's primary work + lock release already completed; audit emission is best-effort.

- [ ] **Step 13: Re-run the test.**

```bash
npx vitest run test/unit/srv/run-with-lock.test.js
```

Expected: 3/3 PASS.

- [ ] **Step 14: Run all srv unit tests to verify no regressions.**

```bash
npx vitest run test/unit/srv/
```

Expected: ALL pass (current baseline is 219/219 after Phase 4.5; this PR doesn't change that).

If any existing test fails, the most likely cause is a pre-existing test importing `runWithLock` and asserting on the old `void` return. Find it (`grep -n "runWithLock" test/`) and update.

- [ ] **Step 15: Commit the runWithLock extension.**

```bash
git add srv/jobs/scheduler.js test/unit/srv/run-with-lock.test.js
git commit -m "feat(#756): runWithLock 4th opts arg + JobLastRun retrofit chassis

Phase 2 of 3 (Task 1): runWithLock chassis extension.

Changes:
- runWithLock signature extended with optional 4th opts arg
  {manualTrigger, user}. Backward-compatible — existing 3-arg callers
  unchanged.
- Always invokes recordJobLastRun(jobName, outcome, errorMessage) in
  the finally block. Phase 4.1-4.4 + 4.5 cron history now visible to
  operators via the admin Cron health tile (Task 3).
- When manualTrigger=true, emits SecurityEvent audit events via
  emitJobAuditSafely:
    * lockheld branch: one audit event when lock acquisition fails
    * completion branch: one audit event after fn resolves or throws
- Returns structured {skipped, outcome, result, errorMessage, reason}
  instead of void. Existing scheduled callers ignore the return value.
- emitJobAuditSafely uses dynamic import('../admin-service.js') to
  avoid circular import (admin-service.js imports _getJobRegistry from
  scheduler.js). Degrades gracefully if the import fails or the
  function isn't exported yet (unit tests before Task 2).
- recordJobLastRun() write is guarded — if HANA is briefly unreachable,
  warn-log and continue. The cron's primary work + lock release have
  already completed.

3 unit tests (test/unit/srv/run-with-lock.test.js):
1. Successful fn: returns outcome=success, writes
   JobLastRun.lastSuccessAt
2. Failing fn: returns outcome=error, writes
   JobLastRun.lastErrorMessage
3. Lock-held: returns {skipped: true, reason: 'lock-held'}

219/219 srv unit tests still pass (pre-existing baseline).

Refs #756, spec §4.3"
```

---

## 1.5 Pre-seed JobLastRun on boot

- [ ] **Step 16: Add the `preSeedJobLastRun()` function to `srv/jobs/scheduler.js`.** Place near the bottom of the file, after `recordJobLastRun` (currently around line 47-64):

```javascript
/**
 * Idempotent UPSERT of one JobLastRun row per registered job.
 *
 * Called at the END of registerJobs() so all jobs are visible on the
 * admin Cron health tile from day 1 — even before any cron has fired.
 *
 * Race-safe for multi-instance CF deploys: UPSERT translates to
 * INSERT...ON CONFLICT DO NOTHING semantics on HANA via CDS QL. Two
 * instances racing to seed both succeed without primary-key violation.
 *
 * Best-effort — if HANA is briefly unreachable at boot, warn-log and
 * return. The admin tile will show 0 rows until the first cron actually
 * fires and writes a JobLastRun row via the chassis path.
 *
 * Spec: docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md §4.4
 */
async function preSeedJobLastRun() {
  try {
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const knownJobs = Array.from(JOB_REGISTRY.keys());
    if (knownJobs.length === 0) return;
    await UPSERT.into(JobLastRun).entries(knownJobs.map(jobName => ({ jobName })));
    LOG.info(`pre-seeded ${knownJobs.length} JobLastRun rows (idempotent)`);
  } catch (err) {
    LOG.warn(`JobLastRun pre-seed failed: ${err.message}`);
  }
}
```

- [ ] **Step 17: Invoke `preSeedJobLastRun()` at the end of `registerJobs()`.** Find the closing brace of `registerJobs()` (currently around line 459) and add immediately before it:

```javascript
  // #756 (Task 1): pre-seed JobLastRun so the admin Cron health tile shows
  // all 24 jobs from day 1, even before any cron has fired.
  preSeedJobLastRun().catch(() => {/* already logged inside */});
}
```

The fire-and-forget `.catch(() => {})` is intentional — `registerJobs()` is called synchronously from `cds.on('served')` and shouldn't await the seed (slows boot for a non-essential side-effect).

- [ ] **Step 18: Write the failing test `test/unit/srv/job-controls-boot-seed.test.js`** — 2 cases.

```javascript
// test/unit/srv/job-controls-boot-seed.test.js
//
// Tests for the preSeedJobLastRun() chassis: one JobLastRun row per
// registered job inserted at end of registerJobs(); idempotent rerun.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

import {
  registerJob,
  preSeedJobLastRun,
  _resetJobRegistry,
} from '../../../srv/jobs/scheduler.js';

describe('preSeedJobLastRun', () => {
  let db;

  beforeAll(async () => {
    cds.test();
    db = await cds.connect.to('db');
  });

  beforeEach(async () => {
    _resetJobRegistry();
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    await DELETE.from(JobLastRun);
  });

  it('pre-seed inserts one row per registered job on first call (empty table)', async () => {
    registerJob({ jobName: 'seed-a', schedule: '0 0 1 1 *', ttlMs: 1000, description: 'x', fn: async () => 'ok' });
    registerJob({ jobName: 'seed-b', schedule: '0 0 1 1 *', ttlMs: 1000, description: 'x', fn: async () => 'ok' });

    await preSeedJobLastRun();

    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(JobLastRun);
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.jobName).sort()).toEqual(['seed-a', 'seed-b']);
    // Fresh rows have null timestamps.
    expect(rows[0].lastSuccessAt).toBeFalsy();
    expect(rows[0].lastErrorAt).toBeFalsy();
  });

  it('pre-seed is idempotent — rerun adds zero rows when all jobs already seeded', async () => {
    registerJob({ jobName: 'seed-c', schedule: '0 0 1 1 *', ttlMs: 1000, description: 'x', fn: async () => 'ok' });

    await preSeedJobLastRun();
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const firstCount = (await SELECT.from(JobLastRun)).length;

    await preSeedJobLastRun();
    const secondCount = (await SELECT.from(JobLastRun)).length;

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);
  });
});
```

- [ ] **Step 19: Run; expect FAIL.** `preSeedJobLastRun` is exported but might not yet be importable as expected.

```bash
npx vitest run test/unit/srv/job-controls-boot-seed.test.js
```

If the test fails because `preSeedJobLastRun` isn't exported, add `export` to its declaration in `srv/jobs/scheduler.js`:

```javascript
export async function preSeedJobLastRun() { ... }
```

- [ ] **Step 20: Re-run; expect 2/2 PASS.**

```bash
npx vitest run test/unit/srv/job-controls-boot-seed.test.js
```

- [ ] **Step 21: Run the full srv unit suite to verify no regressions.**

```bash
npx vitest run test/unit/srv/
```

Expected: 224/224 pass (219 baseline + 5 new). Adjust the expected count if the round-2 reviewer's small items added or modified existing tests.

- [ ] **Step 22: Commit the pre-seed chassis.**

```bash
git add srv/jobs/scheduler.js test/unit/srv/job-controls-boot-seed.test.js
git commit -m "feat(#756): preSeedJobLastRun() — one JobLastRun row per registered job

Phase 3 of 3 (Task 1): pre-seed chassis for the admin Cron health tile.

At the end of registerJobs(), UPSERT one JobLastRun row per registered
job so all 24 jobs are visible on the admin tile from day 1 — even
before any cron has fired. Fresh rows have null timestamps; the tile's
formatRelativeTime formatter renders 'Never'.

Race-safe for multi-instance CF deploys: UPSERT translates to
INSERT...ON CONFLICT DO NOTHING on HANA via CDS QL. Two instances
racing to seed both succeed without primary-key violation.

Best-effort — if HANA is briefly unreachable at boot, warn-log and
return. The admin tile will show 0 rows until the first cron actually
fires and writes a JobLastRun row via the chassis path.

Fire-and-forget .catch() at registerJobs() invocation: preSeedJobLastRun
shouldn't block boot for a non-essential side-effect.

2 unit tests (test/unit/srv/job-controls-boot-seed.test.js):
1. First call inserts one row per registered job (empty table)
2. Idempotent rerun — adds zero rows when all jobs already seeded

Task 1 complete. Tasks 2 (JobControls singleton) + 3 (admin UI tile
extension) build on this chassis.

Refs #756, spec §4.4"
```

---

## Task 1 close-out

| Item | State |
|---|---|
| `JOB_REGISTRY` + `registerJob` primitive | ✓ |
| 24 cron registrations refactored | ✓ |
| 3 lazy-import crons preserved | ✓ |
| 5 logId crons preserved | ✓ |
| Inline `recordJobLastRun` in fetch-api-docs removed | ✓ |
| `runWithLock` 4th opts arg + structured return | ✓ |
| `recordJobLastRun` always-write in finally block | ✓ |
| `emitJobAuditSafely` lazy-import (no circular) | ✓ |
| `preSeedJobLastRun()` UPSERT | ✓ |
| Pre-seed invoked at end of registerJobs() | ✓ |
| 10 unit tests (5 registry + 3 runWithLock + 2 pre-seed) | ✓ |
| Pre-existing srv unit tests still pass | ✓ |
| **CDS schema unchanged** (`cds build --production` no-op) | ✓ |

Next: [Task 2 — JobControls singleton + handlers](./2026-06-29-756-task2-jobcontrols.md)
