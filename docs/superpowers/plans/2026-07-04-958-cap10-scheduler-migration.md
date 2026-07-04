# CAP 10 Scheduling API Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `node-cron`-driven engine inside `srv/jobs/scheduler.js` with CAP 10's native Scheduling API (`srv.schedule('event').every(cron).as(singleton)`), while preserving every observable behavior of the current chassis.

**Architecture:** Introduce an internal `CronService` (defined in `srv/cron-service.cds`, no `@path`, no protocol annotation, no `@requires` — never exposed on any adapter) as the sole scheduling bus. It owns the scheduler lifecycle: `init()` calls `registerJobs()` + `preSeedJobLastRun()`, then wires one `srv.on('cron.<jobName>', ...)` handler + one `srv.schedule('cron.<jobName>').every(expr).as(jobName)` call per registered job. The `JOB_REGISTRY` map, `runWithLock` chassis, `PipelineLog` + `JobLastRun` + `SecurityEvent` audit wiring, and all 32 `registerJob({...})` call sites are unchanged. CAP 10's status-column singleton locking (via `.as(name)`) replaces the DB-backed `JobLocks` scheduler helper (`srv/jobs/job-lock.js` is deleted; the `JobLocks` entity survives for one unrelated boot-sentinel caller in `srv/lib/purge-stale-changelog.js`).

**Tech Stack:** CAP 10 (`@sap/cds@^10.0.3`), Node.js 22+, SQLite (unit tests via `cds.deploy(...).to('sqlite::memory:')`), SAP HANA Cloud (hybrid + prod), Vitest 4.

## Global Constraints

- Node.js minimum 22 (recommend 24 LTS) per the project baseline.
- `@sap/cds`: `^10.0.3` (locked by `package.json`).
- `cron-parser`: `5.6.1` STAYS in `dependencies` — powers `srv/lib/cron-firings.js` for the admin `nextRunIso` tile. Do NOT remove it.
- The design spec `docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md` is the source of truth for component signatures, file paths, and testing changes — refer back to it if any step is ambiguous.
- Zero regression on `test/hybrid/admin-run-job.test.js`.
- Zero call-site churn in the 32 `registerJob({...})` blocks inside `registerJobs()` in `srv/jobs/scheduler.js`.
- The `JobLocks` entity in `db/schema.cds` (lines 438–443) MUST NOT be removed by this PR — it's retained for the `autoPurgeOnce` boot sentinel in `srv/lib/purge-stale-changelog.js`. Retiring the entity is a follow-up ticket.
- CronService must never be exposed on any protocol. It has no `@path`, no `@requires`, no `@odata`/`@rest`/`@hcql` annotations. (Node.js runtime, so the CAP 10 Java protocol-default change does not affect us; but the "no protocol annotation" constraint remains, for clarity.)
- All 4 admin actions (`seedSamples`, `seedHelpDocs`, `seedCommunityEvents`, `JobControls.runJob`) that call `runJobByName(name, {manualTrigger, user, sinceIsoOverride?, budgetOverride?})` MUST continue to work — the manual path bypasses the outbox entirely (`setImmediate(runJobByName(...))`), so these are untouched by this migration.
- Manual triggers colliding with an in-flight scheduled run of the same job now both run to completion (deliberate behavior change — see spec "Locking model" section).
- Preserve today's swallow-and-log-error posture inside `runWithLock`. Do NOT delegate retries to the CAP outbox.

## File Map

**Files created:**
- `srv/cron-service.cds` — internal service definition (`service CronService {}`, no annotations)
- `srv/cron-service.js` — `CronService` impl class extending `cds.ApplicationService`; owns scheduler lifecycle
- `test/unit/srv/cron-service.test.js` — unit tests for CronService wiring (registry population + handler dispatch + idempotency)
- `test/hybrid/cron-service-schedule.test.js` — hybrid test asserting `cds.outbox.Messages` contains one pending row per registered job after boot

**Files modified:**
- `srv/jobs/scheduler.js` — delete node-cron import + `cron.schedule` call in `registerJob`; delete `acquireLock`/`releaseLock` in `runWithLock` (Commit 3); delete the `lockheld` audit-emission branch (Commit 3); update header docstring (Commit 4)
- `srv/server.js` — delete the `if (process.env.NODE_ENV !== 'test') { registerJobs(); }` block (Commit 2)
- `srv/lib/purge-stale-changelog.js` — inline private sentinel helper replacing `import { acquireLock } from '../jobs/job-lock.js'` (Commit 3)
- `test/unit/srv/run-with-lock.test.js` — remove the `lock-held` test case (Commit 3)
- `test/hybrid/admin-run-job.test.js` — no behavioral changes expected (the test does not assert on lock-held); read carefully during Commit 3 to confirm
- `package.json` — remove `"node-cron"` from `dependencies` (Commit 4); leave `cron-parser` alone
- `CLAUDE.md` — add one-line note pointing to CronService under `## Architecture` → "Jobs in `srv/jobs/`" (Commit 4)
- `docs/developers/reference/tutorials-ims-gotchas.md` — search for `node-cron`; replace/annotate if found (Commit 4)
- `docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md` — Chassis section note pointing to this spec, note that `JobLocks` scheduler usage retired (Commit 4)

**Files deleted:**
- `srv/jobs/job-lock.js` (Commit 3)

**Files intentionally untouched:**
- `srv/admin-service.js` — all 4 admin actions calling `runJobByName` work unchanged
- `srv/lib/cron-firings.js` — `cron-parser` continues to power the admin `nextRunIso` tile
- `db/schema.cds` — `JobLocks` entity stays for `autoPurgeOnce` boot sentinel
- `db/last-dev/*` — no schema change, no regeneration needed
- All 32 job modules under `srv/jobs/*-job.js`
- All admin UI code (`app/admin/*`, `app/admin-shell/*`, `app/analytics-explorer/*`, `app/scanner/*`)
- `srv/lib/pipeline-log.js`

## Commit sequence

The plan is organized into **four staged commits** on a single feature branch (`worktree-958-cap10-scheduler-migration`, already created). Each commit ends with a green test suite run. Commit 1 is deployable independently for DEV soak; Commits 2–4 land as one squashed PR after Commit 1's soak completes.

- **Commit 1 (Tasks 1–4):** Add CronService; run both engines in parallel (feature-flagged)
- **Commit 2 (Tasks 5–6):** Cut over — delete `node-cron` engine from `registerJob`, remove `registerJobs()` boot call from `srv/server.js`
- **Commit 3 (Tasks 7–10):** Drop `JobLocks` scheduler usage (inline boot-sentinel helper, delete `srv/jobs/job-lock.js`, strip lock-acquire from `runWithLock`)
- **Commit 4 (Tasks 11–13):** Cleanup — drop `node-cron` dependency, remove feature flag, docs

---

## Task 1: Add the CronService CDS definition

**Files:**
- Create: `srv/cron-service.cds`

**Interfaces:**
- Consumes: (nothing)
- Produces: A CDS service `com.sap.developers.ims.CronService` (via file namespace) — later tasks import handlers on it via `cds.ApplicationService`.

- [ ] **Step 1: Create the CDS file**

