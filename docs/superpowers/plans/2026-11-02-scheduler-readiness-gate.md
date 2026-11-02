# Scheduler Readiness Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an HTTP readiness probe (`/health/ready`) that returns 200 only once `CronService.init()` has wired the scheduler and the DB answers, and gate the CF blue-green deploy on it so blue instances aren't retired before green's scheduler is up (#2975 Fault A).

**Architecture:** A tiny dependency-free in-process latch (`scheduler-ready.js`) is flipped at the end of `CronService.init()` and read by a new anonymous `/health/ready` Express route in the custom `server.js`. The route delegates its 200/503 decision to a pure `computeReadiness()` helper (unit-testable without standing up Express). The CF `health-check-type: http` module parameter in both live mta.yaml files points at the endpoint.

**Tech Stack:** SAP CAP (`@sap/cds` 10.2), Node.js ESM, Express (custom `srv/server.js`), Vitest (SQLite in-memory), MBT/MTA on Cloud Foundry.

**Spec:** `docs/superpowers/specs/2026-11-02-scheduler-readiness-gate-design.md`

## Global Constraints

- Node.js ESM throughout (`import`/`export`), matching `srv/lib/*.js`.
- `/health/ready` MUST be anonymous — registered before `app.use(basicAuthMiddleware)` (server.js:319), inside the `cds.on('bootstrap')` block (server.js:233), adjacent to `/health` (server.js:292).
- The latch module MUST NOT import `@sap/cds` (no import cycle; `server.js` ↔ `cron-service.js` have none today — keep it that way).
- Endpoint work: one in-memory boolean read + at most one `SELECT 1 FROM DUMMY`. No heavier work (anonymous DoS surface).
- MTA edits go in **both** `.deploy/mta.yaml` (local deploy source) AND root `mta.yaml` (CI deploy source), kept in sync, on modules `tutorials-srv` + `tutorials-srv-qa` only. **Never** `mta-mcp.yaml` (`srv-mcp` has no CronService → would 503 forever).
- MTA keys per srv module: `health-check-type: http`, `health-check-http-endpoint: /health/ready`, `health-check-invocation-timeout: 10`, `timeout: 180`.
- Tests are SQLite/in-memory unit tests under `test/unit/srv/lib/`. Do not add a hybrid/HANA dependency.

## Review Focus

- **Latch is process-global, not per-request** — a second `markSchedulerReady()` call (init re-entry) must stay idempotent-true, never flip back. Covered in Task 1.
- **`cds.db` undefined at probe time** (DB not yet connected on a very early probe) — `computeReadiness` must treat "db check threw / db absent" as not-ready (503), never 200. Covered in Task 2.
- **Probe before `CronService.init()` ran** (green just booted) — latch false → 503, which is the *entire point*; must not accidentally default-true. Covered in Task 1 + Task 2.
- **`/health` must keep its existing contract** — the new route must not alter or shadow `/health` or `/health/db`. Covered in Task 3 (assert `/health` untouched by reading the file).
- **MBT schema rejects an unknown key** — if the installed MBT rejects `health-check-invocation-timeout` or `timeout`, the deploy fails at build. Task 4 verifies `mbt build` (or a schema parse) accepts the file before commit.

---

### Task 1: Readiness latch module

**Files:**
- Create: `srv/lib/scheduler-ready.js`
- Test: `test/unit/srv/lib/scheduler-ready.test.js`

**Interfaces:**
- Produces: `markSchedulerReady(): void`, `isSchedulerReady(): boolean`, `_resetForTests(): void`. Module-level `let _ready = false`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { markSchedulerReady, isSchedulerReady, _resetForTests } from '../../../../srv/lib/scheduler-ready.js';

