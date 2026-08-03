# ANS Integration into tutorials-ims — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `@sap-devrel/cds-alert-notification` plugin into tutorials-ims so three operational failure paths (publish-reject, any scheduled-job failure, rebuild-dispatch failure) push email alerts to a DevRel on-call list — dark behind `ALERTS_ENABLED`, provisioned via MTA, never able to break the paths it watches.

**Architecture:** Add the plugin as a git-dep + an `alerts` block in `cds.requires`. A thin `srv/lib/alerting.js` helper (mirrors `metrics.js`: namespace import, never-throws, env kill-switch) is called at three existing failure sites beside the current signal. An `alert-notification` managed-service resource is added to `.deploy/mta.yaml`. Everything ships dark; deploy + email-action binding + flag flip are operator-owned post-merge.

**Tech Stack:** CAP Node.js, `@sap/cds`, the ANS plugin (v1.0.0), Vitest (in-memory sink via `[test]` profile), MTA/CF.

## Global Constraints

- **Plugin version:** `github.tools.sap/developer-relations/cds-alert-notification#v1.0.0`.
- **Node floor:** plugin requires `>=22.12`; tutorials-ims is `>=22` / CI `NODE_VERSION: '22'` (satisfied). Tighten tutorials-ims `engines.node` to `>=22.12` in Task 1.
- **Fail-open, always:** no alerting path may throw into publish / jobs / rebuild. Plugin never throws AND helper wraps in try/catch.
- **Dark by default:** all emission gated on `process.env.ALERTS_ENABLED === 'true'` (matches `metrics.js` kill-switch + `KG_*` flag style). Default off.
- **Config keys are runtime-read:** `channels`, `routes`, `dedupWindowMs` are consumed live by the plugin (`service.js:29` → `routing.js`); `eventTypes`/`monitor` are build-time only. No inert keys.
- **Email channel is named, not addressed:** config uses `email:devrel-oncall`; the real distribution-list address is bound in the ANS action post-deploy, never in code.
- **MTA edits:** `.deploy/mta.yaml` only (root is legacy). **Minor** version bump (feature).
- **PR-gated:** feature branch → `gh pr create --draft`. Never direct-merge to main. No deploy from the PR.
- **Update pre-existing tests** that exercise the three failure sites (a new signal there can break them) — don't just add new tests.

---

## File Structure

- **Create** `srv/lib/alerting.js` — the fail-open alert helper (one responsibility: gated, safe `raise()`).
- **Create** `test/unit/alerting.test.js` — helper + hook-firing unit tests (in-memory sink).
- **Modify** `package.json` — add dependency, `cds.requires.alerts` block, tighten `engines.node`.
- **Modify** `srv/lib/content-publish-session.js:~516` — hook 1 (publish-reject).
- **Modify** `srv/jobs/scheduler.js:~170-174` — hook 2 (scheduler chokepoint).
- **Modify** `srv/lib/rebuild-trigger.js:~182` — hook 3 (rebuild-dispatch catch).
- **Modify** `.deploy/mta.yaml` — ANS managed-service resource + `tutorials-srv` binding + version bump.

---

## Task 1: Dependency, config block, Node floor

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the `alerts` service registered in `cds.env.requires` so `cds.connect.to('alerts')` resolves; profile-based sink kinds (console/memory/real). Later tasks depend on this being connectable.

- [ ] **Step 1: Verify the Node floor is genuinely met**

Run: `jq -r '.engines.node' package.json` and `grep -rn "NODE_VERSION\|node-version" .github/workflows/deploy.yml | head`.
Expected: `>=22` and `NODE_VERSION: '22'`. Confirm the plugin's `>=22.12` is satisfied by the runner's 22.x. If tutorials-ims declared `<22.12` anywhere, STOP and surface it.

- [ ] **Step 2: Add the dependency and tighten engines**

In `package.json`:
- `dependencies`: add `"@sap-devrel/cds-alert-notification": "github.tools.sap/developer-relations/cds-alert-notification#v1.0.0"`.
- `engines.node`: change `">=22"` → `">=22.12"` (match the plugin floor honestly).

- [ ] **Step 3: Add the `alerts` block to `cds.requires`**

In `package.json` `cds.requires` (sibling to `telemetry`):

