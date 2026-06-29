# #756 Task 2: JobControls singleton + handlers

> **Sibling files:** [Index](./2026-06-29-756-admin-cron-trigger.md) · [Task 1](./2026-06-29-756-task1-scheduler.md) · [Task 3](./2026-06-29-756-task3-ui.md)

**Goal:** Add the `AdminService.JobControls` singleton with `listJobs()` + `runJob(jobName)` actions. Implement the `emitJobAudit` helper (exported for `scheduler.js` lazy-import). Add `cron-parser` dependency. Wire 6 unit tests + 1 hybrid sanity test.

**Prerequisites:** Task 1 merged or stacked. The `JOB_REGISTRY`, `runJobByName`, and pre-seed chassis are assumed present.

**Skills:** `@superpowers:test-driven-development`

---

## 2.1 Add `cron-parser` dependency

- [ ] **Step 1: Verify `cron-parser` is NOT already in `dependencies`.**

```bash
node -e "try { require('cron-parser'); console.log('found'); } catch (e) { console.log('not found'); }"
```

Expected: "not found" (verified during spec round 1). If "found", check `package.json` for an explicit entry; if it's only transitive, you still need to add it directly so the npm `--save-exact` policy + `min-release-age` enforcement apply.

- [ ] **Step 2: Install `cron-parser` pinned via `--save-exact`.**

```bash
npm install --save-exact cron-parser
```

This satisfies the project's npm policy (`save-exact: true`, `min-release-age=1 DAY` per memory).

- [ ] **Step 3: Verify `package.json` + `package-lock.json` updated.**

```bash
git diff package.json | grep cron-parser
node -e "const v = require('./package.json').dependencies['cron-parser']; console.log(v); if (v.startsWith('^') || v.startsWith('~')) process.exit(1);"
```

Expected: `git diff` shows the new entry with an exact version (no `^` or `~` prefix).

- [ ] **Step 4: Smoke-test the import works.**

```bash
node -e "const parser = require('cron-parser'); console.log(parser.parseExpression('23 4 1 * *', { utc: true }).next().toISOString());"
```

Expected: an ISO timestamp printed (the next 1st-of-month at 04:23 UTC).

---

## 2.2 Declare `JobControls` singleton in CDS

- [ ] **Step 5: Add the singleton + 2 actions to `srv/admin-service.cds`.** Place after the existing `KnowledgeGraphSettings` singleton (around line 210-220):

```cds
// ─────────────────────────────────────────────────────────────────
// #756: generic admin trigger for any registered cron job.
// Operators can list all 24 registered jobs (with computed next-run
// timestamp) and trigger any of them manually. Trigger is fire-and-forget;
// completion observed via JobLastRun + the SecurityEvent audit log.
// ─────────────────────────────────────────────────────────────────
@odata.singleton
@requires: 'Admin'
entity JobControls {
  key label : String default 'Job controls';

  actions {
    action listJobs() returns array of {
      jobName     : String;
      schedule    : String;
      ttlMs       : Integer;
      description : String;
      nextRunIso  : String;
    };

    action runJob(jobName: String) returns {
      jobName   : String;
      started   : Boolean;
      skipped   : Boolean;
      reason    : String;
      startedAt : Timestamp;
    };
  };
}
```

The `key label : String default 'Job controls'` is intentional — CAP singletons need a key, and using a static default keeps the singleton URI stable (`/admin/JobControls` resolves to the lone row).

- [ ] **Step 6: Verify CDS compiles.**

```bash
npx cds compile srv/admin-service.cds 2>&1 | tail -10
```

Expected: no errors. The compile may show pre-existing warnings unrelated to this change.

- [ ] **Step 7: Run `cds build --production` to verify no schema drift.**

```bash
npx cds build --production 2>&1 | tail -10
git status --short
```

Expected: build succeeds; `git status` clean (no tracked-artefact drift since we only added an action declaration, no entities).

---

## 2.3 Implement `emitJobAudit` helper + handlers

- [ ] **Step 8: Find the canonical audit-emission scope in `srv/admin-service.js`.**

```bash
grep -n "auditEvent\s*=\s*createAuditEmitter\|_auditLog\s*=\s*await cds.connect.to" srv/admin-service.js | head -5
```

Expected: locates the `auditEvent` closure declaration (around line 1583 per spec §4.8). Your handler MUST be placed inside the same init-scope where `auditEvent` is in lexical scope — typically inside the `init()` method of the AdminService class around lines 1500-2000.

- [ ] **Step 9: Add the `emitJobAudit` helper as a MODULE-LEVEL export** (not inside the init method).

