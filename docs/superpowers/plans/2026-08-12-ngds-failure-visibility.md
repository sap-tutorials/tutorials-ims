# NGDS Silent-Failure Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a broken NGDS outbound feed visible within ≤2h — via a truthful send metric and ANS alerts raised from the existing 2h retry job — instead of failing silently.

**Architecture:** Three focused changes. (1) `srv/lib/ngds-autosend.js` counts `ngds.autosend.sent` only on real success and adds `ngds.autosend.failed`. (2) A pure, exported `buildRetryAlerts()` in `srv/jobs/ngds-retry.js` decides which ANS alerts a retry run should raise; `retryNgds` wires it in and emits queue gauges/counters. (3) Remove the dead, un-alerted `retryFailedMessages` from `srv/lib/ngds-client.js`. Alerts reuse the existing fail-open `alerting.raise` (gated by `ChatSettings.alertsEnabled`); metrics reuse `srv/lib/metrics.js`.

**Tech Stack:** Node.js ESM, SAP CAP (`@sap/cds`), vitest (`unit` project), existing `srv/lib/alerting.js` (ANS push) and `srv/lib/metrics.js`.

## Global Constraints

- **Windows checkout — write LF line endings only.** JS regex `$` excludes CR; subagents sometimes flip LF→CRLF. Keep new/edited files LF.
- **Run unit tests from the worktree root:** `npx vitest run --project unit <path>`. The `unit` project's include globs cover `test/**/*.test.{js,ts}`.
- **No new runtime dependencies.** Only `srv/lib/metrics.js` and `srv/lib/alerting.js` (already shipped) are imported.
- **Metric names ≤ 64 chars** (`MetricSnapshots.metric` key limit). New names: `ngds.autosend.failed`, `ngds.failed_messages.pending`, `ngds.retry.failed`, `ngds.retry.exhausted` — all within limit.
- **srv-qa cp-list audit:** this touches `srv/jobs/ngds-retry.js` (a scheduled job, not part of the `srv/lib/content-store.js` import chain) and `srv/lib/ngds-autosend.js`/`ngds-client.js` (already shipped). No new `srv/lib/*` file is created and no new import is added to the content-store chain, so `.deploy/mta.yaml`'s `srv-qa` `cp` list needs no change. Confirm with `git grep` that no new `./`-relative import into content-store was introduced.
- **`alerting.raise` is fail-open and DB-gated** by `ChatSettings.alertsEnabled` (default OFF). It never throws. Do not add a second guard.
- **PR, not direct merge.** Commit per task; open a draft PR at the end. Never merge to `main`.

---

## Preparation (once, before Task 1)

The worktree has no `node_modules`. Link it to the primary checkout so vitest resolves:

```bash
# from the worktree root
cmd //c "mklink /J node_modules ..\\..\\..\\node_modules"
node_modules/.bin/vitest --version   # sanity: prints a version
```

If the junction approach fails, run `npm ci && npm run setup` in the worktree instead.

---

## Task 1: Truthful autosend metric (`sent` only on success, add `failed`)

**Files:**
- Modify: `srv/lib/ngds-autosend.js` (the send block near lines 183-192 of `maybeAutoSendCompletion`)
- Test: `test/lib/ngds-autosend.test.js` (update mock default + add one test)

**Interfaces:**
- Consumes: `sendTaskRecordToNgds(record, db)` from `./ngds-client.js` — already returns `{ success: boolean, error?: string }` (never throws; queues to `NGDSFailedMessages` on failure).
- Produces: metric counters `ngds.autosend.sent` (on `success===true`) and `ngds.autosend.failed` (otherwise).

- [ ] **Step 1: Update the existing test's send mock to return a success shape**

In `test/lib/ngds-autosend.test.js`, the `sendSpy` currently returns `undefined`. In `beforeEach`, immediately after `sendSpy.mockReset();`, add a default resolved value so the existing "sends…" cases still record `sent`:

```js
  sendSpy.mockReset();
  sendSpy.mockResolvedValue({ success: true });   // <-- add this line
```

- [ ] **Step 2: Add the failing test for the failure path**

Append inside the `describe('ngds-autosend gating', …)` block:

```js
  it('counts ngds.autosend.failed (not sent) when the send fails without throwing', async () => {
    sendSpy.mockResolvedValueOnce({ success: false, error: 'destination not found' });
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS', db: makeDb({ flag: 'true' }),
    });
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(counterSpy).toHaveBeenCalledWith('ngds.autosend.failed');
    expect(counterSpy).not.toHaveBeenCalledWith('ngds.autosend.sent');
  });
```

- [ ] **Step 3: Run the test — verify the new one FAILS**

Run: `npx vitest run --project unit test/lib/ngds-autosend.test.js`
Expected: the new `ngds.autosend.failed` test FAILS (current code always counts `sent`); pre-existing tests PASS (the mock now returns `{success:true}`).