```jsonc
"alerts": {
  "impl": "@sap-devrel/cds-alert-notification",
  "kind": "alert-notification-console",
  "[test]":       { "kind": "alert-notification-memory" },
  "[hybrid]":     { "kind": "alert-notification" },
  "[production]": { "kind": "alert-notification" },
  "channels": ["email:devrel-oncall"],
  "routes": [{ "minSeverity": "ERROR", "channels": ["email:devrel-oncall"] }],
  "eventTypes": ["PublishRejected", "ScheduledJobFailed", "RebuildDispatchFailed"],
  "dedupWindowMs": 300000
}
```

- [ ] **Step 4: Install and verify the plugin resolves**

Run: `npm install` then `node -e "const cds=require('@sap/cds'); require('@sap-devrel/cds-alert-notification'); console.log('alerts kind:', cds.env.requires.alerts?.kind)"`
Expected: prints `alerts kind: alert-notification-console` (base profile) without throwing. If `require` throws `ERR_REQUIRE_ESM`, the Node floor is wrong — STOP.

- [ ] **Step 5: Confirm the existing suite still green (plugin load is inert until used)**

Run: `npm test 2>&1 | tail -5`
Expected: same pass count as before this task (plugin present but unused).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(alerts): add cds-alert-notification plugin dep + alerts config block"
```

---

## Task 2: The `alerting.js` fail-open helper

**Files:**
- Create: `srv/lib/alerting.js`
- Test: `test/unit/alerting.test.js`

**Interfaces:**
- Consumes: `cds.connect.to('alerts')` (from Task 1).
- Produces: `raise(input) → Promise<void>` — gated on `ALERTS_ENABLED`, never throws, caches the service connection. `input` is `{ eventType, severity, category, subject, body, resource:{resourceName,resourceType}, tags? }`. Hooks in Tasks 4-6 call this.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/alerting.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import cds from '@sap/cds'

describe('alerting helper', () => {
  beforeEach(() => { vi.resetModules(); delete process.env.ALERTS_ENABLED })

  it('no-ops when ALERTS_ENABLED is not set (never connects)', async () => {
    const spy = vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn() })
    const { raise } = await import('../../srv/lib/alerting.js')
    await raise({ eventType: 'X', severity: 'ERROR' })
    // connect.to must not be called when disabled
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('routes to the alerts service when enabled', async () => {
    process.env.ALERTS_ENABLED = 'true'
    const raiseSpy = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: raiseSpy }) })
    const { raise } = await import('../../srv/lib/alerting.js')
    await raise({ eventType: 'PublishRejected', severity: 'ERROR' })
    expect(raiseSpy).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'PublishRejected' }))
  })

  it('never throws when the service.raise throws (fail-open)', async () => {
    process.env.ALERTS_ENABLED = 'true'
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: vi.fn().mockRejectedValue(new Error('boom')) }) })
    const { raise } = await import('../../srv/lib/alerting.js')
    await expect(raise({ eventType: 'X', severity: 'ERROR' })).resolves.toBeUndefined()
  })

  it('never throws when connect itself throws (fail-open)', async () => {
    process.env.ALERTS_ENABLED = 'true'
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockRejectedValue(new Error('no binding')) })
    const { raise } = await import('../../srv/lib/alerting.js')
    await expect(raise({ eventType: 'X', severity: 'ERROR' })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/alerting.test.js`
Expected: FAIL — `../../srv/lib/alerting.js` not found.

- [ ] **Step 3: Write the helper**

