# Design: Deploy lifecycle alerts (start / end / fail) via `cds-alert-notification`

**Date:** 2026-08-04
**Status:** Approved (design), pending spec review → implementation plan
**Repo:** tutorials-ims (local `tutorials-poc`)
**Builds on:** [2026-08-03-ans-integration-tutorials-ims-design.md](2026-08-03-ans-integration-tutorials-ims-design.md) — the ANS/`cds-alert-notification` integration wired yesterday
**Plugin:** `@sap-tutorials/cds-alert-notification` v1.0.0 (already a dependency; `cds.requires.alerts` already configured)

---

## 1. Goal

Automatically notify the team when a deploy **starts**, **finishes**, or **fails**, reusing the ANS alerting plumbing already in place. Today a deploy is silent — the operator watches the terminal and nobody else knows. This adds a push signal at each deploy lifecycle boundary.

## 2. Why an endpoint (not a direct ANS call from the deploy script)

The Alert Notification credentials are bound to the **`tutorials-srv` CF app** (VCAP service binding). The deploy orchestrator (`scripts/deploy-mta.cjs`) runs on an operator workstation or CI runner — it has **no** ANS binding and cannot call the service directly. So the srv (which holds the binding) exposes an endpoint; the deploy script pings it.

Timing is sound: the **start** ping hits the *old* running srv instance; the **end** ping hits the freshly-restarted *new* instance. Both are live at call time.

## 3. Scope

**In:**
1. New Express route `POST /ops/deploy-event` on the srv, guarded by the existing `contentAuthMiddleware` (reuses `CONTENT_API_KEY`). Maps a `phase` to an `alerting.raise(...)` call. Fail-open.
2. `scripts/deploy-mta.cjs` fires the endpoint at three existing phase boundaries — **all envs** (dev/qa/prod), each targeting its own `srvUrl` from the ENV table.
3. `package.json` `cds.requires.alerts` — register the three new `eventTypes`, add one dedicated deploy channel + one route.
4. `.deploy/mta.yaml` — no new resource (the ANS resource already exists from yesterday); only the new channel's email **action** is provisioned operator-side.