- [ ] **Step 4: Implement the metric branch**

In `srv/lib/ngds-autosend.js`, replace:

```js
    const { sendTaskRecordToNgds } = await import('./ngds-client.js');
    await sendTaskRecordToNgds(record, database);
    metrics.counter('ngds.autosend.sent');
```

with:

```js
    const { sendTaskRecordToNgds } = await import('./ngds-client.js');
    const outcome = await sendTaskRecordToNgds(record, database);
    if (outcome && outcome.success) metrics.counter('ngds.autosend.sent');
    else metrics.counter('ngds.autosend.failed');
```

- [ ] **Step 5: Run tests — verify all PASS**

Run: `npx vitest run --project unit test/lib/ngds-autosend.test.js`
Expected: ALL pass, including the new failure-path test.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/ngds-autosend.js test/lib/ngds-autosend.test.js
git commit -m "fix(ngds): count autosend.sent only on real success, add autosend.failed"
```

---

## Task 2: Pure `buildRetryAlerts()` decision helper

**Files:**
- Modify: `srv/jobs/ngds-retry.js` (add exported constant + pure function; no wiring yet)
- Test: `test/lib/ngds-retry.test.js` (create)

**Interfaces:**
- Produces: `BACKLOG_THRESHOLD` (number, = 20) and `buildRetryAlerts({ failed, exhausted, pendingRemaining })` → `Array<{ eventType: string, severity: 'ERROR'|'WARNING', subject: string, body: string }>`. Empty array when the run is healthy. Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `test/lib/ngds-retry.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildRetryAlerts, BACKLOG_THRESHOLD } from '../../srv/jobs/ngds-retry.js';