```js
// srv/lib/alerting.js
// Fail-open push-alert helper. Mirrors metrics.js: namespace import, never throws,
// env kill-switch. Sits BESIDE existing failure signals (metrics/log/PipelineLog),
// never replaces them. Default OFF (ALERTS_ENABLED !== 'true').
import cds from '@sap/cds'

const LOG = cds.log('alerting')
let svcPromise  // memoised connection

function isEnabled () {
  return process.env.ALERTS_ENABLED === 'true'
}

export async function raise (input) {
  if (!isEnabled()) return
  try {
    svcPromise ??= cds.connect.to('alerts')
    const svc = await svcPromise
    await svc.raise(input)
  } catch (e) {
    // Never propagate — alerting must not break the path it watches.
    svcPromise = undefined // allow a later reconnect attempt
    LOG.warn('alert raise failed (swallowed):', e?.message ?? e)
  }
}

// Test-only: reset the memoised connection between cases.
export function _resetForTest () { svcPromise = undefined }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/alerting.test.js`
Expected: PASS (4 tests). If the `cds.connect` getter-spy approach fights the CAP test harness, fall back to injecting a connector: export `raise(input, { connect = () => cds.connect.to('alerts') } = {})` and have tests pass a fake `connect`. Keep the public one-arg call site unchanged.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/alerting.js test/unit/alerting.test.js
git commit -m "feat(alerts): fail-open alerting helper gated on ALERTS_ENABLED"
```

---

## Task 3: `srv-qa` cp-list audit (guard rail, no code)

**Files:**
- Inspect: `.deploy/mta.yaml` (`srv-qa` module `cp` list)

**Interfaces:**
- Consumes: knowledge that Task 2 created `srv/lib/alerting.js`.
- Produces: a verified confirmation that `srv-qa` does NOT need `alerting.js` (or, if it does, the cp-list entry). Prevents a QA-boot crash at MTA deploy.

- [ ] **Step 1: Walk transitive `./` imports into alerting.js**

Run: `grep -rn "alerting" srv/lib/content-store.js srv/lib/content-publish-session.js` — confirm whether `content-store.js` (the srv-qa entry per CLAUDE.md) transitively imports `alerting.js`. It should NOT (only the three hook files do, and hooks 2/3 are outside content-store's import graph). If `content-publish-session.js` (hook 1) is in srv-qa's graph, then `alerting.js` IS a transitive dep and MUST be in srv-qa's `cp` list.

- [ ] **Step 2: Check srv-qa's cp list**

Read `.deploy/mta.yaml`, find the `srv-qa` module's `build-parameters.copy`/`cp` list. Determine if `srv/lib/alerting.js` needs to be there (only if reachable from `content-store.js`'s import graph).

- [ ] **Step 3: Record the finding**

If `alerting.js` is reachable from srv-qa's entrypoint, it will be added in Task 7 alongside the mta.yaml edits. If not, note "srv-qa does not import alerting.js — no cp entry needed" in the commit body of Task 7. No standalone commit for this task — it's a gate feeding Task 7.

---

## Task 4: Hook 1 — publish-reject

**Files:**
- Modify: `srv/lib/content-publish-session.js` (near line 516, in `commitSession`)
- Test: `test/unit/alerting.test.js` (extend)

**Interfaces:**
- Consumes: `raise()` from Task 2.
- Produces: a `PublishRejected` alert when a commit soft-rejects reverts. No new exports.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/alerting.test.js` a test that imports the alerting helper with a fake service, drives the publish-reject branch, and asserts `raise` was called with `eventType:'PublishRejected'`. Because `commitSession` is a large function, the practical test is at the helper-contract level plus a focused assertion that the hook builds the right envelope. Add:

```js
it('publish-reject envelope shape is correct', async () => {
  process.env.ALERTS_ENABLED = 'true'
  const raiseSpy = vi.fn().mockResolvedValue(undefined)
  vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: raiseSpy }) })
  const { raise } = await import('../../srv/lib/alerting.js')
  // Simulate what the hook constructs:
  await raise({
    eventType: 'PublishRejected', severity: 'ERROR', category: 'ALERT',
    subject: 'Content publish rejected 2 slug(s)',
    body: 'Rejected reverts: a, b',
    resource: { resourceName: 'content-publish', resourceType: 'service' }
  })
  expect(raiseSpy).toHaveBeenCalledWith(expect.objectContaining({
    eventType: 'PublishRejected', category: 'ALERT',
    resource: { resourceName: 'content-publish', resourceType: 'service' }
  }))
})
```