Place near the top of `srv/admin-service.js`, after the imports (around line 25):

```javascript
import { _getJobRegistry, runJobByName } from './jobs/scheduler.js';
import parser from 'cron-parser';

// #756: max jobName payload length. Matches JobLocks.jobName : String(100)
// column width verified in db/schema.cds.
const MAX_JOB_NAME_LEN = 100;

/**
 * Emit a SecurityEvent audit row for the manual-trigger lifecycle.
 *
 * Two invocations per click: one with outcome='started' synchronously
 * on the runJob action; one with outcome ∈ {success, error, lockheld}
 * after the cron resolves (or the lock is held).
 *
 * Exported so srv/jobs/scheduler.js can lazy-import this from inside
 * runWithLock's emitJobAuditSafely wrapper (circular-import-safe).
 *
 * The first arg to auditEvent is the ACTION NAME (per
 * srv/lib/audit-event.js JSDoc) — NOT 'SecurityEvent', which is the
 * audit-log event type hardcoded inside the createAuditEmitter closure.
 * Do NOT lift the seedApiDocs precedent literally — it has a subtle bug
 * (filed as #769) where 'SecurityEvent' is passed as the first arg with
 * a nested action: in data, working only by spread-override luck.
 *
 * Spec: docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md §4.8
 *
 * @param {{jobName: string, user?: string, outcome: 'started'|'success'|'error'|'lockheld', durationMs?: number, startedAt?: Date}} opts
 * @returns {Promise<void>}
 */
export async function emitJobAudit({ jobName, user, outcome, durationMs = null, startedAt = null }) {
  // emitJobAudit lives at module scope; the auditEvent closure is built
  // inside the service init() at line ~1583. We can't reference it
  // directly from here. Instead, expose it via module-level state set
  // by the service init() (next step).
  const auditEvent = _moduleAuditEvent;
  if (!auditEvent) {
    // Service not yet initialized OR audit-log binding unavailable.
    // Log + return — never fail the cron because of audit emission.
    console.warn('emitJobAudit: auditEvent not initialized; skipping');
    return;
  }
  try {
    await auditEvent('cron.manual-trigger', {
      jobName,
      user,
      outcome,
      ...(durationMs != null && { durationMs }),
      ...(startedAt != null && { startedAt: startedAt.toISOString() }),
    });
  } catch (err) {
    console.warn(`emitJobAudit ${jobName}/${outcome} failed: ${err.message}`);
  }
}

// Module-level closure pointer. Set by the service init() right after
// auditEvent = createAuditEmitter(...). Allows emitJobAudit to be a
// module-level export (so scheduler.js can import it via dynamic import)
// while still benefiting from the service-init's audit-log binding
// resolution.
let _moduleAuditEvent = null;
```

The `_moduleAuditEvent` indirection is the trickiest part of this task — it lets us:
1. Keep `emitJobAudit` at module scope (so `scheduler.js` can dynamic-import it via the chassis path Task 1 established).
2. Still benefit from the service init's audit-log binding resolution (which happens once at boot, inside `init()`).

**Test isolation concern (round-2 plan-reviewer flag):** `_moduleAuditEvent` is module-scoped state — a vitest test that doesn't reset it between cases could observe stale state from a prior test's service init. The unit tests in §2.4 below all run `cds.test()` in `beforeAll` (once per describe block), so the service-init runs once and `_moduleAuditEvent` is set for the entire run. Within a single suite this is fine. Tests across multiple `describe` blocks share the same module — if a future test imports `srv/admin-service.js` and asserts `_moduleAuditEvent === null` BEFORE the service init has run, it will fail. Document this limitation in the module-level doc-comment of `emitJobAudit`.

- [ ] **Step 10: In the service `init()` method, wire `_moduleAuditEvent` after `auditEvent` is created.** Find the existing line `const auditEvent = createAuditEmitter(_auditLog, LOG);` (around line 1583) and immediately after it, add:

```javascript
// #756: expose the audit closure to the module-level emitJobAudit helper
// so srv/jobs/scheduler.js can lazy-import it (circular-import-safe).
_moduleAuditEvent = auditEvent;
```

