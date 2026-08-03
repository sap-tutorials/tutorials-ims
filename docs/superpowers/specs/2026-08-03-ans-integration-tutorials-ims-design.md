# Design: SAP Alert Notification integration into tutorials-ims (via `cds-alert-notification` plugin)

**Date:** 2026-08-03
**Status:** Approved (design), pending spec review → implementation plan
**Repo:** tutorials-ims (local `tutorials-poc`)
**Plugin:** `@sap-devrel/cds-alert-notification` v1.0.0 (github.tools.sap/developer-relations/cds-alert-notification)
**Follows:** the plugin's own design spec §8/§9 (tutorials-ims = first consumer)

---

## 1. Goal

Push **operational alerts** from tutorials-ims to a DevRel on-call **email** distribution list when key failures occur, using the reusable `cds-alert-notification` CAP plugin. Today these failures are pull-only (metrics/logs/PipelineLog); nobody is told. This wires push notification into three real failure paths, **dark behind a flag**, so the subset of failures that need a human reach one.

## 2. Scope

**In (all three real emit sites — capability #1 of the plugin):**
1. **Publish-reject** — `srv/lib/content-publish-session.js:516` (beside `metrics.counter('publish.commit.reject')`).
2. **Scheduled-job failure** — `srv/jobs/scheduler.js:170-174` (`runWithLock` failure path — a single chokepoint covering **every** scheduled job).
3. **Rebuild-dispatch failure** — `srv/lib/rebuild-trigger.js:182` (the catch that currently only `console.error`s, not rethrown).

**Out (YAGNI / not applicable):**
- **Content-hash mismatch** — no server-side emit site exists in `srv/` (batch hash is returned to the client; verification is CI-side). Dropped.
- Platform-event monitoring subscriptions (plugin capability #2) — separate provisioning exercise.
- Admin-UI alert config surface.
- Actual deploy / flag flip / email-action binding — all post-merge, operator-owned.

## 3. Dependency & config

`package.json`:
- Dependency: `"@sap-devrel/cds-alert-notification": "github.tools.sap/developer-relations/cds-alert-notification#v1.0.0"`.
- New `cds.requires.alerts` block (mirrors the `telemetry` block's profile pattern):

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

**Node floor (BLOCKER to verify first):** the plugin requires **Node ≥22.12** (its ESM/CJS fix). First implementation step = verify tutorials-ims `engines.node` + CI Node version. If on Node 20, resolve before proceeding — this gates the whole integration.

`devrel-oncall` is a named channel; the real distribution-list address is bound in the ANS email **action** at provisioning (cockpit / `provision.sh`), not in code/config.

## 4. Provisioning (MTA)

`.deploy/mta.yaml` only (root is legacy). **Minor** version bump (feature).

```yaml
resources:
  - name: tutorials-alert-notification
    type: org.cloudfoundry.managed-service
    parameters:
      service: alert-notification
      service-plan: standard
# tutorials-srv module requires: tutorials-alert-notification
```

- **`srv-qa` cp-list audit:** the new `srv/lib/alerting.js` must be checked against `srv-qa`'s `cp` list. srv-qa doesn't wire alerting, so it should NOT need it — verify the transitive `./` import walk confirms this (missing transitive dep crashes QA boot).
- **MTA provisions the instance, NOT the email action.** The email action + subscription (the `devrel-oncall` address) is a **post-deploy step** (cockpit or generated `provision.sh`). Documented explicitly, not assumed.
- Plugin build-time generation emits into `gen/alerts/` — additive, confirm no interference with the existing MTA build.

## 5. App wiring

**Helper — `srv/lib/alerting.js`** (mirrors `metrics.js`: namespace import, never-throws, env kill-switch):

```js
import cds from '@sap/cds'
const isEnabled = () => process.env.ALERTS_ENABLED === 'true'
let svc
export async function raise(input) {
  if (!isEnabled()) return
  try {
    svc ??= await cds.connect.to('alerts')
    await svc.raise(input)
  } catch (e) { cds.log('alerting').warn('alert raise failed', e) }
}
```

**Three hooks** (each `import * as alerting from './alerting.js'`; alert sits beside the existing signal, never replaces it):

| Hook | Site | Envelope |
|------|------|----------|
| 1 | `content-publish-session.js:516` (when `outcome==='rejected'`) | `PublishRejected`, ERROR/ALERT, resource `{resourceName:'content-publish', resourceType:'service'}`, body names rejected slugs (`rejectedReverts`) |
| 2 | `scheduler.js:170-174` (`runWithLock` failure) | `ScheduledJobFailed`, ERROR/ALERT, resource `{resourceName: jobName, resourceType:'job'}`, body = errorMessage |
| 3 | `rebuild-trigger.js:182` (catch) | `RebuildDispatchFailed`, ERROR/ALERT, resource `{resourceName:'rebuild-dispatch', resourceType:'service'}`, body = error |

- **Dedup** (5-min window, keyed `eventType+resourceName`): a flapping job → one email per job per window.
- **Fail-open doubly guaranteed:** plugin never throws + helper try/catch. No hook can break publish/jobs/rebuild.
- **Hook 3 caveat:** `rebuild-trigger.js` uses `console.*` and runs in a debounced `setTimeout` (non-request context). Confirm `cds.connect.to('alerts')` resolves there; if fussy, it logs-and-continues (still fail-open).

## 6. Testing

**Unit (`npm test`, in-memory sink via `[test]` profile):**
- `alerting.js`: kill-switch off → no-op; on → routes to service; throwing service swallowed (fail-open).
- Each hook fires the right envelope: forced `outcome==='rejected'` → `PublishRejected`; job throwing in `runWithLock` → `ScheduledJobFailed` w/ `resourceName===jobName`; rebuild catch → `RebuildDispatchFailed`.
- **Guard existing tests:** run the full existing suite; fix any test that exercises these three failure paths and now sees a new signal (per the "service-layer write guard breaks pre-existing tests" gotcha). Update old tests, don't just add new.

**NOT proven by unit tests (live-verify, operator-owned post-merge):** that a real email lands. Requires instance provisioned + email action bound + real deploy + `ALERTS_ENABLED=true`. This is the plugin's one unverified path (`cds.outboxed()` + real ANS POST). Documented as the acceptance step; NOT done in this PR.

## 7. Delivery

- Feature branch off fresh `origin/main` (bg job → isolated worktree).
- `.deploy/mta.yaml` **minor** bump.
- `gh pr create --draft` — never direct-merge to main (even if told to).
- **No deploy from this PR.** Post-merge, operator: verify Node floor, provision instance, bind email action, deploy, flip `ALERTS_ENABLED`, live-verify one alert.

## 8. Open items to verify during implementation

- tutorials-ims Node version vs plugin's ≥22.12 floor (BLOCKER — verify first).
- `cds.connect.to('alerts')` resolves in `rebuild-trigger.js`'s `setTimeout` context.
- `srv-qa` cp-list does not need `alerting.js` (transitive import walk).
- Plugin `gen/alerts/` generation doesn't interfere with the MTA build.
- Whether `cds.requires.alerts` `channels`/`routes`/`eventTypes` keys are consumed at runtime by the plugin's client, or only by its build task — confirm against the installed plugin so the config block isn't carrying inert keys at the consumer.