Create `srv/cron-service.cds` with exact contents:

```cds
namespace com.sap.developers.ims;

// Internal scheduling bus. NOT exposed on any protocol — no @path, no
// @requires, no @odata/@rest annotations. Only used as a target for
// srv.schedule(...).every(...).as(...) calls originating from
// srv/jobs/scheduler.js. All 32 registered jobs land here as
// events named 'cron.<jobName>'.
//
// Migration spec: docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md
service CronService {}
```

- [ ] **Step 2: Verify CDS compiles**

Run: `npx cds compile srv/ 2>&1 | head -20`
Expected: No errors. Warning about empty service body is acceptable (the service is empty by design).

- [ ] **Step 3: Verify CronService is NOT exposed on any protocol**

Run: `npx cds compile srv/ --to json 2>/dev/null | jq '.definitions | to_entries | map(select(.key | test("CronService$"))) | .[].value | {kind, "@path", "@protocol"}'`
Expected: `{ "kind": "service" }` with no `@path` and no `@protocol` keys.

- [ ] **Step 4: Commit is deferred**

Do not commit yet. Task 4 combines the whole CronService add.

---

## Task 2: Add the CronService impl class (feature-flagged)

**Files:**
- Create: `srv/cron-service.js`

**Interfaces:**
- Consumes: `_getJobRegistry`, `registerJobs`, `preSeedJobLastRun`, `runJobByName` — all currently exported from `srv/jobs/scheduler.js`.
- Produces: `default export class CronService extends cds.ApplicationService` with an async `init()` that wires handlers and calls `.schedule(...).every(...).as(...)` per registered job. Behavior is gated on `process.env.CAP_SCHEDULING_ENABLED !== 'false'` (default ON).

- [ ] **Step 1: Create the impl file**

Create `srv/cron-service.js` with exact contents:

```js
// srv/cron-service.js
//
// Internal scheduling bus. Owns the scheduler lifecycle:
//   1. registerJobs()          — populates JOB_REGISTRY (32 entries)
//   2. preSeedJobLastRun()     — one JobLastRun row per job
//   3. For each job in the registry:
//      - this.on('cron.<jobName>', () => runJobByName(jobName))
//      - this.schedule('cron.<jobName>', {}).every(job.schedule).as(job.jobName)
//
// Feature flag: CAP_SCHEDULING_ENABLED (default 'true'). Set to 'false'
// during Commit 1's DEV soak if node-cron behavior needs to be exclusive.
// Removed cleanly in Commit 4.
//
// Migration spec: docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md
// Issue: #958

import cds from '@sap/cds';
import {
  _getJobRegistry,
  registerJobs,
  preSeedJobLastRun,
  runJobByName,
} from './jobs/scheduler.js';

const LOG = cds.log('cron-service');

export default class CronService extends cds.ApplicationService {
  async init() {
    // Owned entirely by CronService now — the previous 'served' hook in
    // srv/server.js that called registerJobs() is removed in Commit 2.
    // During Commit 1's dual-engine window, registerJobs() is called by
    // BOTH srv/server.js and CronService.init(). The registry throws on
    // duplicate jobName registration, so we skip if already populated.
    if (_getJobRegistry().size === 0) {
      registerJobs();
    } else {
      LOG.info(`JOB_REGISTRY already populated (${_getJobRegistry().size} entries); skipping registerJobs()`);
    }

    await preSeedJobLastRun();

    if (process.env.CAP_SCHEDULING_ENABLED === 'false') {
      LOG.warn('CAP_SCHEDULING_ENABLED=false — skipping srv.schedule() wiring; node-cron remains sole engine');
      await super.init();
      return;
    }

    // Wire one handler + one schedule() call per registered job.
    for (const job of _getJobRegistry().values()) {
      const eventName = `cron.${job.jobName}`;
      this.on(eventName, () => runJobByName(job.jobName));
      await this.schedule(eventName, {})
        .every(job.schedule)
        .as(job.jobName);
    }
    LOG.info(`CronService wired ${_getJobRegistry().size} scheduled jobs via CAP scheduling API`);

    await super.init();
  }
}
```

- [ ] **Step 2: Verify the file loads without syntax errors**

Run: `node --check srv/cron-service.js`
Expected: No output (silent success).

- [ ] **Step 3: Verify the imports resolve**

Run: `node -e "import('./srv/cron-service.js').then(m => console.log(typeof m.default))"`
Expected: `function`

Do not commit yet; Task 4 covers the combined commit.

---

## Task 3: Write the CronService unit test

**Files:**
- Create: `test/unit/srv/cron-service.test.js`

**Interfaces:**
- Consumes: `CronService` from `srv/cron-service.js`; `registerJob`, `_resetJobRegistry`, `_setJobFn`, `_getJobRegistry` from `srv/jobs/scheduler.js`.
- Produces: Vitest suite `CronService init()`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/srv/cron-service.test.js` with exact contents:

```js
// test/unit/srv/cron-service.test.js
//
// Unit test for the CronService wiring: verifies that init() populates
// JOB_REGISTRY (via registerJobs), attaches one handler + one schedule()
// call per registered job, and that emitting 'cron.<name>' dispatches
// to runJobByName(name).
//
// Mocking approach: vitest spies on the CronService instance's .on and
// .schedule methods. We do NOT boot the CAP outbox — this test verifies
// the CALL SHAPE, not persistent delivery.
//
// Migration spec: docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md
// Issue: #958

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';

import {
  _getJobRegistry,
  _resetJobRegistry,
  _setJobFn,
} from '../../../srv/jobs/scheduler.js';

