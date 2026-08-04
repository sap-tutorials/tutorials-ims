# Design: Admin UI action to send a test alert (#1469)

**Date:** 2026-08-04
**Issue:** [#1469](https://github.com/sap-tutorials/tutorials-ims/issues/1469)
**Related:** #1468 (add `alertsEnabled` toggle to Joule Settings admin UI) — folded into this PR.

## Problem

There is no way to verify the ANS alerting **code path** (`srv/lib/alerting.js` `raise()` → dedup → routing → `cds.outboxed()` → ANS POST) end-to-end without forcing a real operational failure (publish soft-reject, scheduled-job throw, or rebuild-dispatch failure). The cockpit's test-event button and a direct producer-API POST both bypass our code entirely.

## Ask

Add an **admin-only "Send test alert" action** that invokes `alerting.raise(...)` with a clearly-marked TEST envelope, surfaced as a button on the Joule Settings admin page, and report the outcome back to the admin (delivered / disabled / error) so the test is actually informative.

## Design

### 1. New `raiseTest()` helper in `srv/lib/alerting.js`

The existing `raise()` swallows every outcome and returns `undefined` — it cannot distinguish delivered from deduped from disabled from errored. That is correct for the fail-open hook path (which must never surface anything) but useless for an on-demand test.

Add a **sibling** `raiseTest(input)` that:

- Returns a structured, non-throwing result: `{ outcome: 'delivered' | 'disabled' | 'error', reason?: string }`.
  - `disabled` — `isAlertingEnabled()` returned false (doubles as an "is alerting on?" check).
  - `delivered` — the alerts service `raise()` resolved without throwing.
  - `error` — connect or `raise()` threw; `reason` carries `e.message`.
- Never throws (mirrors `raise()`'s fail-open contract) — all faults are captured into the `error` result instead of propagating.
- Resets the memoised `svcPromise` on error, same as `raise()`, to allow a later reconnect.

`raise()` is left byte-for-byte unchanged — the three production hooks keep their exact current behavior. `raiseTest()` reuses the same memoised `svcPromise` connection.

> **Dedup caveat:** the plugin dedups on `${eventType}:${resourceName}` within `dedupWindowMs` (5 min). The dedup happens **inside** the alerts service `raise()`, which returns `undefined` whether it delivered or silently deduped. `raiseTest()` therefore cannot itself observe a dedup drop. We avoid the problem at the source: the **caller** (the action handler) passes a **unique `resourceName` per click** (see §3), so no two test clicks ever collide in the dedup window and every click actually fires. `raiseTest()`'s `delivered` outcome thus means "handed to the sink without error," which — given the unique resourceName — is a true delivery.

### 2. New `AlertingTest` eventType

Add `'AlertingTest'` to `cds.requires.alerts.eventTypes` in `package.json`:

```json
"eventTypes": ["PublishRejected", "ScheduledJobFailed", "RebuildDispatchFailed", "AlertingTest"]
```

This makes `cds build` generate a matching ANS condition (`cond-AlertingTest`) in `ans-conditions.json`, so ops can route or silence test events **separately** from real incidents. Custom-eventType subscriptions route to all top-level `channels` (per the plugin README), i.e. `email:devrel-oncall`.

**Ops action (documented, not code):** for the test alert to actually reach an inbox, the `AlertingTest` condition must be wired to a subscription in the ANS cockpit for the target env, exactly like the three existing eventTypes. This is noted in the observability doc so the PROD-rollout operator sets it up. If the condition/subscription is absent, `raiseTest()` still reports `delivered` (our code did its job) but no email arrives — which is itself a useful signal that the ANS-side wiring is missing.

### 3. New `sendTestAlert` bound action on `AdminService.ChatSettings`

Natural home: the `ChatSettings` singleton already carries `seedEmbeddings` / `seedConceptEmbeddings` bound actions and is `@odata.singleton @requires: 'Admin'`. Mounting `sendTestAlert` here (rather than on `JobControls`) keeps it co-located with `alertsEnabled` and the Joule Settings page that edits `ChatSettings`.

**CDS** (`srv/admin-service.cds`, inside the `ChatSettings ... actions { }` block):

```cds
// #1469: admin-triggered end-to-end ANS test. Invokes alerting.raiseTest()
// with a TEST-marked envelope (eventType 'AlertingTest'). No-ops (outcome
// 'disabled') when ChatSettings.alertsEnabled is false, so it doubles as an
// "is alerting on?" probe. severity defaults to ERROR (matches the real
// hooks + the minSeverity:ERROR route).
action sendTestAlert(severity: String) returns {
  outcome  : String;   // 'delivered' | 'disabled' | 'error'
  reason   : String;   // populated on 'error' (or 'disabled' explainer)
  eventType: String;   // 'AlertingTest'
  severity : String;   // effective severity used
};
```

**Handler** (`srv/admin-service.js`, `this.on('sendTestAlert', 'ChatSettings', ...)`):

- Auth: inherited `@requires: 'Admin'` at the entity/service level (no extra gate — same posture as `seedEmbeddings`). Admin **and** SuperAdmin both hold `Admin` scope.
- Validate/normalize `severity`: accept the ANS severities (`INFO`, `NOTICE`, `WARNING`, `ERROR`, `FATAL`); anything else → default `ERROR`. (The plugin also coerces unknown severities to ERROR, so this is belt-and-suspenders.)
- Build a **unique** `resourceName` per invocation: `admin-test:<user>:<ISO-timestamp>` (uniqueness dodges the 5-min dedup window so every click fires). Include the user id for audit trace.
- Call `raiseTest({ eventType: 'AlertingTest', severity, category: 'ALERT', subject: '[TEST] Admin-triggered alert', body: 'Manual end-to-end verification of the ANS alerting path. Not a real incident. Triggered by <user> at <ts>.', resource: { resourceName, resourceType: 'service' }, tags: { 'ans:correlationId': 'admin-test' } })`.
- Emit a fire-and-forget `SecurityEvent` audit row via the existing `auditEvent('alerting.test-alert', { user, outcome, severity })` closure (mirrors the `seedApiDocs` audit pattern), so the manual trigger shows in the audit trail. Audit failure never fails the action.
- Return the `raiseTest()` result augmented with `eventType` and effective `severity`.

Because `Date.now()`/`new Date()` are used only in the **runtime handler** (not a workflow script), there is no restriction here.

### 4. Joule Settings UI — new "Operational Alerting" panel

`app/admin/joule/webapp/` (auto-copied to `dist/components/joule/` by `copy-components.js` at `mbt build`). Add a panel to `view/Settings.view.xml`, wire two things in `controller/Settings.controller.js`, and add i18n keys.

**Panel** (placed near the top, after the General panel — alerting is an operational master switch, not a Joule-feature toggle):

```xml
<Panel headerText="{i18n>alertingSection}" expandable="true" expanded="true" class="sapUiSmallMarginBottom">
  <f:SimpleForm editable="true" layout="ResponsiveGridLayout">
    <Label text="{i18n>alertsEnabled}" />
    <Switch state="{settings>/alertsEnabled}" />
    <Label text="" />
    <Text text="{i18n>alertsEnabledHelp}" wrapping="true" class="sapUiTinyMarginBottom" />
  </f:SimpleForm>
  <Toolbar>
    <Button text="{i18n>sendTestAlertButton}" press=".onSendTestAlert" type="Default"
            enabled="{settings>/alertsEnabled}" />
  </Toolbar>
  <Text text="{i18n>sendTestAlertHelp}" wrapping="true" class="sapUiSmallMargin" />
</Panel>
```

- **`alertsEnabled` Switch** — closes #1468. Add `alertsEnabled: false` to the `onInit` JSONModel default, read it in `_loadSettings` (`!!data.alertsEnabled`), and include `alertsEnabled: !!data.alertsEnabled` in the `onSave` PATCH body. This threads through the **existing** save/reload flow — no new endpoint.
- **Button** disabled when `alertsEnabled` is off (visual reinforcement); the handler still reports `disabled` defensively if somehow clicked while off (e.g. unsaved toggle).

**`onSendTestAlert`** controller method — mirrors `onSeedConceptEmbeddings` exactly (CSRF fetch → POST to the bound action → parse `{value}`-or-flat → toast). POSTs to `/admin/ChatSettings/AdminService.sendTestAlert` with `{}` (severity defaults server-side). Maps the outcome to a message:
  - `delivered` → `MessageToast` "Test alert sent to ANS (eventType AlertingTest). Check the devrel-oncall inbox."
  - `disabled` → `MessageBox.warning` "Alerting is disabled — enable and Save first, then retry."
  - `error` → `MessageBox.error` with `reason`.

> **Save-then-test ordering gotcha (documented in help text):** the `alertsEnabled` toggle only takes effect after **Save** (it PATCHes the DB row, which the server-side `isAlertingEnabled()` resolver reads with a 5-second cache). Flipping the switch and immediately clicking the button without saving will report `disabled`. The `sendTestAlertHelp` text says "Save any change to Alerting enabled before sending a test." No client-side coupling of the two buttons — kept simple.

### 5. Docs

Update `docs/developers/architecture/observability.md`:
- Add `AlertingTest` to the eventTypes list + the config snippet.
- New subsection "Testing the alert path": describes the admin button, the `raiseTest()` outcome semantics, the unique-resourceName-avoids-dedup detail, and the ops requirement to wire an `AlertingTest` ANS condition/subscription per env.

## Testing

- **Unit** (`test/unit/alerting.test.js`): extend with `raiseTest()` cases — `delivered` when enabled + sink ok; `disabled` when resolver false (and asserts `connect.to` never called); `error` (+reason) when connect throws and when sink `raise` throws; confirms `raiseTest` never throws.
- **Unit** (new or existing admin-service test): `sendTestAlert` handler — severity normalization (unknown → ERROR), unique resourceName shape, outcome passthrough, audit fire-and-forget. Use the project's `cds.test('serve', '--project', '.', '--in-memory')` bootstrap (per the memory note; `cds.deploy(cds.model)` is broken here) with the `alert-notification-memory` sink asserting the envelope.
- **Manual/e2e** (post-deploy, per Tom's #1 rule): on DEV, open `/admin-ui/#joule`, enable Alerting, Save, click **Send test alert**, confirm the `delivered` toast, then confirm the email in the devrel-oncall inbox (or the console-sink log on a console-kind env). A committed `test/e2e/` spec is advisory-nudged for the `app/admin/**` change (#1378 pattern) — add a spec that loads the Joule Settings page and asserts the button + switch render and the button click yields a toast.

## Out of scope / non-goals

- No `severity` picker in the UI (param exists on the action for API callers; UI always sends default ERROR).
- No change to `raise()` or the three production hook sites.
- No new persisted entity — the test is stateless beyond its audit row.
- Wiring the actual ANS `AlertingTest` condition→subscription is an **ops** step (documented), not code.

## Deploy

Admin-UI change → **full** `npm run deploy -- --env <env>` (NO `--skip-build`, NO `-m` scoping) per the admin-bundle rule; Step 3.5 bundle-drift gate applies. `package.json` `eventTypes` change requires a `cds build --production` so the regenerated `ans-conditions.json` ships.