describe('buildRetryAlerts', () => {
  it('returns no alerts on a healthy run', () => {
    expect(buildRetryAlerts({ failed: 0, exhausted: 0, pendingRemaining: 0 })).toEqual([]);
  });

  it('raises an ERROR NgdsSendExhausted alert when messages are permanently dropped', () => {
    const alerts = buildRetryAlerts({ failed: 3, exhausted: 2, pendingRemaining: 5 });
    const exhausted = alerts.find(a => a.eventType === 'NgdsSendExhausted');
    expect(exhausted).toBeDefined();
    expect(exhausted.severity).toBe('ERROR');
    expect(exhausted.subject).toContain('2');
  });

  it('raises a WARNING NgdsBacklog alert when retries fail this run', () => {
    const alerts = buildRetryAlerts({ failed: 1, exhausted: 0, pendingRemaining: 1 });
    const backlog = alerts.find(a => a.eventType === 'NgdsBacklog');
    expect(backlog).toBeDefined();
    expect(backlog.severity).toBe('WARNING');
  });

  it('raises NgdsBacklog on a large backlog even when no retry failed this run', () => {
    const alerts = buildRetryAlerts({ failed: 0, exhausted: 0, pendingRemaining: BACKLOG_THRESHOLD });
    expect(alerts.some(a => a.eventType === 'NgdsBacklog')).toBe(true);
  });

  it('does not raise NgdsBacklog just below threshold with no failures', () => {
    const alerts = buildRetryAlerts({ failed: 0, exhausted: 0, pendingRemaining: BACKLOG_THRESHOLD - 1 });
    expect(alerts.some(a => a.eventType === 'NgdsBacklog')).toBe(false);
  });

  it('can raise both alerts in one run', () => {
    const alerts = buildRetryAlerts({ failed: 5, exhausted: 1, pendingRemaining: 25 });
    expect(alerts.map(a => a.eventType).sort()).toEqual(['NgdsBacklog', 'NgdsSendExhausted']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/lib/ngds-retry.test.js`
Expected: FAIL — `buildRetryAlerts`/`BACKLOG_THRESHOLD` are not exported yet.

- [ ] **Step 3: Add the pure function to `srv/jobs/ngds-retry.js`**

At the top of the file (after the existing imports, before `export async function retryNgds`), add:

```js
// Alert-decision policy for a single retry run. Pure — no I/O — so the
// thresholds and severities are unit-testable in isolation. Thresholds are
// code constants by design (issue: NGDS silent-failure visibility).
export const BACKLOG_THRESHOLD = 20;

export function buildRetryAlerts({ failed = 0, exhausted = 0, pendingRemaining = 0 } = {}) {
  const alerts = [];
  if (exhausted > 0) {
    alerts.push({
      eventType: 'NgdsSendExhausted',
      severity: 'ERROR',
      subject: `NGDS: ${exhausted} message(s) permanently dropped`,
      body: `retryNgds marked ${exhausted} message(s) FAILED_PERMANENTLY this run; `
          + `${pendingRemaining} still pending. Their NGDS badge events are lost.`,
    });
  }
  if (failed > 0 || pendingRemaining >= BACKLOG_THRESHOLD) {
    alerts.push({
      eventType: 'NgdsBacklog',
      severity: 'WARNING',
      subject: `NGDS feed unhealthy: ${pendingRemaining} pending, ${failed} failed this run`,
      body: `retryNgds: failed=${failed}, exhausted=${exhausted}, pendingRemaining=${pendingRemaining}. `
          + `NGDS may be unreachable or misconfigured.`,
    });
  }
  return alerts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/lib/ngds-retry.test.js`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/ngds-retry.js test/lib/ngds-retry.test.js
git commit -m "feat(ngds): add pure buildRetryAlerts policy for retry-run alerts"
```

---

## Task 3: Wire alerts + gauges into `retryNgds`; remove dead `retryFailedMessages`

**Files:**
- Modify: `srv/jobs/ngds-retry.js` (imports + post-loop wiring)
- Modify: `srv/lib/ngds-client.js` (delete unused `retryFailedMessages`)
- Test: `test/lib/ngds-retry.test.js` (add a job-wiring test with mocked cds/alerting/metrics)

**Interfaces:**
- Consumes: `buildRetryAlerts` / `BACKLOG_THRESHOLD` (Task 2); `alerting.raise(input)` from `../lib/alerting.js` (fail-open, never throws); `metrics.gauge(name, value)` and `metrics.counter(name, n)` from `../lib/metrics.js`.
- Produces: `retryNgds(logId)` unchanged return `{ pending, retried, exhausted, failed }`, now with side-effect metrics + ANS alerts.

- [ ] **Step 1: Write the failing job-wiring test**

Append to `test/lib/ngds-retry.test.js`. This mirrors the mocking style in `test/lib/ngds-autosend.test.js` (stub `@sap/cds`, the ql globals, and sibling modules):

```js
import { vi, beforeEach, afterEach } from 'vitest';

const raiseSpy = vi.fn();
const gaugeSpy = vi.fn();
const counterSpy = vi.fn();
const sendSpy = vi.fn();

vi.mock('../../srv/lib/alerting.js', () => ({ raise: (...a) => raiseSpy(...a) }));
vi.mock('../../srv/lib/metrics.js', () => ({
  gauge: (...a) => gaugeSpy(...a),
  counter: (...a) => counterSpy(...a),
}));
vi.mock('../../srv/lib/pipeline-log.js', () => ({ logJobItem: vi.fn() }));

vi.mock('@sap/cds', () => ({
  default: {
    log: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    entities: () => ({ NGDSFailedMessages: { name: 'NGDSFailedMessages' } }),
    connect: { to: async () => ({ send: (...a) => sendSpy(...a) }) },
  },
}));

// Minimal ql globals used by retryNgds: SELECT.from(e).where(w) is awaited to a
// row array; UPDATE(e,id).set(o) and DELETE.from(e,id) resolve to undefined.
let pendingRows = [];
globalThis.SELECT = { from: () => ({ where: () => Promise.resolve(pendingRows) }) };
globalThis.UPDATE = () => ({ set: async () => undefined });
globalThis.DELETE = { from: async () => undefined };

describe('retryNgds wiring (alerts + gauges)', () => {
  let retryNgds;
  beforeEach(async () => {
    vi.resetModules();
    raiseSpy.mockReset(); gaugeSpy.mockReset(); counterSpy.mockReset(); sendSpy.mockReset();
    ({ retryNgds } = await import('../../srv/jobs/ngds-retry.js'));
  });
  afterEach(() => vi.clearAllMocks());

  it('raises ERROR + WARNING and gauges pending when a message exhausts retries', async () => {
    pendingRows = [
      { ID: 'a', payload: '{}', retryCount: 9, maxRetries: 10 }, // will exhaust after this fail
    ];
    sendSpy.mockRejectedValue(new Error('RBAC: access denied'));
    await retryNgds('log-1');
    const events = raiseSpy.mock.calls.map(c => c[0].eventType);
    expect(events).toContain('NgdsSendExhausted');
    expect(events).toContain('NgdsBacklog');
    expect(gaugeSpy).toHaveBeenCalledWith('ngds.failed_messages.pending', expect.any(Number));
  });

  it('raises no alert and gauges 0 pending when all sends succeed', async () => {
    pendingRows = [{ ID: 'b', payload: '{}', retryCount: 0, maxRetries: 10 }];
    sendSpy.mockResolvedValue(undefined); // 2xx, no throw
    await retryNgds('log-2');
    expect(raiseSpy).not.toHaveBeenCalled();
    expect(gaugeSpy).toHaveBeenCalledWith('ngds.failed_messages.pending', 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/lib/ngds-retry.test.js`
Expected: FAIL — `retryNgds` does not yet import metrics/alerting nor raise/gauge.

- [ ] **Step 3: Add imports to `srv/jobs/ngds-retry.js`**

At the top, alongside the existing imports:

```js
import * as metrics from '../lib/metrics.js';
import * as alerting from '../lib/alerting.js';
```

- [ ] **Step 4: Wire metrics + alerts after the loop**

In `retryNgds`, replace the final `return { pending: pending.length, retried, exhausted, failed };` with:

```js
  const pendingRemaining = pending.length - retried - exhausted;
  metrics.gauge('ngds.failed_messages.pending', pendingRemaining);
  if (failed > 0) metrics.counter('ngds.retry.failed', failed);
  if (exhausted > 0) metrics.counter('ngds.retry.exhausted', exhausted);
  for (const alert of buildRetryAlerts({ failed, exhausted, pendingRemaining })) {
    await alerting.raise({
      ...alert,
      category: 'ALERT',
      resource: { resourceName: 'ngds-retry', resourceType: 'job' },
    });
  }

  return { pending: pending.length, retried, exhausted, failed };
```

- [ ] **Step 5: Delete the dead `retryFailedMessages` from `srv/lib/ngds-client.js`**

Remove the entire `export async function retryFailedMessages() { … }` block (currently ~lines 256-281). It is never imported anywhere (`git grep retryFailedMessages` shows only its definition) and duplicates `retryNgds` without alerting — leaving it is a future silent-retry footgun. Do NOT touch `sendTaskRecordToNgds` or `postPayload`.

- [ ] **Step 6: Run tests — verify PASS**

Run: `npx vitest run --project unit test/lib/ngds-retry.test.js test/lib/ngds-client.test.js`
Expected: ALL pass. `ngds-client.test.js` only imports `buildNgdsPayload`/`formatNgdsDate`, so the deletion does not affect it.

- [ ] **Step 7: Verify nothing else imported the deleted function**

Run: `git grep -n "retryFailedMessages" -- srv test`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add srv/jobs/ngds-retry.js srv/lib/ngds-client.js test/lib/ngds-retry.test.js
git commit -m "feat(ngds): raise ANS alerts + queue gauges from retryNgds; drop dead retryFailedMessages"
```

---

## Task 4: Full-suite guard + PR

**Files:** none (verification only)

- [ ] **Step 1: Run the NGDS-touching unit tests together**

Run: `npx vitest run --project unit test/lib/ngds-autosend.test.js test/lib/ngds-retry.test.js test/lib/ngds-client.test.js test/integration/ngds-autosend-completion.test.js`
Expected: ALL pass. The integration test asserts on `NGDSFailedMessages` rows (not the counter), so the metric change does not affect it.

- [ ] **Step 2: Lint the changed files (project convention)**

Run: `npx eslint srv/lib/ngds-autosend.js srv/lib/ngds-client.js srv/jobs/ngds-retry.js test/lib/ngds-retry.test.js`
Expected: clean (fix any issues rather than disabling rules).

- [ ] **Step 3: Confirm LF line endings on edited/created files**

Run: `git diff --stat && file test/lib/ngds-retry.test.js`
Expected: no CRLF introduced.

- [ ] **Step 4: Push branch and open a DRAFT PR**

```bash
git push -u origin worktree-ngds-failure-visibility
gh pr create --draft --title "NGDS silent-failure visibility: truthful metric + retry-job alerts" \
  --body "Closes the observability gap behind the 2026-08-10 NGDS outage. See docs/superpowers/specs/2026-08-12-ngds-failure-visibility-design.md. Does NOT fix the destination/password issue (NGDS-side). Note: alerts require ChatSettings.alertsEnabled=true in PROD; the metric works regardless."
```

- [ ] **Step 5: Report** the PR URL and remind Tom of the two operational follow-ups: (a) verify `ChatSettings.alertsEnabled=true` in PROD, (b) backfill the 68 dropped records once the destination/password is fixed. MTA version bump + deploy are decided with Tom at deploy time (feature → minor per repo convention).

## Self-Review

**Spec coverage:** Change 1 (metric) → Task 1. Change 2 (retry-job alerts + gauges) → Tasks 2+3. `pendingRemaining`/thresholds/severities → Task 2. Dead-code check → Task 3. `alerting`/`ChatSettings.alertsEnabled` caveat → Task 4 report. Testing section → Tasks 1-4. All spec sections covered.

**Placeholder scan:** No TBD/TODO; every code step has literal code.

**Type consistency:** `buildRetryAlerts({ failed, exhausted, pendingRemaining })` and `BACKLOG_THRESHOLD` are defined in Task 2 and consumed with the same names/shape in Task 3. `sendTaskRecordToNgds` return `{ success }` used consistently in Task 1. Alert descriptor keys (`eventType`, `severity`, `subject`, `body`) match `alerting.raise`'s existing schema (`category`/`resource` added at the call site).
