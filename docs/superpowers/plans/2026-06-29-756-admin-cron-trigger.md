# Admin self-service cron trigger (#756) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `srv/jobs/scheduler.js` to populate a `JOB_REGISTRY` map (single source of truth for both scheduled and manual invocations); add `AdminService.JobControls` singleton with `listJobs()` + `runJob(jobName)` actions; retrofit `JobLastRun` writes to all 24 crons via the chassis; extend the Phase 4.5 admin "Cron health" tile with Schedule / Next run / Run-now columns.

**Architecture:** Three tasks land as commit ranges on a single shared branch and a SINGLE PR (squash-merged; matches Phase 4.1-4.5 actual shipping pattern):

1. **Scheduler refactor + JobLastRun retrofit (Task 1)** — `JOB_REGISTRY: Map<jobName, JobDef>` + `registerJob({...})` declarations replace inline `cron.schedule()` calls (24 jobs). `runWithLock` extended with optional 4th opts arg `{manualTrigger, user}`; `recordJobLastRun` invoked unconditionally in finally-block. Pre-seed JobLastRun via UPSERT at end of `registerJobs()`. Remove inline `recordJobLastRun` call from `fetch-api-docs` cron body (now dead code).
2. **`AdminService.JobControls` singleton + handlers (Task 2)** — new singleton, `listJobs()` + `runJob(jobName)` actions, `emitJobAudit` helper, `cron-parser` dep, 8 unit tests + 1 hybrid.
3. **Admin UI tile extension (Task 3)** — Board.view.xml gets 3 new columns (Schedule / Next run / Run now button) + the existing 3 columns. Board.controller.js gets `_loadJobControls()` JOIN logic + `onRunJob()` press handler + 5-min poll-after-trigger.

**Tech Stack:** SAP CAP (Node.js 22), HANA Cloud, vitest (unit + hybrid), UI5/Fiori (admin shell), `cron-parser` for next-run computation.

---

## Spec reference