describe('CronService.init()', () => {
  let CronService;

  beforeEach(async () => {
    _resetJobRegistry();
    // Fresh dynamic import each test so the class doesn't retain state.
    ({ default: CronService } = await import('../../../srv/cron-service.js?t=' + Date.now()));
    // Boot CAP in-memory so preSeedJobLastRun's cds.entities() call works.
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
  });

  afterEach(async () => {
    await cds.disconnect();
    _resetJobRegistry();
    delete process.env.CAP_SCHEDULING_ENABLED;
  });

  it('populates JOB_REGISTRY via registerJobs() and attaches one handler + one schedule() per job', async () => {
    const svc = new CronService();

    // Stub .on and .schedule with vitest spies. .schedule returns a chainable
    // fluent object matching the CAP 10 API shape.
    const scheduleFluent = {
      every: vi.fn().mockReturnThis(),
      as: vi.fn().mockResolvedValue(undefined),
    };
    svc.on = vi.fn();
    svc.schedule = vi.fn().mockReturnValue(scheduleFluent);

    await svc.init();

    const registrySize = _getJobRegistry().size;
    expect(registrySize).toBeGreaterThan(30);   // 32 today; guards against accidental loss
    expect(svc.on).toHaveBeenCalledTimes(registrySize);
    expect(svc.schedule).toHaveBeenCalledTimes(registrySize);

    // Every handler is bound on an event name of the form 'cron.<jobName>'.
    for (const call of svc.on.mock.calls) {
      expect(call[0]).toMatch(/^cron\..+/);
      expect(typeof call[1]).toBe('function');
    }
    // Every schedule call uses .every(<cron>).as(<jobName>).
    expect(scheduleFluent.every).toHaveBeenCalledTimes(registrySize);
    expect(scheduleFluent.as).toHaveBeenCalledTimes(registrySize);
  });

  it('handler dispatch: emitting cron.<name> invokes runJobByName(name)', async () => {
    const svc = new CronService();

    // Capture the handler registered for a specific job.
    let capturedHandler = null;
    svc.on = vi.fn((event, handler) => {
      if (event === 'cron.metrics-rollup') capturedHandler = handler;
    });
    svc.schedule = vi.fn().mockReturnValue({
      every: vi.fn().mockReturnThis(),
      as: vi.fn().mockResolvedValue(undefined),
    });
    await svc.init();

    // Replace the job fn to observe dispatch.
    let called = 0;
    _setJobFn('metrics-rollup', async () => { called++; return { ok: true }; });

    expect(capturedHandler).toBeTruthy();
    await capturedHandler();
    expect(called).toBe(1);
  });

  it('CAP_SCHEDULING_ENABLED=false: still populates registry, but does NOT wire handlers or schedule calls', async () => {
    process.env.CAP_SCHEDULING_ENABLED = 'false';
    const svc = new CronService();
    svc.on = vi.fn();
    svc.schedule = vi.fn();

    await svc.init();

    expect(_getJobRegistry().size).toBeGreaterThan(30);
    expect(svc.on).not.toHaveBeenCalled();
    expect(svc.schedule).not.toHaveBeenCalled();
  });

  it('rerun of init() does not re-run registerJobs() (guards against duplicate-jobName throw)', async () => {
    const svc1 = new CronService();
    svc1.on = vi.fn();
    svc1.schedule = vi.fn().mockReturnValue({
      every: vi.fn().mockReturnThis(),
      as: vi.fn().mockResolvedValue(undefined),
    });
    await svc1.init();

    const svc2 = new CronService();
    svc2.on = vi.fn();
    svc2.schedule = vi.fn().mockReturnValue({
      every: vi.fn().mockReturnThis(),
      as: vi.fn().mockResolvedValue(undefined),
    });
    // Should NOT throw despite the registry already being populated.
    await expect(svc2.init()).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test — expected to fail because Task 1/2 files aren't committed yet**

Run: `npx vitest run test/unit/srv/cron-service.test.js`

Expected: 4 tests, some may pass, some may error on missing imports. If ALL pass, great — Tasks 1/2 are already correctly wired.

If any test fails with "Cannot find module '../../../srv/cron-service.js'" or similar: re-check Task 2. If any test fails with "svc.schedule is not a function" being called with the wrong arity: re-check the impl in Task 2.

- [ ] **Step 3: Fix any failures found in Step 2 by iterating on Tasks 1/2**

Iterate until all 4 tests pass. This is the TDD gate for the CronService component.

- [ ] **Step 4: Confirm the full unit suite still passes**

Run: `npm test`
Expected: all pre-existing suites pass; the 4 new cron-service tests pass.

Do not commit yet; Task 4 finalizes the combined commit.

---

## Task 4: Feature-flag scaffolding + Commit 1

**Files:**
- Modify: `deploy/dev.mtaext` (add `CAP_SCHEDULING_ENABLED: "true"` under the `srv` module env)

**Interfaces:**
- Consumes: nothing
- Produces: The `CAP_SCHEDULING_ENABLED` env var is set explicitly in `deploy/dev.mtaext` so an operator can flip it to `"false"` for a full rollback WITHOUT a code redeploy. Default (when unset) is `"true"` — matches the impl in Task 2.

- [ ] **Step 1: Locate the srv module env block in deploy/dev.mtaext**

Run: `grep -n "^- name: srv$\|^  properties:$" deploy/dev.mtaext | head -6`
Expected: shows the `srv` module block and its `properties:` line — note the line numbers.

- [ ] **Step 2: Add the env var**

Under the `srv` module's `properties:` block in `deploy/dev.mtaext`, add:

```yaml
    CAP_SCHEDULING_ENABLED: "true"
```

If the module uses `parameters:` for env vars instead of `properties:`, use whichever convention is already established for other env vars on `srv`.

- [ ] **Step 3: Verify the YAML is valid**

Run: `yq '.modules[] | select(.name == "srv") | .properties.CAP_SCHEDULING_ENABLED // .parameters.CAP_SCHEDULING_ENABLED' deploy/dev.mtaext`
Expected: `"true"`

- [ ] **Step 4: Run the full unit suite once more**

Run: `npm test`
Expected: all suites pass, including the 4 new CronService tests.

- [ ] **Step 5: Commit — end of Commit 1**

```bash
git add srv/cron-service.cds srv/cron-service.js test/unit/srv/cron-service.test.js deploy/dev.mtaext
git commit -m "feat(#958): add CronService as CAP 10 scheduling bus (dual-engine)

Introduces srv/cron-service.{cds,js} as an internal (no @path, no
protocol annotation) service that owns the scheduler lifecycle:
registerJobs() -> preSeedJobLastRun() -> srv.on + srv.schedule per
registered job. During this commit both engines fire — the existing
node-cron path in srv/jobs/scheduler.js:registerJob remains, and CAP
scheduling is layered on top. runWithLock's JobLocks acquire prevents
double-execution.

Feature-flagged via CAP_SCHEDULING_ENABLED (default 'true'; set in
deploy/dev.mtaext). Setting the env var to 'false' skips the srv.schedule
wiring so node-cron remains sole engine — a code-free rollback path
during Commit 1's DEV soak.

Refs #958"
```

---

## Task 5: Cut over — delete node-cron from `registerJob`

**Files:**
- Modify: `srv/jobs/scheduler.js`

**Interfaces:**
- Consumes: nothing new
- Produces: `registerJob` is registry-only — the `cron.schedule()` call is removed. The public shape of `registerJob({jobName, schedule, ttlMs, description, fn})` is unchanged.

- [ ] **Step 1: Remove the node-cron import**

In `srv/jobs/scheduler.js` line 28, delete:

```js
import cron from 'node-cron';
```

- [ ] **Step 2: Remove the cron.schedule call inside registerJob**

In `srv/jobs/scheduler.js` around line 73-80, the current implementation is:

```js
export function registerJob({ jobName, schedule, ttlMs, description, fn }) {
  if (JOB_REGISTRY.has(jobName)) {
    throw new Error(`Duplicate jobName: ${jobName}`);
  }
  JOB_REGISTRY.set(jobName, { jobName, schedule, ttlMs, description, fn });
  // Schedule the cron alongside registration.
  cron.schedule(schedule, () => runJobByName(jobName));
}
```

Change it to:

```js
export function registerJob({ jobName, schedule, ttlMs, description, fn }) {
  if (JOB_REGISTRY.has(jobName)) {
    throw new Error(`Duplicate jobName: ${jobName}`);
  }
  JOB_REGISTRY.set(jobName, { jobName, schedule, ttlMs, description, fn });
  // #958: cron.schedule() removed; CronService owns scheduling via
  // srv.schedule('cron.<name>', {}).every(schedule).as(jobName).
}
```

- [ ] **Step 3: Update the file-header docstring**

The top of `srv/jobs/scheduler.js` (lines 1-27) describes the two invocation paths. Update the numbered list to reflect the new engine:

Replace lines 6-11:
```js
// The scheduler has two invocation paths and JOB_REGISTRY is the single
// source of truth for both:
//   1. node-cron ticks — `cron.schedule(expr, () => runJobByName(name))`,
//      wired up inside registerJob() at registration time.
//   2. Admin manual triggers — `AdminService.JobControls.runJob(jobName)`
//      dispatches to `runJobByName(name, {manualTrigger, user})` (#756).
```

With:
```js
// The scheduler has two invocation paths and JOB_REGISTRY is the single
// source of truth for both:
//   1. CAP scheduled ticks — srv/cron-service.js reads JOB_REGISTRY at
//      init() and calls `this.schedule('cron.<name>', {}).every(expr)
//      .as(jobName)`. Its `on('cron.<name>')` handler invokes
//      `runJobByName(name)`. Per-instance status-column singleton
//      locking replaces the previous node-cron + JobLocks scheme (#958).
//   2. Admin manual triggers — `AdminService.JobControls.runJob(jobName)`
//      dispatches to `runJobByName(name, {manualTrigger, user})` (#756).
```

- [ ] **Step 4: Verify the file loads**

Run: `node --check srv/jobs/scheduler.js`
Expected: no output (success).

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: all tests pass. The `run-with-lock.test.js` `lock-held` test still passes at this point because JobLocks is still wired.

- [ ] **Step 6: Do NOT commit yet — Task 6 finishes Commit 2**

---

## Task 6: Remove `registerJobs()` from srv/server.js + finalize Commit 2

**Files:**
- Modify: `srv/server.js` — remove the `if (process.env.NODE_ENV !== 'test') { registerJobs(); }` block at line 1013-1015

**Interfaces:**
- Consumes: `registerJobs` is now called by `CronService.init()` (added in Task 2). The `srv/server.js` call becomes redundant.
- Produces: `srv/server.js` no longer calls `registerJobs()`. CronService is the sole owner.

- [ ] **Step 1: Locate the block**

Run: `grep -n "registerJobs\|process.env.NODE_ENV" srv/server.js | head -10`
Expected: shows the block around line 1013-1015 plus the import at the top of the file.

- [ ] **Step 2: Remove the block**

Delete lines 1013-1015 of `srv/server.js`:

```js
  if (process.env.NODE_ENV !== 'test') {
    registerJobs();
  }
```

- [ ] **Step 3: Remove the import if `registerJobs` is no longer used anywhere else in `srv/server.js`**

Run: `grep -n "registerJobs" srv/server.js`
If the only remaining hit is the `import`, remove that import line too. If any other reference remains, keep the import.

- [ ] **Step 4: Verify the file parses**

Run: `node --check srv/server.js`
Expected: no output.

- [ ] **Step 5: Update the CronService init to reflect the new invariant**

In `srv/cron-service.js` (from Task 2), the `if (_getJobRegistry().size === 0) { registerJobs(); }` guard was defensive during dual-engine mode. It stays as a hardening measure — `srv/server.js` no longer double-calls, but the guard makes CronService robust to any future re-entry (e.g. test fixtures or a rolling restart in-process).

Update the comment above the guard in `srv/cron-service.js` from:

```js
    // Owned entirely by CronService now — the previous 'served' hook in
    // srv/server.js that called registerJobs() is removed in Commit 2.
    // During Commit 1's dual-engine window, registerJobs() is called by
    // BOTH srv/server.js and CronService.init(). The registry throws on
    // duplicate jobName registration, so we skip if already populated.
```

to:

```js
    // Owned entirely by CronService now — the srv/server.js call to
    // registerJobs() was removed in Commit 2 of this migration. The
    // size==0 guard remains as belt-and-suspenders against re-entry
    // (registerJob throws on duplicate jobName; the guard prevents that
    // from ever surfacing in test fixtures that reuse the module).
```

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Commit — end of Commit 2**

```bash
git add srv/jobs/scheduler.js srv/server.js srv/cron-service.js
git commit -m "feat(#958): cut over scheduling to CronService — remove node-cron engine

Deletes cron.schedule() from srv/jobs/scheduler.js:registerJob and
removes the registerJobs() call from srv/server.js's post-listen hook.
CronService is now the sole owner of scheduler lifecycle; scheduled
ticks reach jobs exclusively through srv.on('cron.<name>').

JobLocks acquire/release stays in runWithLock for one more commit as
belt-and-suspenders against manual-vs-scheduled races that this migration
deliberately loosens (see spec 'Locking model' section).

Refs #958"
```

---

## Task 7: Write the new inline sentinel helper in purge-stale-changelog.js

**Files:**
- Modify: `srv/lib/purge-stale-changelog.js`

**Interfaces:**
- Consumes: `cds.entities('com.sap.developers.ims').JobLocks` (the entity, not the deprecated helper).
- Produces: A new private function `acquireBootSentinel(sentinelName, instanceId, durationMs)` internal to this file that INSERTs into `JobLocks` (returns `true` on success, `false` if row already exists / not expired). Replaces the `import { acquireLock } from '../jobs/job-lock.js';` line.

- [ ] **Step 1: Read the current file for context**

Run: `cat srv/lib/purge-stale-changelog.js`

Confirm the current shape: `import { acquireLock } from '../jobs/job-lock.js';` at line 2, single caller `autoPurgeOnce` uses it once.

- [ ] **Step 2: Write the replacement file**

Rewrite `srv/lib/purge-stale-changelog.js` — replace the `acquireLock` import with an inline sentinel helper. Full new file contents:

```js
import cds from '@sap/cds';

const LOG = cds.log('purge-stale-changelog');

/**
 * Entities whose `@changelog` was removed in #658. The auto-purge helper
 * defaults to this list when called without an explicit `entities` argument.
 *
 * If a future PR drops @changelog from another entity, add it here AND bump
 * the sentinel version in srv/server.js so the auto-purge re-runs to clean
 * up the legacy rows.
 */
export const NOISE_ENTITIES = Object.freeze([
  'com.sap.developers.ims.ChatSettings',
  'com.sap.developers.ims.KnowledgeGraphSettings',
  'com.sap.developers.ims.UiEventsSettings',
  'com.sap.developers.ims.TenantSettings',
  'com.sap.developers.ims.DisplaySettings',
  'com.sap.developers.ims.SearchSettings',
  'com.sap.developers.ims.NavigatorSettings',
  'com.sap.developers.ims.Concepts',
  'com.sap.developers.ims.ConceptEdges',
]);

/**
 * Bulk-delete `sap.changelog.Changes` rows by `entity`. Returns the number of
 * rows removed. When `entities` is empty / nullish / not an array, the
 * NOISE_ENTITIES default list is used.
 *
 * @param {Object}   [opts]
 * @param {string[]} [opts.entities] Explicit entity allowlist.
 * @returns {Promise<{deleted: number}>}
 */
export async function purgeStaleChangelog({ entities } = {}) {
  const list =
    Array.isArray(entities) && entities.length > 0 ? entities : NOISE_ENTITIES;
  const Changes = cds.entities('sap.changelog').Changes;
  const deleted = await DELETE.from(Changes).where({ entity: { in: list } });
  LOG.info(`Deleted ${deleted} changelog rows across ${list.length} entities`);
  return { deleted };
}

/**
 * Inline boot-sentinel helper — replaces the deprecated
 * `import { acquireLock } from '../jobs/job-lock.js'` (#958 retired
 * job-lock.js when CAP 10 scheduling made it redundant for the
 * scheduler chassis).
 *
 * autoPurgeOnce uses this to run the changelog purge exactly once per CF
 * deploy across all instances. The sentinel row is INSERTed into the
 * JobLocks entity and NEVER released — the 10-minute expiry is a recovery
 * valve if a future NOISE_ENTITIES bump needs to re-sweep without a code
 * change.
 *
 * Returns true if we acquired (and can proceed with the purge), false if
 * another instance already holds the sentinel.
 */
async function acquireBootSentinel(sentinelName, instanceId, durationMs) {
  const { JobLocks } = cds.entities('com.sap.developers.ims');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMs);
  try {
    await INSERT.into(JobLocks).entries({
      jobName: sentinelName,
      lockedBy: instanceId,
      lockedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    return true;
  } catch (e) {
    // Row exists — try to claim if expired.
  }
  const result = await UPDATE(JobLocks)
    .where({ jobName: sentinelName, expiresAt: { '<': now.toISOString() } })
    .set({
      lockedBy: instanceId,
      lockedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  if (result === 0) return false;
  // Verify we actually hold the sentinel (guards against concurrent UPDATE race)
  const [row] = await SELECT.from(JobLocks).where({ jobName: sentinelName }).columns('lockedBy');
  return row?.lockedBy === instanceId;
}

/**
 * One-shot wrapper called from cds.on('served'). Uses the inline
 * acquireBootSentinel helper so exactly one CF instance runs the purge on
 * each deploy. The `version` string is part of the sentinel name; bump it
 * (`-v2`, `-v3`, …) when a future PR adds new entities to NOISE_ENTITIES
 * and the legacy rows need a fresh sweep.
 *
 * Returns `{ deleted, alreadyRan }`. `alreadyRan: true` means the sentinel
 * row was already present in `JobLocks` and this caller did not delete
 * anything.
 *
 * The sentinel is held for 10 minutes (deliberately generous — the actual
 * DELETE runs in seconds, but we never release the row so it acts as a
 * permanent sentinel). When the sentinel expires after 10 minutes,
 * `acquireBootSentinel` will let a future deploy take it over. That's
 * intentional — if NOISE_ENTITIES is bumped without changing the version
 * suffix, the next deploy MORE-THAN-10-minutes later will re-sweep, which
 * is a harmless idempotent DELETE.
 */
export async function autoPurgeOnce({ version = 'v1' } = {}) {
  const sentinelName = `changelog-noise-purge-${version}`;
  const instanceId = process.env.CF_INSTANCE_INDEX || '0';
  const TEN_MINUTES = 10 * 60 * 1000;

  const acquired = await acquireBootSentinel(sentinelName, instanceId, TEN_MINUTES);
  if (!acquired) {
    LOG.info(`Sentinel ${sentinelName} already held; skipping auto-purge`);
    return { deleted: 0, alreadyRan: true };
  }

  // Intentionally do NOT release the sentinel — the JobLocks row IS the sentinel.
  // The 10-minute expiry is the recovery valve in case a future entity-list
  // bump needs to re-sweep without writing a one-off migration.
  const result = await purgeStaleChangelog();
  return { ...result, alreadyRan: false };
}
```

- [ ] **Step 3: Verify the file parses**

Run: `node --check srv/lib/purge-stale-changelog.js`
Expected: no output.

- [ ] **Step 4: Run any existing tests for purge-stale-changelog**

Run: `find test srv/__tests__ -name "*purge*stale*" -o -name "*changelog*purge*" 2>/dev/null | xargs -r npx vitest run`

If tests exist, they must all pass. If none exist, that's fine — this refactor is behavior-preserving (the sentinel semantics against the same table are unchanged; only the import path moved).

- [ ] **Step 5: Do NOT commit yet — Task 10 finalizes Commit 3**

---

## Task 8: Strip lock acquire/release from `runWithLock` in scheduler.js

**Files:**
- Modify: `srv/jobs/scheduler.js` — `runWithLock` function and the `emitJobAuditSafely` `lockheld` branch

**Interfaces:**
- Consumes: nothing new — CAP 10's `.as(name)` singleton semantics replace the acquire/release protocol.
- Produces: `runWithLock` unconditionally invokes `fn(logId)` — the `if (!acquired) return { skipped: true, reason: 'lock-held' }` branch is gone; the `finally`'s `releaseLock` call is gone. The return shape stays `{ skipped, outcome, result, errorMessage }` — `skipped` becomes always `false`; `reason` is removed from the shape.

- [ ] **Step 1: Remove the JobLocks import**

In `srv/jobs/scheduler.js` line 29, delete:

```js
import { acquireLock, releaseLock } from './job-lock.js';
```

- [ ] **Step 2: Rewrite `runWithLock`**

Replace lines 136-177 (the current `runWithLock` body). The current signature is `async function runWithLock(jobName, durationMs, fn, opts = {})`. Keep the signature — `durationMs` becomes unused but stays for call-site stability; CAP handles duration internally now.

Replace with:

```js
async function runWithLock(jobName, durationMs, fn, opts = {}) {
  // #958: node-cron + JobLocks retired. CAP 10's .as(name) status-column
  // singleton semantics prevent concurrent scheduled ticks across CF
  // instances. Manual triggers (setImmediate path from admin actions)
  // bypass the outbox entirely — a manual-vs-scheduled collision runs
  // both to completion; last-write-wins on JobLastRun. Documented
  // behavior change from the pre-#958 lock-held short-circuit.
  //
  // durationMs is retained in the signature for call-site stability
  // (registerJob passes it through) but is unused inside this function.
  void durationMs;

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
```

Verify: the `if (!acquired)` block at the top is gone; the `releaseLock` call in `finally` is gone; the `emitJobAuditSafely({..., outcome: 'lockheld'})` call is gone; every other path (PipelineLog, JobLastRun, `manualTrigger` audit for success/error) is preserved verbatim.

- [ ] **Step 3: Update the docstring above runWithLock**

Replace lines 111-135 (the current docstring block) with:

```js
/**
 * Runs a cron job's fn (or a manual admin trigger) under the standard
 * chassis: PipelineLog start row, invoke fn(logId), PipelineLog end row
 * (SUCCESS or FAILED), then JobLastRun UPSERT in `finally`. On manual
 * triggers (opts.manualTrigger=true), emits a completion SecurityEvent
 * audit event from the `finally` block (spec §9).
 *
 * Return shape: {skipped: false, outcome: 'success'|'error', result,
 * errorMessage} — `skipped` is always false since #958 retired the
 * lock-held short-circuit; retained in the shape for backward-compat
 * with existing callers that destructure it.
 *
 * durationMs is unused (CAP owns duration semantics now) but retained
 * in the signature for registerJob call-site stability.
 *
 * Backward-compat: the pre-#756 3-arg signature works because opts
 * defaults to {}. `manualTrigger` and `user` opts are passed through
 * from AdminService.JobControls.runJob.
 *
 * Spec: docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md
 */
```

- [ ] **Step 4: Verify the file parses**

Run: `node --check srv/jobs/scheduler.js`
Expected: no output.

- [ ] **Step 5: Do NOT commit yet — Task 10 finalizes Commit 3**

---

## Task 9: Delete `srv/jobs/job-lock.js` and adjust the `run-with-lock.test.js` lock-held case

**Files:**
- Delete: `srv/jobs/job-lock.js`
- Modify: `test/unit/srv/run-with-lock.test.js` — remove the `lock-held` test case

**Interfaces:**
- Consumes: nothing
- Produces: the `job-lock.js` module is gone; the only remaining caller (`purge-stale-changelog.js`) uses its inline helper from Task 7.

- [ ] **Step 1: Confirm no remaining live imports of job-lock.js**

Run: `grep -rn "from.*['\"]\\.\\./jobs/job-lock\|from.*['\"]\\.\\./\\.\\./srv/jobs/job-lock\|from ['\"]\\.\\./job-lock" srv/ test/ scripts/ 2>/dev/null`
Expected: no output (or only comment mentions — never real `import` statements).

If any hits remain, they are unaccounted-for callers — stop and fix before deleting.

- [ ] **Step 2: Delete the file**

Run: `git rm srv/jobs/job-lock.js`
Expected: `rm 'srv/jobs/job-lock.js'`

- [ ] **Step 3: Remove the `lock-held` test from run-with-lock.test.js**

Delete lines 86-108 of `test/unit/srv/run-with-lock.test.js` — the entire `it('lock-held: returns {skipped: true, reason: lock-held}', ...)` block.

Also remove the `JobLocks` clear in `beforeEach` at line 39-41. Replace:

```js
    // Reset JobLastRun + JobLocks between tests.
    const { JobLastRun, JobLocks } = cds.entities('com.sap.developers.ims');
    await DELETE.from(JobLastRun);
    await DELETE.from(JobLocks);
```

With:

```js
    // Reset JobLastRun between tests (JobLocks entity retained but no
    // longer used by the scheduler chassis — see #958).
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    await DELETE.from(JobLastRun);
```

- [ ] **Step 4: Run the affected test file**

Run: `npx vitest run test/unit/srv/run-with-lock.test.js`
Expected: 2 tests pass (success + failure paths); the lock-held test is gone.

- [ ] **Step 5: Search for any other test that references JobLocks + adjust**

Run: `grep -rn "JobLocks" test/ srv/__tests__/ 2>/dev/null`

For each hit:
- If the test is CLEARING `JobLocks` in a `beforeEach` for unrelated reasons (e.g. `cleanup.test.js`, `content-publish-routes.test.js`), leave it alone — the DELETE is cheap and the entity still exists.
- If the test is ASSERTING on `JobLocks` rows written by the scheduler chassis, that test needs its scheduler assertion removed. Read carefully; expected finding is that no such assertion exists (job-lock was never externally observable in tests).

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Do NOT commit yet — Task 10 finalizes Commit 3**

---

## Task 10: Verify hybrid admin-run-job test + finalize Commit 3

**Files:**
- Modify (only if needed): `test/hybrid/admin-run-job.test.js`

**Interfaces:**
- Consumes: hybrid test infrastructure (`cds bind --exec`, real HANA).
- Produces: green hybrid suite proving end-to-end scheduler behavior.

- [ ] **Step 1: Read the current hybrid test**

Run: `cat test/hybrid/admin-run-job.test.js`

Confirm the current shape: the test registers a `_test-noop` job with a year-1900 schedule (so it never fires naturally), sends a `runJob` action, waits 500ms, then asserts `JobLastRun.lastSuccessAt` is set. No assertion on `skipped` or `reason: 'lock-held'` — the migration should not affect this test.

- [ ] **Step 2: Confirm no lock-held assertion**

Run: `grep -n "lock-held\|skipped" test/hybrid/admin-run-job.test.js`
Expected: no output (or only informational comments — no `expect(...).skipped` calls).

If any assertion depends on the lock-held shape, replace it with an assertion that the return value has `started: true`. But per the current file (verified during planning), there is no such assertion.

- [ ] **Step 3: Run the hybrid suite**

Run: `npm run test:hybrid`
Expected: `admin-run-job.test.js` passes green. Requires `cf login` + a bound `default-env.json` — if the environment is not set up for hybrid runs locally, note this and skip; CI will run it on merge.

If the environment IS set up: this is the strongest signal we haven't regressed anything. Confirm the assertion `expect(row.lastSuccessAt).toBeTruthy()` holds.

- [ ] **Step 4: Commit — end of Commit 3**

```bash
git add srv/jobs/scheduler.js srv/jobs/job-lock.js srv/lib/purge-stale-changelog.js test/unit/srv/run-with-lock.test.js
# Deleted file is staged via `git rm` in Task 9 Step 2 — verify:
git status --short
# Expect to see:
#   M  srv/jobs/scheduler.js
#   D  srv/jobs/job-lock.js
#   M  srv/lib/purge-stale-changelog.js
#   M  test/unit/srv/run-with-lock.test.js

git commit -m "feat(#958): drop JobLocks scheduler usage; retire job-lock.js

runWithLock no longer acquires/releases a DB lock — CAP 10's .as(name)
status-column singleton semantics prevent concurrent scheduled ticks
across CF instances. The lock-held short-circuit and its audit-emission
branch are removed. Manual triggers colliding with an in-flight
scheduled run of the same job now both run to completion (deliberate
behavior change; see spec 'Locking model' section).

srv/lib/purge-stale-changelog.js inlines its own private
acquireBootSentinel helper for the changelog-noise-purge sentinel path
— separate concern from scheduler locking, retained for boot idempotency.
The JobLocks entity in db/schema.cds stays for this caller; entity
retirement is a follow-up ticket.

srv/jobs/job-lock.js is deleted. test/unit/srv/run-with-lock.test.js
loses its lock-held test case.

Refs #958"
```

---

## Task 11: Write the hybrid CronService schedule smoke test

**Files:**
- Create: `test/hybrid/cron-service-schedule.test.js`

**Interfaces:**
- Consumes: `cds.outbox.Messages` (CAP-managed table where scheduled tasks live).
- Produces: A hybrid smoke test asserting that after CAP is bootstrapped, `cds.outbox.Messages` contains one pending row per registered job with a singleton name matching the job's `jobName`.

- [ ] **Step 1: Create the test**

Create `test/hybrid/cron-service-schedule.test.js` with contents:

```js
// test/hybrid/cron-service-schedule.test.js
//
// Hybrid smoke test: after CAP bootstraps with CronService, the outbox
// table (cds.outbox.Messages) should contain one pending row per
// registered job, with singleton names matching the jobName field.
//
// Catches config regressions (accidental protocol exposure, missing
// schedule call) that unit-mock spies cannot.
//
// Migration spec: docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md
// Issue: #958

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('CronService schedule smoke (hybrid)', () => {
  beforeAll(async () => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to inspect HANA outbox.');
    }
    // Trigger CAP boot so CronService.init() runs.
    await cds.connect.to('CronService');
  });

  it('outbox contains one pending message per registered job', async () => {
    // Import the registry module the SAME way the hybrid admin-run-job
    // test does — cds.utils._import — to share the module instance.
    const sched = await cds.utils._import(new URL('../../srv/jobs/scheduler.js', import.meta.url).pathname);
    const registeredJobs = Array.from(sched._getJobRegistry().values());
    expect(registeredJobs.length).toBeGreaterThan(30);   // 32 today

    // Query the outbox for messages whose event name matches cron.<jobName>.
    // The exact table name and column names are set by CAP; the guide
    // documents cds.outbox.Messages with a `msg` payload and a status.
    const db = await cds.connect.to('db');
    const { Messages } = cds.entities('cds.outbox');
    const rows = await db.run(SELECT.from(Messages).columns('msg'));

    // Every registered jobName should have a scheduled entry.
    const scheduledNames = new Set(
      rows
        .map(r => {
          try {
            const msg = typeof r.msg === 'string' ? JSON.parse(r.msg) : r.msg;
            return msg?.event;
          } catch { return null; }
        })
        .filter(Boolean)
    );

    for (const job of registeredJobs) {
      expect(scheduledNames.has(`cron.${job.jobName}`)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Note that outbox schema may vary**

The exact `cds.outbox` entity shape is set by CAP 10; if the SELECT above returns 0 rows or the message shape differs, adjust the query. The **intent** of the test is: for each `job.jobName` in the registry, there exists at least one outbox row scheduled with a singleton matching that jobName. Use `console.log(rows[0])` in a scratch run to inspect the shape if the assertion fails.

- [ ] **Step 3: Run only if hybrid env is set up**

Run: `npm run test:hybrid -- test/hybrid/cron-service-schedule.test.js`
Expected: passes green.

If the environment is not set up locally, defer to CI. Note in the PR description that this test requires `ALLOW_HYBRID_WRITES=true` + `cds bind --exec`.

- [ ] **Step 4: Do NOT commit yet — Task 13 finalizes Commit 4**

---

## Task 12: Remove the CAP_SCHEDULING_ENABLED feature flag

**Files:**
- Modify: `srv/cron-service.js` (remove the flag branch)
- Modify: `deploy/dev.mtaext` (remove the env var)

**Interfaces:**
- Consumes: nothing
- Produces: `CronService.init()` always wires handlers + schedule calls — no runtime flag.

- [ ] **Step 1: Remove the feature-flag block from CronService**

In `srv/cron-service.js`, delete:

```js
    if (process.env.CAP_SCHEDULING_ENABLED === 'false') {
      LOG.warn('CAP_SCHEDULING_ENABLED=false — skipping srv.schedule() wiring; node-cron remains sole engine');
      await super.init();
      return;
    }
```

- [ ] **Step 2: Remove the env var from deploy/dev.mtaext**

Delete the `CAP_SCHEDULING_ENABLED: "true"` line added in Task 4.

- [ ] **Step 3: Remove the flag branch from the cron-service unit test**

In `test/unit/srv/cron-service.test.js`, delete the entire `it('CAP_SCHEDULING_ENABLED=false: still populates registry, but does NOT wire handlers or schedule calls', ...)` block, and remove the `delete process.env.CAP_SCHEDULING_ENABLED;` line from `afterEach`.

- [ ] **Step 4: Verify all files parse**

```bash
node --check srv/cron-service.js
node --check test/unit/srv/cron-service.test.js
yq '.modules[] | select(.name == "srv") | .properties | keys' deploy/dev.mtaext
```

Expected: no output from `node --check`; `yq` output no longer contains `CAP_SCHEDULING_ENABLED`.

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: all tests pass; the removed CAP_SCHEDULING_ENABLED test is gone.

- [ ] **Step 6: Do NOT commit yet — Task 13 finalizes Commit 4**

---

## Task 13: Drop node-cron dep, update docs, finalize Commit 4

**Files:**
- Modify: `package.json` — remove `"node-cron"` from `dependencies`
- Modify: `CLAUDE.md` — one-line pointer to CronService
- Modify (if applicable): `docs/developers/reference/tutorials-ims-gotchas.md`
- Modify: `docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md` — pointer to this migration spec

**Interfaces:**
- Consumes: nothing
- Produces: end-state PR — `node-cron` gone from dependencies, docs updated.

- [ ] **Step 1: Remove node-cron from package.json**

Run: `jq 'del(.dependencies["node-cron"])' package.json > /tmp/pkg.json && mv /tmp/pkg.json package.json`

Verify: `jq '.dependencies["node-cron"] // "gone"' package.json` returns `"gone"`.

`cron-parser` MUST still be present: `jq '.dependencies["cron-parser"]' package.json` returns `"5.6.1"`.

- [ ] **Step 2: Regenerate the lockfile**

Run: `npm install`
Expected: `node-cron` removed from `package-lock.json`; no other version churn (or minor patch bumps — flag anything unexpected).

- [ ] **Step 3: Update CLAUDE.md**

In `CLAUDE.md`, find the `## Architecture` section's subsystem one-liner:

```
- **CAP srv/** — 12 services under `@path` prefixes (see testing-endpoints.md). Content persistence in `srv/lib/content-store.js`. WebSocket via `@cap-js-community/websocket` (Socket.IO) on `/ws/display` + `/ws/event-stream`. Jobs in `srv/jobs/` (scheduler.js).
```

Change the last sentence to:

```
Jobs in `srv/jobs/` (scheduler.js) — scheduled via CAP 10's Scheduling API through the internal `CronService` in `srv/cron-service.js` (#958).
```

- [ ] **Step 4: Update tutorials-ims-gotchas.md if it references node-cron**

Run: `grep -n "node-cron\|node_cron" docs/developers/reference/tutorials-ims-gotchas.md`

For each hit: replace the mention with a pointer to CronService or delete the outdated warning. If no hits, skip this step.

- [ ] **Step 5: Update the #756 admin-trigger spec**

In `docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md`, find the "Chassis" section (grep for `## Chassis` or `chassis`). Add a note near the top of that section:

```markdown
> **Update 2026-07-04:** the scheduler engine migrated from node-cron to CAP 10's Scheduling API in #958. `runWithLock` no longer acquires a DB lock (`.as(name)` singleton semantics replace `JobLocks`). The admin trigger chassis described below is preserved verbatim; the `manualTrigger` opts path is unchanged. See `docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md` for the migration.
```

- [ ] **Step 6: Update the scheduler.js header docstring**

In `srv/jobs/scheduler.js`, update the top-of-file docstring's engine description if it still references node-cron. Verify by running:

```
grep -n "node-cron" srv/jobs/scheduler.js
```

Expected: no output. If any mentions remain, edit them to describe CronService's owner role.

- [ ] **Step 7: Run the full unit suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 8: Optional — run linter and CAP compile**

```bash
npx cds compile srv/ 2>&1 | grep -iE "error|warn" | head
npm run lint 2>&1 | tail -20 || true
```

Expected: no errors from either.

- [ ] **Step 9: Commit — end of Commit 4**

```bash
git add package.json package-lock.json srv/cron-service.js test/unit/srv/cron-service.test.js deploy/dev.mtaext CLAUDE.md docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md docs/developers/reference/tutorials-ims-gotchas.md srv/jobs/scheduler.js
# The exact list depends on what actually changed in Steps 3-6.

git commit -m "chore(#958): drop node-cron dep + feature flag + docs

- Removes node-cron from dependencies (no longer used anywhere).
- Removes CAP_SCHEDULING_ENABLED feature flag from CronService and
  deploy/dev.mtaext — CronService is now unconditionally the scheduler.
- Updates CLAUDE.md, tutorials-ims-gotchas.md, and the #756 admin-trigger
  spec to point at the new engine.
- cron-parser is retained (srv/lib/cron-firings.js uses it for the
  admin nextRunIso tile).

Closes #958"
```

---

## Task 14: Push branch and open draft PR

**Files:** none

**Interfaces:**
- Consumes: `git`, `gh` CLI, GitHub remote.
- Produces: a draft PR on the `sap-tutorials/tutorials-ims` repository referencing issue #958.

- [ ] **Step 1: Verify branch and clean state**

```bash
git branch --show-current
git status --short
```

Expected: on branch `worktree-958-cap10-scheduler-migration`; `git status` clean.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin worktree-958-cap10-scheduler-migration
```

Expected: successful push.

- [ ] **Step 3: Open a draft PR**

```bash
gh pr create --draft \
  --title "feat(#958): migrate scheduler chassis to CAP 10 Scheduling API" \
  --body "$(cat <<'EOF'
Closes #958.

Migration spec: [docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md](../blob/worktree-958-cap10-scheduler-migration/docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md)

## What changed

- Introduces `srv/cron-service.{cds,js}` as an internal, no-protocol scheduling bus that owns the scheduler lifecycle (`registerJobs` → `preSeedJobLastRun` → `srv.on` + `srv.schedule.every.as` per job).
- Removes the `node-cron` engine from `srv/jobs/scheduler.js:registerJob`.
- Removes the `registerJobs()` call from `srv/server.js` — CronService owns it.
- Removes lock acquire/release from `runWithLock` — CAP 10's `.as(name)` singleton semantics prevent duplicate scheduled ticks across CF instances.
- Deletes `srv/jobs/job-lock.js`. The `JobLocks` **entity** stays in `db/schema.cds` because `srv/lib/purge-stale-changelog.js` uses it as a boot sentinel; that file now inlines its own private helper. Entity retirement is a follow-up ticket.
- Drops `node-cron` from `dependencies`. `cron-parser` stays (powers admin `nextRunIso` tile).

## What did NOT change

- All 32 `registerJob({...})` call sites in `srv/jobs/scheduler.js:registerJobs()`.
- `srv/admin-service.js` — the 4 admin actions calling `runJobByName(...)` bypass the outbox and work unchanged.
- `srv/lib/cron-firings.js` — `cron-parser` continues to compute the admin `nextRunIso` tile.
- `PipelineLog`, `JobLastRun`, `SecurityEvent` audit trail — all preserved verbatim.
- All admin UI code, all job modules.

## Behavior change (deliberate)

Manual triggers colliding with an in-flight scheduled run of the same job now both run to completion (last-write-wins on `JobLastRun`). Pre-#958 the second run would get `{skipped:true, reason:'lock-held'}`. See spec "Locking model" section.

## Test evidence

- `npm test` — all unit suites green
- `npm run test:hybrid` — `admin-run-job.test.js` green (requires `ALLOW_HYBRID_WRITES=true` + `cf login`); new `cron-service-schedule.test.js` verifies outbox contains one row per registered job.

## Rollout

Ready for DEV soak. The migration was staged internally as four commits inside this PR — squash-merge is fine, but the commit history is preserved on the branch if a revert-to-any-intermediate-state is needed during soak.

EOF
)"
```

Expected: PR URL printed to stdout.

- [ ] **Step 4: Verify PR is draft**

```bash
gh pr view --json isDraft,title,number
```

Expected: `{"isDraft":true,"title":"feat(#958): ...","number":<n>}`.

---

## Self-review

**Spec coverage check** (verified section-by-section against `docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md`):

- Architecture (spec §Architecture): CronService creation covered by Tasks 1–2. Register-then-schedule flow covered by Task 2.
- Component design — `srv/cron-service.cds`: Task 1. Impl: Task 2. `runWithLock` edits: Task 8. `server.js` removal: Task 6.
- Data flow: verified through Tasks 2, 5, 6, 8. The manual-trigger path is untouched by design (admin-service.js is not in any task).
- Locking model — deliberate behavior change from lock-held short-circuit to both-run: implemented by Task 8, documented in the Commit 3 message and the PR body (Task 14).
- Boot ordering: Task 2 (CronService.init owns lifecycle) + Task 6 (server.js removal).
- Testing — unit unchanged: no task, correct. Unit adjusted (run-with-lock): Task 9. Unit added (cron-service): Task 3. Hybrid added (cron-service-schedule): Task 11. Hybrid unchanged assertion (admin-run-job): Task 10.
- Rollout Commits 1–4: Tasks 1–4 / 5–6 / 7–10 / 11–13. Task 14 is the ship step.
- Success criteria: package.json check (Task 13), job-lock.js gone (Task 9), hybrid runjob green (Task 10), JobLocks entity retained per amendment (spec amendment already reflected in Task 7).

**Placeholder scan:** no `TBD` / `TODO (implement)` / "similar to Task N" tokens in the plan. Every step has concrete code or exact commands.

**Type/name consistency:**
- `runJobByName(name)` vs `runJobByName(name, opts)` — the CronService dispatch (Task 2) uses `runJobByName(job.jobName)` (no opts); the admin path in `srv/admin-service.js` (untouched) still passes opts. The `runJobByName` signature accepts `opts = {}` default, so both work.
- `.as(name)` singleton: Task 2's impl uses `.as(job.jobName)`; Task 11's smoke test looks for `cron.<jobName>` event names in the outbox. These are consistent (event name vs singleton name are different concepts; the event is `cron.<jobName>`, the singleton *identity* is the plain `jobName`).
- `acquireBootSentinel(sentinelName, instanceId, durationMs)` in Task 7 vs the old `acquireLock(jobName, instanceId, durationMs, namespace?)`. Task 7's helper drops the `namespace` argument since it's hardcoded for the single boot-sentinel caller. This is intentional (private helper, single caller).
- `_getJobRegistry`, `_resetJobRegistry`, `_setJobFn` — used by tests in Tasks 3, 9 and existing tests. All exports remain in `srv/jobs/scheduler.js`.

Plan self-review complete — no fixes needed.

---

## References

- Spec: `docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md`
- Issue: [sap-tutorials/tutorials-ims#958](https://github.com/sap-tutorials/tutorials-ims/issues/958)
- CAP 10 Scheduling API: <https://cap.cloud.sap/docs/releases/2026/jun26#scheduling-api>
- CAP Event Queues guide: <https://cap.cloud.sap/docs/guides/events/event-queues>
- Predecessor admin-trigger chassis spec: `docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md`