**Out (YAGNI / operator-owned):**
- The real deploy-channel email address (bound in the ANS action at provisioning, not in code — same pattern as `devrel-oncall`).
- Flipping `ChatSettings.alertsEnabled` ON in each env (operator, via `/admin-ui`).
- Alerting on deploys triggered by paths *other* than `deploy-mta.cjs` (e.g. a raw `cf deploy`, or CI's `deploy.yml` if it bypasses this script — a follow-up can add the same three pings there).
- Blue-green nuance beyond §7.

## 4. Endpoint contract — `POST /ops/deploy-event`

Auth: `Authorization: Bearer <CONTENT_API_KEY>` via `contentAuthMiddleware`
(503 if key unset, 401 missing bearer, 403 wrong key — inherited behavior).

Request body (`application/json`):

```jsonc
{
  "phase":   "start" | "end" | "fail",   // required
  "env":     "dev" | "qa" | "prod",       // required — for subject/resourceName
  "version": "1.42.3",                     // optional — MTA version being deployed
  "detail":  "smoke gate failed"           // optional — free text, used on fail
}
```

Response: **always `202 Accepted`** with `{ ok: true }` on a well-formed request, **regardless of whether the alert actually raised** — alerting is fail-open and must never block or fail a deploy. `400` only for a malformed/absent `phase`. The handler `void`s the `alerting.raise(...)` (does not await it into the response path), matching the existing call sites.

Phase → payload mapping:

| phase   | eventType        | severity | subject                              |
|---------|------------------|----------|--------------------------------------|
| `start` | `DeployStarted`  | `NOTICE` | `Deploy started — <env> <version?>`  |
| `end`   | `DeployFinished` | `NOTICE` | `Deploy finished — <env> <version?>` |
| `fail`  | `DeployFailed`   | `ERROR`  | `Deploy FAILED — <env> <version?>`   |

All three set `category: 'ALERT'`, `resource: { resourceName: 'deploy-<env>', resourceType: 'deployment' }`, and `body` = `detail` (or a default). `resourceName` includes `<env>` so ANS dedup keys (`eventType:resourceName`) don't collapse a dev and prod deploy of the same phase within the 5-min window.

## 5. Routing / channel (severity-threshold model)

The plugin routes **only by severity threshold** (`resolveChannels(severity, cfg)` in `lib/routing.js`): an event is delivered to every route whose `minSeverity` it meets. There is **no** eventType-based routing and no per-`raise()` channel override. The ANS severity scale is `INFO / NOTICE / WARNING / ERROR / FATAL`.

> Note: the `Information / Success / Warning / Error` enum in `srv/lib/alert-enums.js` is the **visitor-banner** (`Alerts` entity) code list — unrelated to ANS severities. Do not conflate them.

Config (`package.json` `cds.requires.alerts`), extending yesterday's block:

```jsonc
"channels": [
  "email:devrel-oncall",
  "email:devrel-deploys"          // NEW — dedicated deploy channel
],
"routes": [
  { "minSeverity": "ERROR",  "channels": ["email:devrel-oncall"] },
  { "minSeverity": "NOTICE", "channels": ["email:devrel-deploys"] }   // NEW
],
"eventTypes": [
  "PublishRejected", "ScheduledJobFailed", "RebuildDispatchFailed",
  "DeployStarted", "DeployFinished", "DeployFailed"                   // NEW
]
```

Resulting delivery (**Option A**, chosen):
- `DeployStarted` / `DeployFinished` (NOTICE) → `email:devrel-deploys` **only**.
- `DeployFailed` (ERROR) → `email:devrel-deploys` **and** `email:devrel-oncall` (a failed deploy meets both thresholds — on-call *should* hear it).

`devrel-deploys` is a named channel; its real distribution-list address is bound in the ANS email **action** at provisioning (cockpit / `provision.sh`), exactly like `devrel-oncall`.

## 6. Deploy-script integration (`scripts/deploy-mta.cjs`)

A single helper `notifyDeploy(phase, cfg, extra)` that POSTs to `${cfg.srvUrl}/ops/deploy-event` with the bearer token from `process.env.CONTENT_API_KEY`, using native `fetch` with a short `AbortController` timeout (~5s). It is **fully best-effort**: any failure (no key, network error, non-2xx, timeout) is caught and logged as a `warn(...)` line — it NEVER calls `die()` and never changes the deploy exit code.

Fire points (mapping to the script's existing numbered steps):
- **start** — at the top of **Step 4**, immediately before `cf deploy` runs (real deploys only; skipped under `--dry-run`).
- **end** — after **Step 5**'s smoke gate passes (`ok('smoke tests passed…')` path). For **blue-green**, see §7.
- **fail** — on the `cf deploy` failure path (before/around `abortFailedBlueGreen()`), and on the smoke-gate failure path (before `process.exit(2)`). Passes `detail` describing which gate failed.

Guards: no ping under `--dry-run`. If `CONTENT_API_KEY` is absent from the operator env, `notifyDeploy` logs one `warn` and returns (deploy proceeds normally). Fires for **all three envs** — each posts to its own `srvUrl`.

## 7. Blue-green nuance

In `--strategy blue-green`, Step 4 brings up green apps then **pauses** before the traffic swap, and Step 5's automatic smoke gate is intentionally skipped (public routes still serve blue). So for blue-green:
- **start** fires normally before Step 4.
- **end** does NOT fire automatically (the script exits paused, pre-swap). The operator resumes the swap by hand later. v1 accepts this — a blue-green deploy simply won't emit an automatic "finished". (A later enhancement could ping "end" from the resume path, but that's outside this script's single invocation.) The paused-exit branch logs a `warn` noting no `end` alert will fire.
- **fail** still fires on a failed green bring-up.

This limitation is documented in the script's Step 5 blue-green branch and in the runbook note.

## 8. Error handling

- Endpoint: malformed `phase` → 400; everything else → 202. `alerting.raise` is already fail-open (never throws). The DB gate (`ChatSettings.alertsEnabled`, default OFF) still applies — if alerting is disabled, the endpoint still returns 202 but nothing is delivered. **Accepted edge case (confirmed by Tom):** a deploy that flips `alertsEnabled` can suppress its own `end`/`fail` ping.
- Deploy script: `notifyDeploy` swallows all errors → deploy behavior is byte-identical to today when alerting is down or misconfigured.

## 9. Testing

- **Unit** (`srv/lib/__tests__/` or `srv/routes/__tests__/`): mount the route on a bare Express app, stub `alerting.raise`; assert (a) 202 + `raise` called with the right eventType/severity per phase, (b) 400 on missing phase, (c) 401/403/503 auth behavior via `contentAuthMiddleware`, (d) 202 even when `raise` rejects (fail-open). Reuse the memory-sink pattern from yesterday's ANS tests where an end-to-end assert is wanted.
- **Deploy script**: `notifyDeploy` extracted as a testable pure-ish function (inject `fetch` + logger) — assert it never throws on network failure and never affects exit code. Guard: `--dry-run` sends nothing.
- No smoke-test change required (the endpoint is ops-internal, not user-facing).

## 10. Files touched

| File | Change |
|------|--------|
| `srv/routes/deploy-events.js` | **new** — the route + handler |
| `srv/server.js` | register the route (beside the other `/content/*` bearer routes) |
| `package.json` | add channel, route, 3 eventTypes to `cds.requires.alerts` |
| `scripts/deploy-mta.cjs` | `notifyDeploy` helper + 3 fire points |
| `srv/routes/__tests__/deploy-events.test.js` | **new** — unit tests |
| `.deploy/mta.yaml` | **minor** version bump (feature); no new resource |
| runbook (`docs/developers/operations/mta-deployment.md`) | note the new alerts + blue-green caveat + the `devrel-deploys` action provisioning step |

## 11. `srv-qa` cp-list check

`srv/routes/deploy-events.js` imports only `srv/lib/alerting.js` (already shipped) and no new `srv/lib/` transitive deps, so the `.deploy/mta.yaml` `srv-qa` `cp` list needs no change. **Verify during implementation** per the project rule (re-walk `./` imports).