**Spec:** [`docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md`](../specs/2026-06-29-756-admin-cron-trigger.md)
**Related issues:**
- [#769](https://github.com/sap-tutorials/tutorials-ims/issues/769) — Phase 4.5 `seedApiDocs` audit-event bug. Spec §4.8 explicitly avoids lifting the buggy pattern. May be fixed in parallel.

## Prerequisites — read these before starting

1. **The #756 spec** — every design decision (Q1-Q9) and acceptance criterion is locked there. Especially §4 (architecture), §7 (test plan), §9 (gotchas), §12 (round-1/2 reviewer fold-in).
2. **`srv/jobs/scheduler.js`** — current state. The runWithLock function at line 23, recordJobLastRun at lines 47-64, registerJobs at line 226+. Skim line 253-459 (the 24 cron registrations) to feel the variety.
3. **`srv/lib/pipeline-log.js`** — exports `logPipelineStart(pipelineType, initiator, metadata, namespace?, opts?)` and `logPipelineEnd(logId, status, summary, errorDetails?, namespace?)`. Used inside runWithLock.
4. **`srv/lib/audit-event.js`** — `createAuditEmitter(binding, logger)` returns `emitAudit(action, data)`. Action is the FIRST arg; do NOT pass `'SecurityEvent'` literally (that's the audit-log event-type, set inside the closure).
5. **`srv/admin-service.cds`** — find `ChatSettings.seedEmbeddings()` (line ~195) and `KnowledgeGraphSettings.seedApiDocs()` (line ~210) for admin-action precedents. Both `@requires: 'Admin'` on the singleton.
6. **`srv/admin-service.js`** — the `auditEvent` closure is created at line ~1583 via `createAuditEmitter(_auditLog, LOG)`. The `runJob` handler MUST be placed inside the same init scope to have `auditEvent` in lexical scope.
7. **`app/admin-shell/webapp/view/Board.view.xml`** — Phase 4.5 already added the "Cron health" Panel (lines 81-100) binding to `{admin>/JobLastRun}`. Task 3 extends this Panel with 3 new columns + a Run-now button.
8. **`app/admin-shell/webapp/controller/Board.controller.js`** — existing `_loadMetrics()` + `formatTimestamp()` patterns to mirror.
9. **`srv/jobs/job-lock.js`** — `acquireLock(jobName, instanceId, durationMs)` + `releaseLock(jobName, instanceId)`. Verify the contract (returns boolean).
10. **CAP `before/on/after` handler patterns** — use `mcp__plugin_cds-mcp_cds-mcp__search_docs` for canonical CDS/Node API signatures.
11. **Test discipline (mandatory)** — every step adding code lands its failing test first. See `@superpowers:test-driven-development`.

---

## File structure — what changes

### New files (0 source + 5 tests + 1 fixture)

**Task 1:**
- `test/unit/srv/scheduler-registry.test.js` (NEW) — 5 cases
- `test/unit/srv/run-with-lock.test.js` (NEW) — 3 cases

**Task 2:**
- `test/unit/srv/admin-job-controls.test.js` (NEW) — 6 cases
- `test/unit/srv/job-controls-boot-seed.test.js` (NEW) — 2 cases
- `test/hybrid/admin-run-job.test.js` (NEW) — 1 case (BLOCKED-until-deploy)

**Task 3:**
- `test/unit/admin-shell/board-controller-job-controls.test.js` (NEW) — 2 cases

### Modified files

**Task 1:**
- `srv/jobs/scheduler.js` — registry refactor + `runWithLock` extension + pre-seed (major). Add `JOB_REGISTRY`, `registerJob`, `runJobByName`, `preSeedJobLastRun`, test seams (`_getJobRegistry`, `_resetJobRegistry`, `_setJobFn`). Remove inline `recordJobLastRun` from `fetch-api-docs` cron body.

**Task 2:**
- `srv/admin-service.cds` — add `JobControls` singleton + 2 actions
- `srv/admin-service.js` — `emitJobAudit` helper + 2 handlers
- `package.json` — add `cron-parser` dependency (pinned via `--save-exact` per project policy)

**Task 3:**
- `app/admin-shell/webapp/view/Board.view.xml` — extend Cron health Table with 3 new columns + Run-now button
- `app/admin-shell/webapp/controller/Board.controller.js` — `_loadJobControls`, `onRunJob`, `_scheduleJobControlsRefresh`, `formatNextRun`, `formatRelativeTime` helpers, model registration
- `app/admin-shell/webapp/css/style.css` (or wherever Board view CSS lives) — `.kg-mono` class

---

## Task decomposition

- **[Task 1 — Scheduler refactor + JobLastRun retrofit](./2026-06-29-756-task1-scheduler.md)** — ~22 steps, 4 commits, ~350 LoC
- **[Task 2 — JobControls singleton + handlers](./2026-06-29-756-task2-jobcontrols.md)** — ~18 steps, 3 commits, ~280 LoC
- **[Task 3 — Admin UI tile extension](./2026-06-29-756-task3-ui.md)** — ~14 steps, 2 commits, ~180 LoC

Total: ~54 steps / 9 commits / ~810 LoC.

---

## Skills referenced

- `@superpowers:test-driven-development` — red/green/refactor rhythm for every step.
- `@superpowers:subagent-driven-development` (recommended execution mode) — fresh subagent per task; two-stage review.

---

## Cross-cutting reminders for every task

- **The scheduler refactor is a near-rewrite of `runWithLock` body** — five new local variables (`outcome`, `errorMessage`, `result`, `startedAt`, `logId`), not a minimal diff. Plan-reviewer round 2 explicitly flagged this as deserving its own task step with before/after side-by-side (Task 1 §1.3).
- **`fetch-api-docs` cron body** — has an inline `recordJobLastRun(...)` call (currently around scheduler.js line 425) that becomes **dead code that double-writes** after Task 1's chassis retrofit. Task 1 Step ~7 MUST delete it.
- **3 lazy-import crons** (`fetch-discovery-missions`, `fetch-videos`, `fetch-api-docs`) keep their dynamic-import inside the `fn:` slot — don't accidentally refactor to eager (would break boot perf).
- **Crons with `(logId)` arg** (`ngds-retry`, `account-merge-batch`, `contributor-notifications`, `email-retry`, `embedding-reconciliation`) preserve the existing `fn(logId)` contract — `runWithLock` still passes the pipeline-log ID to the runner.
- **Pre-seed uses UPSERT** (CDS QL — translates to INSERT...ON CONFLICT on HANA). NOT INSERT+filter. Multi-instance CF boots are race-safe.
- **Pre-seed lives in `srv/jobs/scheduler.js`** at the END of `registerJobs()`. NOT in a separate `cds.on('served')` handler (nested handler wouldn't fire on first boot since `registerJobs()` is itself called from inside one).
- **`runJob` validation BEFORE audit emission** — unknown / oversized payloads rejected first; otherwise an attacker spams the audit log with malformed POSTs.
- **`emitJobAudit` first arg is `'cron.manual-trigger'`** (the action name) — NOT `'SecurityEvent'` (the audit-log event type, set inside the closure). Do NOT lift the seedApiDocs precedent literally — it has a subtle bug (#769).
- **Admin handler placement** — `runJob`/`listJobs` MUST be placed AFTER the `auditEvent = createAuditEmitter(...)` declaration in `srv/admin-service.js` (around line 1583) so the closure is in scope. Placing it near the singleton-init at line ~300 would have `auditEvent` undefined.
- **MAX_JOB_NAME_LEN = 100** — matches `JobLocks.jobName : String(100)` column width (verified `db/schema.cds:412`). Length check on `runJob` payload uses this same constant.
- **No `runWithLock` callers outside `scheduler.js`** — verified during plan-write. Backward-compatible 4th opts arg is for completeness; no production callers will hit the new signature except via `runJobByName`.
- **`cron-parser`** is NOT currently installed (verified during spec round 1). Task 2 Step 9 adds it as `dependencies` pinned via `--save-exact` per project npm policy.
- **CDS build artefact handling** — Task 2 adds `JobControls` (singleton, no entity tables) + action declarations only. Schema changes are zero. Task 1 doesn't modify any CDS files. `cds build --production` should be a no-op for tracked artefacts. Run anyway after each task to verify no staging drift.
- **CAP 10 readiness** — no new compat flags introduced; runs cleanly under both CAP 9 and 10.
- **`srv-qa` cp-list audit** — Task 1 doesn't add new files under `srv/lib/`. Task 2 only modifies `srv/admin-service.js` (already in the cp list). Task 3 is approuter-only. No cp-list changes needed; verify during plan execution.