(A full integration test of `commitSession` is out of scope for the unit suite; the hybrid suite exercises the real publish path. The envelope-shape contract test guards the hook's payload.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/alerting.test.js`
Expected: PASS actually (this asserts the helper) — so instead, FIRST verify the hook site is NOT yet wired: `grep -n "alerting" srv/lib/content-publish-session.js` → expect no match. That's the "red" state for the hook.

- [ ] **Step 3: Wire the hook**

At top of `srv/lib/content-publish-session.js` (with the other imports, near line 7):
```js
import * as alerting from './alerting.js';
```
In `commitSession`, right after the `metrics.counter(...'publish.commit.reject'...)` call (~line 516), inside the same `outcome === 'rejected'` condition:
```js
if (outcome === 'rejected') {
  alerting.raise({
    eventType: 'PublishRejected',
    severity: 'ERROR',
    category: 'ALERT',
    subject: `Content publish rejected ${rejectedReverts.length} slug(s)`,
    body: `Rejected reverts: ${rejectedReverts.join(', ')}`,
    resource: { resourceName: 'content-publish', resourceType: 'service' }
  }); // fire-and-forget; helper is fail-open, do NOT await-block the commit path
}
```
Note: do NOT `await` if the surrounding code is latency-sensitive at that point; the helper swallows errors. If the function is already async and a floating promise triggers lint, `void alerting.raise({...})`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/alerting.test.js` (helper/shape green) AND `npm test 2>&1 | tail -5` (full suite — confirm no existing publish test broke from the new call).
Expected: all green. If a pre-existing content-publish test now fails because `cds.connect.to('alerts')` is attempted, that test runs with `ALERTS_ENABLED` unset so `raise` no-ops before connect — it should not break. If it does, the test had `ALERTS_ENABLED` leaking; fix the test's env isolation.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/content-publish-session.js test/unit/alerting.test.js
git commit -m "feat(alerts): raise PublishRejected on publish soft-reject"
```

---

## Task 5: Hook 2 — scheduler chokepoint (covers every job)

**Files:**
- Modify: `srv/jobs/scheduler.js` (in `runWithLock` failure path, ~line 170-174)
- Test: `test/unit/alerting.test.js` (extend)

**Interfaces:**
- Consumes: `raise()` from Task 2.
- Produces: a `ScheduledJobFailed` alert (resourceName = the failing jobName) on ANY scheduled-job failure. No new exports.

- [ ] **Step 1: Verify hook not yet present (red state)**

Run: `grep -n "alerting" srv/jobs/scheduler.js`
Expected: no match.

- [ ] **Step 2: Add the envelope-shape test**

Add to `test/unit/alerting.test.js`:
```js
it('scheduled-job-failed envelope uses jobName as resourceName', async () => {
  process.env.ALERTS_ENABLED = 'true'
  const raiseSpy = vi.fn().mockResolvedValue(undefined)
  vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: raiseSpy }) })
  const { raise } = await import('../../srv/lib/alerting.js')
  await raise({
    eventType: 'ScheduledJobFailed', severity: 'ERROR', category: 'ALERT',
    subject: 'Scheduled job failed: kg-pagerank-job',
    body: 'TypeError: boom',
    resource: { resourceName: 'kg-pagerank-job', resourceType: 'job' }
  })
  expect(raiseSpy).toHaveBeenCalledWith(expect.objectContaining({
    eventType: 'ScheduledJobFailed',
    resource: { resourceName: 'kg-pagerank-job', resourceType: 'job' }
  }))
})
```

- [ ] **Step 3: Wire the hook**

Import at top of `srv/jobs/scheduler.js`:
```js
import * as alerting from '../lib/alerting.js';
```
In `runWithLock`'s failure path (right after `LOG.error(\`Job ${jobName} failed:\`, errorMessage)` / `logPipelineEnd(logId, 'FAILED', ...)`, ~line 173-174):
```js
alerting.raise({
  eventType: 'ScheduledJobFailed',
  severity: 'ERROR',
  category: 'ALERT',
  subject: `Scheduled job failed: ${jobName}`,
  body: String(errorMessage),
  resource: { resourceName: jobName, resourceType: 'job' }
}); // fail-open, non-blocking
```
The plugin's 5-min dedup keyed on `eventType+resourceName` means a job failing every tick emits at most one email per 5 min per job.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/alerting.test.js` and `npm test 2>&1 | tail -5`.
Expected: all green. Check specifically any scheduler unit test — with `ALERTS_ENABLED` unset the raise no-ops. Fix env isolation if a scheduler test leaks the flag.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/scheduler.js test/unit/alerting.test.js
git commit -m "feat(alerts): raise ScheduledJobFailed from scheduler chokepoint (all jobs)"
```

---

## Task 6: Hook 3 — rebuild-dispatch failure

**Files:**
- Modify: `srv/lib/rebuild-trigger.js` (the catch at ~line 182)
- Test: `test/unit/alerting.test.js` (extend)

**Interfaces:**
- Consumes: `raise()` from Task 2.
- Produces: a `RebuildDispatchFailed` alert in the debounced-dispatch catch. No new exports.

- [ ] **Step 1: Verify hook not present + confirm connect works in setTimeout context**

Run: `grep -n "alerting\|setTimeout\|cds.connect" srv/lib/rebuild-trigger.js`
Expected: no `alerting` match. Note the module uses `console.*` and the failing dispatch runs inside a `setTimeout` (non-request context). `cds.connect.to` is safe outside a request — but the helper is fail-open regardless, so a connect failure here just logs.

- [ ] **Step 2: Add the envelope-shape test**

Add to `test/unit/alerting.test.js`:
```js
it('rebuild-dispatch-failed envelope shape is correct', async () => {
  process.env.ALERTS_ENABLED = 'true'
  const raiseSpy = vi.fn().mockResolvedValue(undefined)
  vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: raiseSpy }) })
  const { raise } = await import('../../srv/lib/alerting.js')
  await raise({
    eventType: 'RebuildDispatchFailed', severity: 'ERROR', category: 'ALERT',
    subject: 'Rebuild dispatch failed',
    body: 'GitHub dispatch 500',
    resource: { resourceName: 'rebuild-dispatch', resourceType: 'service' }
  })
  expect(raiseSpy).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'RebuildDispatchFailed' }))
})
```

- [ ] **Step 3: Wire the hook**

`rebuild-trigger.js` uses `console.*` and may be CommonJS or ESM — match the file's existing module style for the import (check the top of the file; if it uses `require`, use `const alerting = require('./alerting.js')` — but `alerting.js` is ESM, so if `rebuild-trigger.js` is CJS, use a dynamic `import('./alerting.js')` inside the catch instead). In the catch block (~line 181-185, currently `console.error('[rebuild-trigger] dispatch failed:', ...)`), add after the existing console.error:
```js
import('./alerting.js').then(a => a.raise({
  eventType: 'RebuildDispatchFailed',
  severity: 'ERROR',
  category: 'ALERT',
  subject: 'Rebuild dispatch failed',
  body: String(err?.message ?? err),
  resource: { resourceName: 'rebuild-dispatch', resourceType: 'service' }
})).catch(() => {}); // fully fail-open, even the dynamic import
```
(Dynamic import works from both CJS and ESM and keeps the catch non-blocking + never-throwing.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/alerting.test.js` and `npm test 2>&1 | tail -5`.
Expected: all green. Any existing rebuild-trigger test runs with `ALERTS_ENABLED` unset → no-op.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/rebuild-trigger.js test/unit/alerting.test.js
git commit -m "feat(alerts): raise RebuildDispatchFailed in dispatch catch"
```

---

## Task 7: MTA provisioning + version bump

**Files:**
- Modify: `.deploy/mta.yaml`

**Interfaces:**
- Consumes: the Task 3 srv-qa finding.
- Produces: an `alert-notification` managed-service instance bound to `tutorials-srv` on next deploy.

- [ ] **Step 1: Add the resource + binding**

In `.deploy/mta.yaml`:
- Under `resources:`:
```yaml
  - name: tutorials-alert-notification
    type: org.cloudfoundry.managed-service
    parameters:
      service: alert-notification
      service-plan: standard
