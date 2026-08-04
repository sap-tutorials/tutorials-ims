# Admin Send-Test-Alert Action Implementation Plan (#1469)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only "Send test alert" action that fires `alerting.raise()` end-to-end through the real ANS code path with a clearly-marked TEST envelope, reports the outcome (delivered/disabled/error) back to the admin, and is surfaced as a button on the Joule Settings admin page.

**Architecture:** A new non-throwing `raiseTest()` sibling to `raise()` in `srv/lib/alerting.js` returns a structured outcome instead of swallowing everything. A `sendTestAlert` bound action on `AdminService.ChatSettings` builds a TEST envelope with a unique per-click `resourceName` (dodges the 5-min ANS dedup), calls `raiseTest()`, emits a fire-and-forget audit row, and returns the outcome. A new `AlertingTest` eventType lets ops route/silence test events. The Joule Settings page gains a button wired to the action (the `alertsEnabled` toggle already exists from #1468/PR #1471).

**Tech Stack:** SAP CAP (Node.js, ESM), `@sap-tutorials/cds-alert-notification` plugin, Vitest, freestyle SAPUI5 (`sap.m`) admin app.

## Global Constraints

- **ESM only** — `srv/**` uses `import`/`export`, not `require`.
- **Fail-open contract** — alerting code MUST NEVER throw into the path it watches. `raise()` stays byte-for-byte unchanged; `raiseTest()` also never throws (captures faults into an `error` result).
- **DB-backed gating, no env var** — enablement is `ChatSettings.alertsEnabled` via `srv/lib/runtime-config/alert-settings.js` `isAlertingEnabled()`. Never read `process.env` for this.
- **ANS severities** (exact, from `lib/ans-contract.js`): `INFO`, `NOTICE`, `WARNING`, `ERROR`, `FATAL`. Default `ERROR`.
- **Auth** — `AdminService` is `@requires: 'Admin'` at service level; `ChatSettings` is `@odata.singleton @requires: 'Admin'`. No extra gate needed on the action (Admin + SuperAdmin both hold `Admin`).
- **Unit-test bootstrap** — use `cds.deploy('db/schema.cds').to('sqlite::memory:')` + `cds.serve('AdminService').from('./srv/admin-service')` (the pattern in `test/unit/admin-seed-concept-embeddings.test.js`). Do NOT use `cds.deploy(cds.model)` — broken here.
- **Windows/CRLF** — keep line endings LF; do not let editors flip to CRLF.
- **Admin-UI deploy** — any `app/admin/**` change requires a FULL `npm run deploy -- --env <env>` (NO `--skip-build`, NO `-m` scoping); Step 3.5 bundle-drift gate applies. `package.json` `eventTypes` change requires `cds build --production` so the regenerated `ans-conditions.json` ships. (Deploy is out of scope for these tasks — noted for the eventual rollout.)

---

### Task 1: `raiseTest()` helper in `srv/lib/alerting.js`

**Files:**
- Modify: `srv/lib/alerting.js` (add `raiseTest`, leave `raise` and `_resetForTest` unchanged)
- Test: `test/unit/alerting.test.js` (append a `raiseTest` describe block)

**Interfaces:**
- Consumes: `isAlertingEnabled()` from `./runtime-config/alert-settings.js` (already imported); the memoised `svcPromise` (module-local, already declared).
- Produces: `export async function raiseTest(input) → Promise<{ outcome: 'delivered'|'disabled'|'error', reason?: string }>`. Never throws.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/alerting.test.js` (the file already mocks the resolver via `enabledState` and imports `cds`):

```javascript
describe('raiseTest helper', () => {
  beforeEach(() => { vi.resetModules(); enabledState.value = true })

  it('returns { outcome: "disabled" } when alerting is disabled (never connects)', async () => {
    enabledState.value = false
    const spy = vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn() })
    const { raiseTest } = await import('../../srv/lib/alerting.js')
    const res = await raiseTest({ eventType: 'AlertingTest', severity: 'ERROR' })
    expect(res).toEqual({ outcome: 'disabled' })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('returns { outcome: "delivered" } when enabled and the sink resolves', async () => {
    const raiseSpy = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: raiseSpy }) })
    const { raiseTest } = await import('../../srv/lib/alerting.js')
    const res = await raiseTest({ eventType: 'AlertingTest', severity: 'ERROR',
      resource: { resourceName: 'admin-test:u:2026', resourceType: 'service' } })
    expect(res).toEqual({ outcome: 'delivered' })
    expect(raiseSpy).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'AlertingTest' }))
  })

  it('returns { outcome: "error", reason } when the sink raise throws (never throws)', async () => {
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: vi.fn().mockRejectedValue(new Error('boom')) }) })
    const { raiseTest } = await import('../../srv/lib/alerting.js')
    const res = await raiseTest({ eventType: 'AlertingTest', severity: 'ERROR' })
    expect(res.outcome).toBe('error')
    expect(res.reason).toContain('boom')
  })

  it('returns { outcome: "error", reason } when connect itself throws', async () => {
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockRejectedValue(new Error('no binding')) })
    const { raiseTest } = await import('../../srv/lib/alerting.js')
    const res = await raiseTest({ eventType: 'AlertingTest', severity: 'ERROR' })
    expect(res.outcome).toBe('error')
    expect(res.reason).toContain('no binding')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/alerting.test.js -t "raiseTest helper"`
Expected: FAIL — `raiseTest` is not exported (`TypeError: raiseTest is not a function`).

- [ ] **Step 3: Implement `raiseTest`**

Add to `srv/lib/alerting.js` (after `raise`, before `_resetForTest`). Leave `raise` untouched:

```javascript
// #1469: on-demand, result-returning sibling to raise(). Used ONLY by the
// admin "Send test alert" action so the admin sees whether the alert path
// actually fired. Same fail-open contract (never throws) but returns a
// structured outcome instead of swallowing silently. Reuses the memoised
// svcPromise. Callers must pass a unique resource.resourceName per click so
// the plugin's dedup window (dedupWindowMs) never silently drops the test.
export async function raiseTest (input) {
  try {
    if (!(await isAlertingEnabled())) return { outcome: 'disabled' }
    svcPromise ??= cds.connect.to('alerts')
    const svc = await svcPromise
    await svc.raise(input)
    return { outcome: 'delivered' }
  } catch (e) {
    svcPromise = undefined // allow a later reconnect attempt
    const reason = e?.message ?? String(e)
    LOG.warn('test alert raise failed:', reason)
    return { outcome: 'error', reason }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/alerting.test.js`
Expected: PASS (all existing `raise` tests + the 4 new `raiseTest` tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/alerting.js test/unit/alerting.test.js
git commit -m "feat(1469): add raiseTest() result-returning alert helper"
```

---

### Task 2: `sendTestAlert` action (CDS + handler + eventType config)

**Files:**
- Modify: `srv/admin-service.cds` (add `sendTestAlert` action to the `ChatSettings` `actions {}` block, ~line 377 after `seedConceptEmbeddings`)
- Modify: `srv/admin-service.js` (add `import { raiseTest }`, register `this.on('sendTestAlert', 'ChatSettings', ...)`)
- Modify: `package.json` (add `'AlertingTest'` to `cds.requires.alerts.eventTypes`, line 293)
- Test: `test/unit/admin-send-test-alert.test.js` (new)

**Interfaces:**
- Consumes: `raiseTest(input) → { outcome, reason? }` from `./lib/alerting.js` (Task 1); the `auditEvent` closure created in `init()` at `srv/admin-service.js:2390` (`_moduleAuditEvent`).
- Produces: bound action `AdminService.sendTestAlert(severity: String)` returning `{ outcome: String, reason: String, eventType: String, severity: String }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/admin-send-test-alert.test.js`. This mirrors `admin-seed-concept-embeddings.test.js`'s bootstrap. The `[test]` profile binds the `alert-notification-memory` sink, and `alertsEnabled` defaults false in the schema — so with the default row the action reports `disabled`; with `alertsEnabled: true` it reports `delivered` (memory sink never throws).

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

// #1469: AdminService.sendTestAlert bound action. Verifies registration,
// entity-level @requires:'Admin' auth gate, the disabled/delivered outcomes,
// and severity normalization. Uses the same real-in-memory bootstrap as
// admin-seed-concept-embeddings.test.js (no vi.mock of the dynamic import).
// The [test] profile wires the alert-notification-memory sink, so a
// delivered test never touches ANS.

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');
const CHAT_ID = '00000000-0000-0000-0000-000000001469';

async function seedChatSettings(fields) {
  const { ChatSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ChatSettings);
  await INSERT.into(ChatSettings).entries({ ID: CHAT_ID, ...fields });
}

async function sendAsAdmin(srv, event, data) {
  const user = new cds.User.Privileged();
  return srv.tx({ user }, tx => tx.send({ event, entity: 'ChatSettings', data }));
}

describe('AdminService sendTestAlert action (#1469)', () => {
  let srv;

  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
    srv = await cds.serve('AdminService').from('./srv/admin-service');
  });

  it('reports outcome "disabled" when alertsEnabled is false', async () => {
    await seedChatSettings({ alertsEnabled: false });
    const res = await sendAsAdmin(srv, 'sendTestAlert', {});
    expect(res.outcome).toBe('disabled');
    expect(res.eventType).toBe('AlertingTest');
    expect(res.severity).toBe('ERROR'); // default
  });

  it('reports outcome "delivered" when alertsEnabled is true (memory sink)', async () => {
    await seedChatSettings({ alertsEnabled: true });
    const res = await sendAsAdmin(srv, 'sendTestAlert', {});
    expect(res.outcome).toBe('delivered');
    expect(res.eventType).toBe('AlertingTest');
  });

  it('normalizes an unknown severity to ERROR', async () => {
    await seedChatSettings({ alertsEnabled: true });
    const res = await sendAsAdmin(srv, 'sendTestAlert', { severity: 'BOGUS' });
    expect(res.severity).toBe('ERROR');
  });

  it('accepts a valid severity (WARNING) and echoes it back', async () => {
    await seedChatSettings({ alertsEnabled: true });
    const res = await sendAsAdmin(srv, 'sendTestAlert', { severity: 'WARNING' });
    expect(res.severity).toBe('WARNING');
  });

  it('is auth-gated: anonymous invocation is rejected', async () => {
    await seedChatSettings({ alertsEnabled: true });
    const anon = new cds.User({ id: 'anonymous' });
    await expect(
      srv.tx({ user: anon }, tx => tx.send({ event: 'sendTestAlert', entity: 'ChatSettings', data: {} }))
    ).rejects.toMatchObject({ code: expect.any(Number) });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/admin-send-test-alert.test.js`
Expected: FAIL — action not registered (send rejects with "not found"/501, or `res.outcome` undefined).

> Note: the alerting resolver caches `isAlertingEnabled()` for 5s (`TTL_MS`). Each `it` re-deploys a fresh in-memory DB and re-serves, but the resolver's `globalThis`-pinned cache can carry across cases. If the disabled/enabled cases flake, import `_resetForTest` from `srv/lib/runtime-config/alert-settings.js` and call it in `beforeEach`. Add this only if a flake appears.

- [ ] **Step 3a: Add the CDS action declaration**

In `srv/admin-service.cds`, inside the `entity ChatSettings as projection ... actions { ... }` block (after the `seedConceptEmbeddings` action, ~line 381):

```cds
    // #1469: admin-triggered end-to-end ANS test. Invokes alerting.raiseTest()
    // with a TEST-marked envelope (eventType 'AlertingTest'). Reports outcome
    // 'disabled' when ChatSettings.alertsEnabled is false (doubles as an
    // "is alerting on?" probe), 'delivered' when handed to the ANS sink, or
    // 'error' (+reason) on connect/raise failure. severity defaults to ERROR
    // (matches the real hooks + the minSeverity:ERROR route). Auth via the
    // entity-level @requires:'Admin'.
    action sendTestAlert(severity: String) returns {
      outcome  : String;
      reason   : String;
      eventType: String;
      severity : String;
    };
```

- [ ] **Step 3b: Add the import + handler in `srv/admin-service.js`**

Add the import near the other `./lib/*` imports (top of file, alongside e.g. the `createAuditEmitter` import at line 22):

```javascript
import { raiseTest } from './lib/alerting.js'; // #1469 admin test alert
```

Register the handler inside `init()`, immediately after the `seedConceptEmbeddings` handler (~line 1580). It uses the `auditEvent` closure already in scope from line 2390 — but that closure is declared LATER in `init()` than line 1580, so to avoid a TDZ reference place this handler AFTER the `auditEvent` declaration. Put it right after the `seedApiDocs` handler (~line 2658), which is already past the `auditEvent` declaration and demonstrates the same fire-and-forget audit pattern:

```javascript
    // #1469: on-demand end-to-end ANS alert test. Fires the REAL alerting
    // code path (raiseTest → dedup → routing → cds.outboxed → ANS POST) with
    // a TEST-marked envelope, and — unlike the fail-open production hooks —
    // reports the outcome back so the admin knows if it actually fired.
    // Placed after the auditEvent closure (line ~2390) so the reference
    // resolves. Auth via entity-level @requires:'Admin' on ChatSettings.
    this.on('sendTestAlert', 'ChatSettings', async (req) => {
      const SEVERITIES = ['INFO', 'NOTICE', 'WARNING', 'ERROR', 'FATAL'];
      const severity = SEVERITIES.includes(req.data?.severity) ? req.data.severity : 'ERROR';
      const user = req.user?.id ?? 'unknown';
      const ts = new Date().toISOString();
      // Unique resourceName per click dodges the plugin's 5-min dedup window
      // (dedup key is `${eventType}:${resourceName}`), so every click fires.
      const resourceName = `admin-test:${user}:${ts}`;

      const result = await raiseTest({
        eventType: 'AlertingTest',
        severity,
        category: 'ALERT',
        subject: '[TEST] Admin-triggered alert',
        body: `Manual end-to-end verification of the ANS alerting path. Not a real incident. Triggered by ${user} at ${ts}.`,
        resource: { resourceName, resourceType: 'service' },
        tags: { 'ans:correlationId': 'admin-test' },
      });

      // Fire-and-forget audit (mirrors seedApiDocs). Never fails the action.
      setImmediate(() => {
        auditEvent('alerting.test-alert', { user, outcome: result.outcome, severity })
          .catch((err) => cds.log('admin-service').warn(`sendTestAlert audit emit failed: ${err.message ?? err}`));
      });

      return { outcome: result.outcome, reason: result.reason ?? null, eventType: 'AlertingTest', severity };
    });
```

- [ ] **Step 3c: Add the `AlertingTest` eventType to `package.json`**

Change line 293:

```json
        "eventTypes": ["PublishRejected", "ScheduledJobFailed", "RebuildDispatchFailed", "AlertingTest"],
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/admin-send-test-alert.test.js`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Verify the model still compiles (no CDS regression)**

Run: `npx cds compile srv/admin-service.cds > /dev/null && echo "cds compile OK"`
Expected: prints `cds compile OK` with no errors.

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js package.json test/unit/admin-send-test-alert.test.js
git commit -m "feat(1469): add sendTestAlert admin action + AlertingTest eventType"
```

---

### Task 3: Joule Settings UI — Send-test-alert button

**Files:**
- Modify: `app/admin/joule/webapp/view/Settings.view.xml` (append a `Toolbar`+`Text` inside the existing `alertsSection` panel, ~line 203)
- Modify: `app/admin/joule/webapp/controller/Settings.controller.js` (add `onSendTestAlert` method)
- Modify: `app/admin/joule/webapp/i18n/i18n.properties` (add `sendTestAlertButton`, `sendTestAlertHelp`)

**Interfaces:**
- Consumes: `AdminService.sendTestAlert` bound action (Task 2), reachable at `POST /admin/ChatSettings/AdminService.sendTestAlert`; the `settings>/alertsEnabled` model property (already populated by #1468).
- Produces: nothing consumed by later tasks (leaf UI).

- [ ] **Step 1: Add i18n keys**

Append to `app/admin/joule/webapp/i18n/i18n.properties` (after the existing `alertsEnabledHelp` line):

```properties
sendTestAlertButton=Send test alert
sendTestAlertHelp=Fires a TEST alert (eventType AlertingTest) through the real ANS code path so you can confirm end-to-end delivery on demand. Enable ANS push alerts above and click Save FIRST — the toggle only takes effect after saving (a ~5s server cache). A delivered result means the code path fired; the email also needs an AlertingTest condition wired in the BTP cockpit for the target environment.
```

- [ ] **Step 2: Add the button + help text to the view**

In `app/admin/joule/webapp/view/Settings.view.xml`, inside the `alertsSection` `<Panel>`, after the closing `</f:SimpleForm>` (line ~203) and before `</Panel>` (line ~204):

```xml
        <Toolbar>
          <Button text="{i18n>sendTestAlertButton}" press=".onSendTestAlert" type="Default" enabled="{settings>/alertsEnabled}" />
        </Toolbar>
        <Text text="{i18n>sendTestAlertHelp}" wrapping="true" class="sapUiSmallMargin" />
```

- [ ] **Step 3: Add the `onSendTestAlert` controller method**

In `app/admin/joule/webapp/controller/Settings.controller.js`, add a method after `onSeedConceptEmbeddings` (~line 284, before `_refreshStats`). Mirrors the CSRF-fetch → POST → parse pattern used by `onSeedConceptEmbeddings`:

```javascript
    // #1469: fire an on-demand end-to-end ANS test alert via the bound
    // AdminService.sendTestAlert action, and report the outcome. Mirrors
    // onSeedConceptEmbeddings' CSRF-fetch → POST → parse shape.
    onSendTestAlert: function () {
      var self = this;
      fetch("/admin/$metadata", {
        method: "HEAD",
        credentials: "include",
        headers: { "x-csrf-token": "fetch" }
      })
        .then(function (res) {
          return res.headers.get("x-csrf-token") || "";
        })
        .then(function (token) {
          return fetch("/admin/ChatSettings/AdminService.sendTestAlert", {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "x-csrf-token": token
            },
            body: JSON.stringify({})
          });
        })
        .then(function (res) {
          if (!res.ok) {
            return res.text().then(function (txt) {
              throw new Error(txt || "HTTP " + res.status);
            });
          }
          return res.json();
        })
        .then(function (payload) {
          // OData wraps action results in { value: {...} } on some protocol
          // versions and returns the flat object on others. Accept both.
          var r = payload && payload.value ? payload.value : payload;
          var outcome = r && r.outcome ? r.outcome : "error";
          if (outcome === "delivered") {
            MessageToast.show("Test alert sent (eventType AlertingTest). Check the devrel-oncall inbox.");
          } else if (outcome === "disabled") {
            MessageBox.warning("Alerting is disabled — enable ANS push alerts above, click Save, then retry.");
          } else {
            MessageBox.error("Test alert failed: " + ((r && r.reason) || "unknown error"));
          }
        })
        .catch(function (err) {
          MessageBox.error("Test alert failed: " + err.message);
        });
    },
```

(`MessageToast` and `MessageBox` are already imported at the top of the controller — no dependency change.)

- [ ] **Step 4: Lint the UI5 changes**

Run: `npx eslint app/admin/joule/webapp/controller/Settings.controller.js` (if the project lints UI5; if no eslint config applies, skip)
Then sanity-check the view XML is well-formed:
Run: `node -e "const fs=require('fs');const s=fs.readFileSync('app/admin/joule/webapp/view/Settings.view.xml','utf8');const o=(s.match(/<Panel/g)||[]).length,c=(s.match(/<\/Panel>/g)||[]).length;if(o!==c)throw new Error('Panel tag mismatch '+o+'/'+c);console.log('view balanced:',o,'panels')"`
Expected: `view balanced: N panels` (open == close).

- [ ] **Step 5: Verify no CRLF was introduced**

Run: `git diff --stat && file app/admin/joule/webapp/controller/Settings.controller.js`
Expected: no `\r` warnings; if `git diff` shows the whole file changed, the editor flipped line endings — re-save as LF.

- [ ] **Step 6: Commit**

```bash
git add app/admin/joule/webapp/view/Settings.view.xml app/admin/joule/webapp/controller/Settings.controller.js app/admin/joule/webapp/i18n/i18n.properties
git commit -m "feat(1469): add Send-test-alert button to Joule Settings admin UI"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/developers/architecture/observability.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add `AlertingTest` to the eventTypes list and config snippet**

In `docs/developers/architecture/observability.md`, update the config snippet (~line 154) to match `package.json`:

```json
  "eventTypes": ["PublishRejected", "ScheduledJobFailed", "RebuildDispatchFailed", "AlertingTest"],
```

- [ ] **Step 2: Add a "Testing the alert path" subsection**

Add after the "Alerted failure paths" table (~line 139):

```markdown
## Testing the alert path (#1469)

An admin can verify the ANS code path end-to-end on demand — without forcing a
real failure — via **Send test alert** on `/admin-ui/#joule` (Operational
Alerting panel, beside the `alertsEnabled` toggle).

- The button invokes `AdminService.sendTestAlert`, which calls
  `alerting.raiseTest()` with a TEST envelope: `eventType: 'AlertingTest'`,
  `subject: '[TEST] Admin-triggered alert'`, `severity` defaulting to `ERROR`.
- `raiseTest()` is a result-returning sibling of `raise()` — same fail-open
  contract (never throws) but returns `{ outcome: 'delivered' | 'disabled' |
  'error', reason? }` so the admin sees whether it fired:
  - `disabled` — `ChatSettings.alertsEnabled` is false (doubles as an
    "is alerting on?" probe). Enable + Save first (~5s resolver cache).
  - `delivered` — handed to the ANS sink without error.
  - `error` — connect/raise threw; `reason` carries the message.
- Each click uses a **unique** `resource.resourceName`
  (`admin-test:<user>:<ISO-ts>`) so the plugin's 5-min dedup window never
  silently drops a test — every click actually fires.
- **Ops requirement:** for a `delivered` test to reach an inbox, wire an
  `AlertingTest` ANS condition → subscription in the BTP cockpit for the
  target env, exactly like the three real eventTypes. If it's absent,
  `raiseTest()` still reports `delivered` (our code did its job) but no email
  arrives — itself a useful signal that the ANS-side wiring is missing.
```

- [ ] **Step 3: Commit**

```bash
git add docs/developers/architecture/observability.md
git commit -m "docs(1469): document the admin test-alert path + AlertingTest eventType"
```

---

### Task 5: Full test-suite sanity + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Run the unit suite for the touched areas**

Run: `npx vitest run test/unit/alerting.test.js test/unit/admin-send-test-alert.test.js`
Expected: all PASS.

- [ ] **Step 2: Confirm the CDS model + admin bundle checks pass**

Run: `npx cds compile srv --to sql > /dev/null && echo "model OK"`
Expected: `model OK` (no compile errors introduced by the new action).

- [ ] **Step 3: Push the branch and open a draft PR**

```bash
git push -u origin worktree-issue-1469-test-alert
gh pr create --repo sap-tutorials/tutorials-ims --draft \
  --title "feat(1469): admin Send-test-alert action (end-to-end ANS code-path verification)" \
  --body "Closes #1469.

Adds an admin-only \"Send test alert\" button (Joule Settings → Operational Alerting) that fires the REAL alerting code path (\`raiseTest()\` → dedup → routing → cds.outboxed → ANS POST) with a TEST envelope and reports the outcome (delivered/disabled/error).

- \`raiseTest()\` — result-returning, fail-open sibling of \`raise()\`.
- \`AdminService.sendTestAlert(severity?)\` bound action on ChatSettings; unique per-click resourceName dodges the 5-min dedup; fire-and-forget SecurityEvent audit.
- New \`AlertingTest\` eventType (routable/silenceable ANS condition).
- Button in the existing Operational Alerting panel (the alertsEnabled toggle shipped in #1468/PR #1471).
- Docs + unit tests.

**Deploy note:** admin-UI change → FULL \`npm run deploy\` (no --skip-build/-m); package.json eventTypes change needs \`cds build --production\` so ans-conditions.json regenerates. **Ops:** wire an AlertingTest ANS condition→subscription per env for delivered tests to reach an inbox.

**Post-deploy verification (Tom's #1 rule):** on DEV, enable Alerting + Save, click Send test alert, confirm the delivered toast, then confirm the email/console-sink log."
```

- [ ] **Step 4: Report the PR URL**

Print the PR URL from `gh pr create` output.

---

## Self-Review

**Spec coverage:**
- §1 `raiseTest()` → Task 1. ✓
- §2 `AlertingTest` eventType → Task 2 (Step 3c). ✓
- §3 `sendTestAlert` action (CDS + handler + audit + severity default + unique resourceName) → Task 2. ✓
- §4 UI button (toggle already exists) → Task 3. ✓
- §5 Docs → Task 4. ✓
- Testing section → Tasks 1, 2 (unit); post-deploy manual noted in Task 5 PR body. (E2e spec is advisory-only per #1378 — omitted from hard tasks; can be added if the nudge requires it.)

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows actual content. ✓

**Type consistency:** `raiseTest(input) → { outcome, reason? }` defined in Task 1, consumed identically in Task 2's handler (`result.outcome`, `result.reason`) and Task 3's controller (`r.outcome`, `r.reason`). Action return shape `{ outcome, reason, eventType, severity }` consistent between CDS (Task 2 Step 3a), handler (Step 3b), and tests. Severities list identical in Global Constraints, handler, and tests. ✓