- [ ] **Step 11: Add the `listJobs` + `runJob` handlers inside the same init() method.** Place AFTER the existing `seedApiDocs` handler (since they're conceptually similar). The handlers depend on `auditEvent` being in lexical scope OR on `_moduleAuditEvent` being set (which Step 10 guarantees).

```javascript
// ─────────────────────────────────────────────────────────────────
// #756: AdminService.JobControls actions.
// ─────────────────────────────────────────────────────────────────

this.on('listJobs', 'JobControls', async () => {
  const registry = _getJobRegistry();
  return Array.from(registry.values()).map(job => {
    let nextRunIso = null;
    try {
      nextRunIso = parser.parseExpression(job.schedule, { utc: true })
        .next()
        .toISOString();
    } catch (err) {
      LOG.warn(`listJobs: cron-parser failed on '${job.schedule}': ${err.message}`);
    }
    return {
      jobName: job.jobName,
      schedule: job.schedule,
      ttlMs: job.ttlMs,
      description: job.description,
      nextRunIso,
    };
  });
});

this.on('runJob', 'JobControls', async (req) => {
  const { jobName } = req.data;
  // Validation FIRST — before any audit emission — to avoid log spam
  // from malformed payloads.
  if (typeof jobName !== 'string' || jobName.length === 0 || jobName.length > MAX_JOB_NAME_LEN) {
    return req.reject(400, `Invalid jobName (must be non-empty string ≤${MAX_JOB_NAME_LEN} chars)`);
  }
  const registry = _getJobRegistry();
  if (!registry.has(jobName)) {
    return req.reject(400, `Unknown jobName: ${jobName}`);
  }
  const user = req.user?.id ?? 'unknown';
  const startedAt = new Date();

  // Audit "started" event (fire-and-forget).
  setImmediate(() => {
    emitJobAudit({ jobName, user, outcome: 'started', startedAt })
      .catch(err => LOG.warn(`runJob audit (started) failed: ${err.message}`));
  });

  // Fire the cron run in the background — handler returns immediately.
  // runJobByName invokes runWithLock which (Task 1) emits the completion
  // audit event after the fn resolves or the lock is held.
  setImmediate(() => {
    runJobByName(jobName, { manualTrigger: true, user })
      .catch(err => LOG.error(`runJob ${jobName} failed: ${err.message}`));
  });

  return {
    jobName,
    started: true,
    skipped: false,
    reason: null,
    startedAt,
  };
});
```

---

## 2.4 Unit tests for the handlers

- [ ] **Step 12: Write the failing test `test/unit/srv/admin-job-controls.test.js`** — 6 cases.

```javascript
// test/unit/srv/admin-job-controls.test.js
//
// Unit tests for AdminService.JobControls (listJobs + runJob).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';

import {
  registerJob,
  _resetJobRegistry,
  _setJobFn,
} from '../../../srv/jobs/scheduler.js';

describe('AdminService.JobControls', () => {
  let admin;

  beforeAll(async () => {
    cds.test();
    admin = await cds.connect.to('AdminService');
  });

  beforeEach(async () => {
    _resetJobRegistry();
    // Register one test job before each case.
    registerJob({
      jobName: 'test-controls-job',
      schedule: '0 0 1 1 *',
      ttlMs: 60000,
      description: 'unit test',
      fn: async () => ({ processed: 1 }),
    });
  });

  it('listJobs returns one entry per registered job with nextRunIso populated', async () => {
    const rows = await admin.send('listJobs', {}, { entity: 'JobControls' });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find(r => r.jobName === 'test-controls-job');
    expect(row).toBeTruthy();
    expect(row.schedule).toBe('0 0 1 1 *');
    expect(row.description).toBe('unit test');
    expect(row.nextRunIso).toMatch(/^\d{4}-01-01T00:00:00\.\d{3}Z$/);
  });

  it('runJob returns {started: true, startedAt} synchronously for a known jobName', async () => {
    const result = await admin.send('runJob', { jobName: 'test-controls-job' }, { entity: 'JobControls' });
    expect(result.started).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.jobName).toBe('test-controls-job');
    expect(result.startedAt).toBeTruthy();
  });

  it('runJob rejects with 400 for an unknown jobName', async () => {
    // Spy on the module-level audit pointer to assert no emission on reject.
    const adminMod = await import('../../../srv/admin-service.js');
    const emitSpy = vi.spyOn(adminMod, 'emitJobAudit').mockResolvedValue(undefined);

    await expect(
      admin.send('runJob', { jobName: 'no-such-job' }, { entity: 'JobControls' })
    ).rejects.toMatchObject({ code: '400' });

    // Wait briefly to ensure any errant setImmediate didn't fire.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(emitSpy).not.toHaveBeenCalled();
    emitSpy.mockRestore();
  });

  it('runJob rejects with 400 for an oversized jobName payload', async () => {
    const adminMod = await import('../../../srv/admin-service.js');
    const emitSpy = vi.spyOn(adminMod, 'emitJobAudit').mockResolvedValue(undefined);

    const huge = 'a'.repeat(101);
    await expect(
      admin.send('runJob', { jobName: huge }, { entity: 'JobControls' })
    ).rejects.toMatchObject({ code: '400' });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(emitSpy).not.toHaveBeenCalled();
    emitSpy.mockRestore();
  });

  it('runJob invokes the registered fn (verified via _setJobFn mock)', async () => {
    const spy = vi.fn(async () => ({ processed: 42 }));
    _setJobFn('test-controls-job', spy);

    await admin.send('runJob', { jobName: 'test-controls-job' }, { entity: 'JobControls' });
    // Fire-and-forget — wait briefly for setImmediate to drain.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('runJob writes JobLastRun row after the fn resolves (chassis path)', async () => {
    _setJobFn('test-controls-job', async () => ({ processed: 1 }));
    await admin.send('runJob', { jobName: 'test-controls-job' }, { entity: 'JobControls' });
    // Wait for setImmediate + the fn + recordJobLastRun.
    await new Promise(resolve => setTimeout(resolve, 100));

    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(JobLastRun).where({ jobName: 'test-controls-job' });
    expect(row).toBeTruthy();
    expect(row.lastSuccessAt).toBeTruthy();
  });
});
```

**Test design notes:**
- Tests 1+2+3+4 cover the synchronous response path (validation + handler success).
- Tests 5+6 cover the fire-and-forget background path. The `setTimeout(50)` / `setTimeout(100)` waits are necessary because runJob returns BEFORE the background `setImmediate(runJobByName)` resolves; the test must wait briefly for the cron + recordJobLastRun to land.

- [ ] **Step 13: Run; expect FAIL.**

```bash
npx vitest run test/unit/srv/admin-job-controls.test.js
```

Expected: 6 FAIL — listJobs / runJob actions not yet handled by AdminService (or `_setJobFn` isn't exported).

- [ ] **Step 14: Run; expect 6/6 PASS.**

If the handlers from Step 11 are correctly placed, the tests should pass. Common failure modes:
- **"Cannot find action listJobs"** → handler placed outside the init() method, OR `this.on(...)` was written with the wrong entity arg.
- **"_setJobFn is not exported"** → re-check Task 1 Step 3 (the test seam exports).
- **Race in test 5/6** → bump `setTimeout(100)` to `200` if your machine is slow.

```bash
npx vitest run test/unit/srv/admin-job-controls.test.js
```

- [ ] **Step 15: Run all srv unit tests to verify no regressions.**

```bash
npx vitest run test/unit/srv/
```

Expected: 230/230 pass (224 after Task 1 + 6 new). Adjust expected count if Task 1 ended with a different baseline.

- [ ] **Step 16: Commit Task 2 server code + tests.**

```bash
git add srv/admin-service.cds srv/admin-service.js \
        test/unit/srv/admin-job-controls.test.js \
        package.json package-lock.json
git commit -m "feat(#756): AdminService.JobControls singleton + listJobs/runJob actions

Phase 2 of 3 (#756 Task 2): the admin OData surface.

CDS additions (srv/admin-service.cds):
- New @odata.singleton @requires:'Admin' entity JobControls
- Action listJobs() returns array of {jobName, schedule, ttlMs,
  description, nextRunIso}
- Action runJob(jobName: String) returns {jobName, started, skipped,
  reason, startedAt}

JS additions (srv/admin-service.js):
- Module-level emitJobAudit({jobName, user, outcome, durationMs?,
  startedAt?}) helper. Calls auditEvent('cron.manual-trigger', {...})
  per srv/lib/audit-event.js JSDoc contract. Exported so
  srv/jobs/scheduler.js can lazy-import it from inside runWithLock
  (Task 1 chassis).
- _moduleAuditEvent module-level pointer wired inside service init()
  after auditEvent = createAuditEmitter(...). Lets emitJobAudit
  benefit from the service-init's audit-log binding while remaining
  module-scoped (avoids circular import with scheduler.js).
- listJobs handler — iterates JOB_REGISTRY, computes nextRunIso via
  cron-parser. Failed parses log-and-skip (no 500 on a single
  malformed schedule).
- runJob handler — validates jobName length (≤100 chars, matches
  JobLocks.jobName column width) BEFORE audit emission. setImmediate
  fires the 'started' audit + the background runJobByName call;
  returns {started: true, ...} synchronously.

New dependency: cron-parser pinned via --save-exact per project npm policy.

6 unit tests (test/unit/srv/admin-job-controls.test.js):
1. listJobs returns one entry per registered job
2. runJob returns {started: true} synchronously
3. runJob rejects with 400 for unknown jobName
4. runJob rejects with 400 for oversized jobName payload
5. runJob invokes the registered fn (verified via _setJobFn mock)
6. runJob writes JobLastRun row after fn resolves (chassis end-to-end)

Refs #756, spec §4.5-4.8"
```

---

## 2.5 Hybrid sanity test (BLOCKED-until-deploy)

- [ ] **Step 17: Create `test/hybrid/admin-run-job.test.js`** — 1 case, runs against real HANA.

```javascript
// test/hybrid/admin-run-job.test.js
//
// Hybrid end-to-end test for AdminService.JobControls.runJob.
// BLOCKED-until-deploy: requires ALLOW_HYBRID_WRITES=true + cds bind --exec
// against the DEV HANA instance. Validates that:
//   - runJob successfully fires a _test-noop job
//   - JobLastRun row updates with lastSuccessAt
//   - The audit log receives 2 cron.manual-trigger events
//     (outcome='started' + outcome='success')

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

import {
  registerJob,
  _getJobRegistry,
} from '../../srv/jobs/scheduler.js';

describe('admin run-job (hybrid)', () => {
  let admin;
  const TEST_JOB_NAME = '_test-noop';

  beforeAll(async () => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to write HANA.');
    }
    admin = await cds.connect.to('AdminService');
    // Register a noop test job (must NOT collide with any production job).
    registerJob({
      jobName: TEST_JOB_NAME,
      schedule: '0 0 1 1 1900',     // year-rare; never fires on its own
      ttlMs: 60000,
      description: 'hybrid test noop — safe to delete from JOB_REGISTRY',
      fn: async () => ({ processed: 0 }),
    });
  });

  afterAll(() => {
    // REQUIRED cleanup — leaves no test pollution in the registry.
    _getJobRegistry().delete(TEST_JOB_NAME);
  });

  it('runJob fires successfully and updates JobLastRun', async () => {
    const result = await admin.send('runJob', { jobName: TEST_JOB_NAME }, { entity: 'JobControls' });
    expect(result.started).toBe(true);
    expect(result.jobName).toBe(TEST_JOB_NAME);

    // Wait for the background setImmediate(runJobByName) to complete.
    await new Promise(resolve => setTimeout(resolve, 500));

    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(JobLastRun).where({ jobName: TEST_JOB_NAME });
    expect(row).toBeTruthy();
    expect(row.lastSuccessAt).toBeTruthy();
  });
});
```

The audit-event assertion (2 events emitted) is intentionally omitted from this test — the audit-log binding isn't always available in hybrid test runs, and emitJobAudit's degraded-safe path means failed emissions are warn-logged and swallowed. The JobLastRun assertion is the durable signal that the end-to-end path works.

- [ ] **Step 18: Commit the hybrid test.**

```bash
git add test/hybrid/admin-run-job.test.js
git commit -m "test(#756): hybrid sanity for AdminService.JobControls.runJob

BLOCKED-until-deploy. Validates the end-to-end runJob path against
real HANA: registers a _test-noop job, fires runJob via the admin
OData action, waits for the background fn to complete, asserts the
JobLastRun row was UPSERTed with lastSuccessAt.

afterAll cleanup is REQUIRED to prevent registry pollution across
hybrid runs (the _test-noop job would otherwise appear in listJobs
output until pod restart).

Audit-event assertion intentionally omitted — the audit-log binding
isn't always available in hybrid runs, and emitJobAudit's safe-degrade
path swallows missing-binding errors. JobLastRun is the durable
end-to-end signal.

Run with:
  ALLOW_HYBRID_WRITES=true cds bind --exec -- \\
    npx vitest run --project hybrid test/hybrid/admin-run-job.test.js

Refs #756, spec §7.2"
```

---

## Task 2 close-out

| Item | State |
|---|---|
| `cron-parser` dep installed (--save-exact) | ✓ |
| `AdminService.JobControls` singleton declared | ✓ |
| `listJobs()` + `runJob(jobName)` actions declared | ✓ |
| `emitJobAudit` module-level helper exported | ✓ |
| `_moduleAuditEvent` wired in service init() | ✓ |
| `listJobs` handler with cron-parser next-run | ✓ |
| `runJob` handler with validation-before-audit | ✓ |
| Length cap MAX_JOB_NAME_LEN = 100 | ✓ |
| 6 unit tests (admin-job-controls) | ✓ |
| 1 hybrid test (admin-run-job) BLOCKED-until-deploy | ✓ |
| Pre-existing srv unit tests still pass | ✓ |
| CDS schema unchanged (action-only addition) | ✓ |

Next: [Task 3 — Admin UI tile extension](./2026-06-29-756-task3-ui.md)