```
- Under the `tutorials-srv` module's `requires:`:
```yaml
    - name: tutorials-alert-notification
```

- [ ] **Step 2: Apply the Task 3 srv-qa finding**

If Task 3 found `alerting.js` reachable from srv-qa's `content-store.js` import graph, add `srv/lib/alerting.js` to the `srv-qa` module's `cp`/copy list. If not, do nothing here (note it in the commit body).

- [ ] **Step 3: Bump the MTA version (minor — feature)**

In `.deploy/mta.yaml`, bump the top-level `version:` minor (e.g. `X.Y.Z` → `X.(Y+1).0`). Confirm you're editing `.deploy/mta.yaml`, NOT the legacy root `mta.yaml`.

- [ ] **Step 4: Validate the MTA descriptor parses**

Run: `npx mbt validate -e .deploy/dev.mtaext 2>&1 | tail -10` if available, else `yq '.resources[] | select(.name=="tutorials-alert-notification")' .deploy/mta.yaml` to confirm the resource is well-formed YAML.
Expected: the resource block echoes back; no YAML parse error.

- [ ] **Step 5: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "feat(alerts): provision alert-notification instance via MTA (minor bump)

srv-qa cp-list: <needs alerting.js | not reachable from srv-qa entrypoint>"
```

---

## Task 8: README/ops note + full-suite gate