describe('scheduler-ready latch', () => {
  beforeEach(() => _resetForTests());
  it('defaults to false before init', () => {
    expect(isSchedulerReady()).toBe(false);
  });
  it('flips to true after markSchedulerReady()', () => {
    markSchedulerReady();
    expect(isSchedulerReady()).toBe(true);
  });
  it('stays true on a second mark (idempotent, never flips back)', () => {
    markSchedulerReady();
    markSchedulerReady();
    expect(isSchedulerReady()).toBe(true);
  });
  it('_resetForTests() clears it back to false', () => {
    markSchedulerReady();
    _resetForTests();
    expect(isSchedulerReady()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/lib/scheduler-ready.test.js`
Expected: FAIL — cannot resolve `srv/lib/scheduler-ready.js`.

- [ ] **Step 3: Implement the latch in `srv/lib/scheduler-ready.js`**

Module-level `let _ready = false;`. `markSchedulerReady` sets it true; `isSchedulerReady` returns it; `_resetForTests` sets it false. No imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/srv/lib/scheduler-ready.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/scheduler-ready.js test/unit/srv/lib/scheduler-ready.test.js
git commit -m "feat(scheduler): readiness latch for blue-green health gate (#2975)"
```

---

### Task 2: `computeReadiness` pure helper + wire the latch flip

**Files:**
- Modify: `srv/lib/scheduler-ready.js` (add `computeReadiness`)
- Modify: `srv/cron-service.js` (call `markSchedulerReady()` before `super.init()`, ~line 105)
- Test: `test/unit/srv/lib/scheduler-ready.test.js` (extend)

**Interfaces:**
- Consumes: `markSchedulerReady` (Task 1).
- Produces: `computeReadiness({ schedulerArmed: boolean, dbOk: boolean }): { ready: boolean, status: string, scheduler: string, db: string }` — `ready = schedulerArmed && dbOk`; `status` is `'ready'|'not-ready'`; `scheduler` is `'armed'|'pending'`; `db` is `'connected'|'error'`.

- [ ] **Step 1: Write the failing test** (append to the Task 1 file)

```js
import { computeReadiness } from '../../../../srv/lib/scheduler-ready.js';

describe('computeReadiness', () => {
  it('ready when scheduler armed and db ok', () => {
    expect(computeReadiness({ schedulerArmed: true, dbOk: true }))
      .toEqual({ ready: true, status: 'ready', scheduler: 'armed', db: 'connected' });
  });
  it('not-ready (pending) when scheduler not armed, even if db ok', () => {
    expect(computeReadiness({ schedulerArmed: false, dbOk: true }))
      .toEqual({ ready: false, status: 'not-ready', scheduler: 'pending', db: 'connected' });
  });
  it('not-ready (db error) when db check failed, even if scheduler armed', () => {
    expect(computeReadiness({ schedulerArmed: true, dbOk: false }))
      .toEqual({ ready: false, status: 'not-ready', scheduler: 'armed', db: 'error' });
  });
  it('not-ready when both false', () => {
    expect(computeReadiness({ schedulerArmed: false, dbOk: false }).ready).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/lib/scheduler-ready.test.js`
Expected: FAIL — `computeReadiness` is not exported.

- [ ] **Step 3: Implement `computeReadiness(...)` in `srv/lib/scheduler-ready.js`**

Pure function of the two booleans, returning the object shape in Interfaces. No `@sap/cds` import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/srv/lib/scheduler-ready.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Wire the flip in `srv/cron-service.js`**

Add `import { markSchedulerReady } from './lib/scheduler-ready.js';` at the top with the other imports. Immediately before `await super.init();` (currently line 106), call `markSchedulerReady();` with a one-line comment referencing #2975 (state 2: schedules registered + self-heal armed). Do not gate it on CF detection — `init()` running is the signal.

- [ ] **Step 6: Run the cron-service unit tests to confirm no regression**

Run: `npx vitest run test/unit/srv/lib/scheduler-reaper.test.js test/unit/srv/run-with-lock.test.js`
Expected: PASS (existing counts unchanged — 38 + the run-with-lock suite).

- [ ] **Step 7: Commit**

```bash
git add srv/lib/scheduler-ready.js srv/cron-service.js test/unit/srv/lib/scheduler-ready.test.js
git commit -m "feat(scheduler): computeReadiness helper + flip latch at end of CronService.init() (#2975)"
```

---

### Task 3: `/health/ready` endpoint

**Files:**
- Modify: `srv/server.js` (add route adjacent to `/health`, ~line 294, inside `cds.on('bootstrap')`, before `app.use(basicAuthMiddleware)` at 319)
- Test: `test/unit/srv/lib/scheduler-ready.test.js` (the endpoint's logic is already covered via `computeReadiness`; add one integration assertion via `cds.test` only if cheap — see Step 1 note)

**Interfaces:**
- Consumes: `isSchedulerReady` + `computeReadiness` (Tasks 1–2).
- Produces: `GET /health/ready` → `res.status(ready?200:503).json({ status, scheduler, db, timestamp })`.

- [ ] **Step 1: Write the failing test**

The decision logic is fully covered by `computeReadiness` (Task 2). For the wiring, add one `cds.test`-served HTTP assertion that the route exists and returns 200 once the app is up (init has run, latch true):

```js
// test/integration/health-ready.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
const { GET } = cds.test('serve', '--project', '.', '--in-memory');
describe('/health/ready (#2975)', () => {
  it('returns 200 ready once the served app has initialised the scheduler', async () => {
    const res = await GET('/health/ready');
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ready');
    expect(res.data.scheduler).toBe('armed');
  });
});
```

Note: the 503 paths are proven by Task 2's `computeReadiness` unit tests (standing up Express in a false-latch state is racy against `init()`); this integration test only proves the route is mounted anonymously and returns the ready shape over HTTP.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/health-ready.test.js`
Expected: FAIL — `/health/ready` 404 (route not yet added).

- [ ] **Step 3: Implement the route in `srv/server.js`**

Add `import { isSchedulerReady, computeReadiness } from './lib/scheduler-ready.js';` with the other `./lib` imports. Adjacent to `/health` (line 292–294), add an async handler: probe `dbOk` via `await cds.db?.run('SELECT 1 FROM DUMMY')` in a try/catch (catch or absent `cds.db` → `dbOk=false`), call `computeReadiness({ schedulerArmed: isSchedulerReady(), dbOk })`, respond `res.status(r.ready?200:503).json({ status:r.status, scheduler:r.scheduler, db:r.db, timestamp: new Date().toISOString() })`. Leave `/health` and `/health/db` untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/health-ready.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm `/health` is unchanged**

Run: `git diff srv/server.js`
Expected: only an added import line and the added `/health/ready` block; the `/health` (292) and `/health/db` (296) handlers are byte-for-byte unchanged.

- [ ] **Step 6: Commit**

```bash
git add srv/server.js test/integration/health-ready.test.js
git commit -m "feat(scheduler): anonymous /health/ready readiness probe (#2975)"
```

---

### Task 4: MTA readiness gate (both files) + exclusion verification

**Files:**
- Modify: `.deploy/mta.yaml` (modules `tutorials-srv`, `tutorials-srv-qa`)
- Modify: `mta.yaml` (modules `tutorials-srv`, `tutorials-srv-qa`)

**Interfaces:**
- Consumes: `/health/ready` (Task 3).

- [ ] **Step 1: Add the four keys to each srv module in `.deploy/mta.yaml`**

Under the `parameters:` block of `tutorials-srv` (currently after `instances: 1`, ~line 124) and `tutorials-srv-qa` (~line 185), add:
```yaml
      health-check-type: http
      health-check-http-endpoint: /health/ready
      health-check-invocation-timeout: 10
      timeout: 180
```

- [ ] **Step 2: Add the identical four keys to each srv module in root `mta.yaml`**

Same two modules, same keys. Keep both files in sync.

- [ ] **Step 3: Verify `mta-mcp.yaml` was NOT touched**

Run: `git diff --name-only`
Expected: `mta-mcp.yaml` is absent from the list. (Confirms the exclusion — `srv-mcp` has no scheduler.)

- [ ] **Step 4: Verify both MTA files still parse / build accepts the keys**

Run: `npx mbt build -p=. -t=./mta_archives --mtar=_schemacheck.mtar -s=.deploy/mta.yaml 2>&1 | tail -20` — OR, if a full build is too heavy in this environment, a YAML+schema parse: `node -e "const y=require('js-yaml');y.load(require('fs').readFileSync('.deploy/mta.yaml','utf8'));y.load(require('fs').readFileSync('mta.yaml','utf8'));console.log('both parse ok')"`.
Expected: no schema error on the new keys. If MBT rejects `health-check-invocation-timeout` or `timeout`, remove just that key from BOTH files (the two required keys are `health-check-type` + `health-check-http-endpoint`) and note it in the commit.

- [ ] **Step 5: Commit**

```bash
git add .deploy/mta.yaml mta.yaml
git commit -m "feat(deploy): gate blue-green on /health/ready for tutorials-srv + srv-qa (#2975)"
```

---

### Task 5: Runbook — readiness gate section

**Files:**
- Modify: `docs/developers/operations/scheduler-troubleshooting.md`

- [ ] **Step 1: Replace the "Readiness note (open follow-up)" bullet with a shipped-mechanism subsection**

In the `cds.flush()` (#2975) subsection added by PR #2984, the last bullet currently frames the CF readiness gate as an *open follow-up*. Replace it with a short **"Readiness gate (#2975 Fault A)"** subsection stating: the three boot states; why the gate asserts state 2 (wired+DB) not state 3 (drain); the `/health/ready` contract (200 only when `isSchedulerReady()` && `SELECT 1`); the MTA keys on `tutorials-srv`/`-qa` in **both** mta.yaml files (and the `mta-mcp.yaml` exclusion); and that it composes with the flush self-heal (gate = Fault A, flush = Fault B). Keep it concise.

- [ ] **Step 2: Verify the doc has no stale "open follow-up" wording left**

Run: `grep -n "open follow-up\|not.*closed by #2975" docs/developers/operations/scheduler-troubleshooting.md`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add docs/developers/operations/scheduler-troubleshooting.md
git commit -m "docs(ops): document shipped /health/ready readiness gate (#2975)"
```

---

### Task 6: Full-suite sanity + PR

**Files:** none (verification + PR)

- [ ] **Step 1: Run the scheduler-related unit tests together**

Run: `npx vitest run test/unit/srv/lib/scheduler-ready.test.js test/unit/srv/lib/scheduler-reaper.test.js test/integration/health-ready.test.js`
Expected: all PASS.

- [ ] **Step 2: Push the branch and open a PR to DEV**

The branch is already pushed (`worktree-docs-scheduler-flush-2975`, PR #2984 docs-only). Decide with the maintainer whether to extend #2984 or open a second PR for the code; default: push these commits to the same branch (they're the same issue) so #2984 becomes the full #2975-FaultA PR. Update the PR title/body to cover code + docs. Base = `DEV`.

- [ ] **Step 3: Note the DEV validation procedure in the PR**

Copy the §"Operational validation" steps from the spec into the PR body (paused blue-green + resume; measure boot-to-ready vs `timeout: 180`; DB-clock canary staleness; pass = `metrics-rollup` holds `*/5` across ≥2 cycles, no `cf restart-app-instance`).