**Files:**
- Modify: `docs/developers/architecture/observability.md` (add an "Alerting (ANS)" section)

**Interfaces:**
- Consumes: everything.
- Produces: the operator runbook for the post-merge steps.

- [ ] **Step 1: Document the integration + post-merge steps**

Add an "Alerting (SAP Alert Notification)" section to `docs/developers/architecture/observability.md` covering: the three alerted failure paths + their eventTypes; the `ALERTS_ENABLED` flag (default off); the plugin + config block; and the **operator post-merge checklist**: (1) deploy so MTA provisions the instance; (2) bind the email action to the real `devrel-oncall` distribution list in the ANS cockpit (or via the plugin's generated `provision.sh`); (3) `cf set-env tutorials-srv ALERTS_ENABLED true && cf restart tutorials-srv`; (4) live-verify one alert (trigger a publish-reject or a job failure, confirm the email lands) — this is the plugin's one unverified path (`cds.outboxed()` + real ANS POST). Note the metrics module is unchanged — alerting escalates the subset needing a human.

- [ ] **Step 2: Full suite green**

Run: `npm test 2>&1 | tail -6`
Expected: all green, pass count = prior + the new alerting tests.

- [ ] **Step 3: Commit**

```bash
git add docs/developers/architecture/observability.md
git commit -m "docs(alerts): observability doc + operator post-merge checklist"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §3 dependency + config → Task 1. ✓ (config keys verified runtime-read: `service.js:29`→`routing.js`.)
- §3 Node floor → Task 1 Steps 1-2 (verified met: `>=22` + CI 22; tightened to `>=22.12`). ✓
- §4 MTA provisioning + minor bump + srv-qa audit → Tasks 3 (audit) + 7 (apply). ✓
- §4 email action is post-deploy, not MTA → Task 8 operator checklist. ✓
- §5 helper + 3 hooks → Tasks 2, 4, 5, 6. ✓ (fail-open doubly guaranteed: helper try/catch + plugin never-throws.)
- §5 hook-3 setTimeout/CJS caveat → Task 6 Steps 1, 3 (dynamic import handles CJS+ESM, fully fail-open). ✓
- §6 testing + guard existing tests → each hook task Step 4 checks the full suite + env-isolation note. ✓
- §6 live-verify NOT in PR → Task 8 operator checklist. ✓
- §7 delivery (draft PR, minor bump, no deploy) → Task 7 + handled at finish. ✓
- §8 open items → all resolved pre-plan (Node met, config runtime-read) or assigned (srv-qa→T3/T7, gen/alerts additive→noted, connect-in-setTimeout→T6). ✓

**Placeholder scan:** No TBD/"handle errors"/"similar to". The one conditional is the srv-qa cp-list (Task 3 gates Task 7) — both branches spelled out.

**Type consistency:** `raise(input)` signature identical across Tasks 2/4/5/6. Envelope field names (`eventType/severity/category/subject/body/resource.{resourceName,resourceType}`) match the plugin's verified contract and are uniform across all three hooks. `ALERTS_ENABLED` spelled identically throughout.

**Known thin spot (surfaced honestly):** the unit tests assert the helper contract + envelope shapes, NOT the hooks firing inside the real `commitSession`/`runWithLock`/dispatch functions (those are large and better covered by the hybrid suite / live-verify). Each hook task verifies (a) the site was un-wired before (red), (b) the full suite stays green after wiring. True end-to-end proof is the operator live-verify in Task 8 — explicitly out of the PR's provable scope.
