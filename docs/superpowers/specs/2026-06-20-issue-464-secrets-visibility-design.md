# Phase 2-B: Secrets visibility (metadata-only) — design

**Issue:** [#464](https://github.com/sap-tutorials/tutorials-ims/issues/464) — second migration of the runtime-config pattern from research issue [#444](https://github.com/sap-tutorials/tutorials-ims/issues/444).

**Date:** 2026-06-20

**Research-design parent:** [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](2026-06-20-runtime-config-research-design.md), section "Secret rotation/expiry — Tom's sub-idea"

**Sibling spec:** [docs/superpowers/specs/2026-06-20-issue-463-runtime-config-foundation-design.md](2026-06-20-issue-463-runtime-config-foundation-design.md) — Phase 2-A (just shipped via PR #471) established the resolver lib + admin-tile + 5-location wiring template that this PR extends.

## TL;DR

Add a `Secrets` HANA entity that tracks **credential metadata only** (no values stored): `key`, `description`, `kind`, `rotationOwner`, `rotationDocsUrl`, `expiresAt`, `lastRotatedAt`. A daily cron at 04:11 UTC computes days-remaining and surfaces warnings via a new `secretWarnings()` AdminService function. The admin-shell's bell-icon notifications popover (currently hardcoded "No new notifications") becomes a live feed of expiring/expired secrets. A custom-XML admin tile at `/admin-ui/#secrets` provides full CRUD over the tracked-secret rows.

**Scope explicitly excludes:** encrypted-value storage (Phase 2-C / #465 — gated on the encryption-key management decision), GitHub-issue-comment notifier, email notifier, automated rotation handlers.

The visibility win — "what credentials does the platform use, and when do they expire?" answerable from a single place — ships independently of the encryption-key debate.

---

## Implementation choices made during brainstorming

| Decision | Choice |
| --- | --- |
| Admin tile shape | **Custom XML list with sap.m.Table + dialog fragment** — NOT Fiori Elements ListReport. Matches kg-settings + Joule precedent ("no FE complexity"). Establishes the list-shaped-tile template for Phase 3 entities. |
| Warning surface | **Extend the existing notifications popover** (bell icon, currently hardcoded "No new notifications"). Live query on each open. NOT a permanent top-of-page MessageStrip. |
| External notifier | **Internal-only — PipelineLog + popover.** No GitHub-issue-comment poster, no email. (Both are Phase 3+ if visibility-only proves insufficient.) |
| Initial seeding | **Empty CSV + one-shot script** at `scripts/seed-secrets.cjs`. Avoids the HDI-clobbers-admin-edits footgun ([feedback_cap_csv_seeds_clobber_admin_data]). Run via `npx cds bind --exec -- node scripts/seed-secrets.cjs`. |
| Notification dedupe | **No `lastNotifiedAt` column** — popover queries live; PipelineLog naturally captures the daily history. YAGNI: add state if/when external notifiers (email/GitHub) get added. |
| i18n bundle for admin-shell | **Create `app/admin-shell/webapp/i18n/i18n.properties`** — first time the admin-shell needs an i18n file (existing nav-item labels are hardcoded XML literals). Unblocks future i18n cleanup. |
| Entity name | **`Secrets`** — same as research spec. The tile's MessageStrip explicitly says "metadata-only" so the name doesn't mislead. |

---

## File structure

```text
db/schema.cds
  + entity Secrets : cuid, managed { 7 columns, no encrypted fields }   (~15 lines)

db/data/com.sap.developers.ims-Secrets.csv
  + HEADER ONLY — empty seed (per [feedback_cap_csv_seeds_clobber_admin_data])

db/change-tracking.cds
  + annotate ims.Secrets with @changelog;

srv/admin-service.cds
  + @requires:'Admin' projection on Secrets (NOT @odata.singleton; this is a list)
  + @requires:'Admin' function secretWarnings() returns array of {...}

srv/admin-service.js
  + this.on('secretWarnings', ...)   handler that classifies + sorts warnings

srv/jobs/secret-expiry-check.js   (~70 lines)
  + export classifySeverity(daysRemaining)
  + export async function runSecretExpiryCheck()

srv/jobs/scheduler.js
  + cron.schedule('11 4 * * *', ...) to register the daily run

scripts/seed-secrets.cjs   (~80 lines)
  + idempotent INSERT-if-absent of the 6 known tracked secrets

app/admin/secrets/webapp/
  + manifest.json                       (sap.m only)
  + Component.js
  + index.html
  + view/Secrets.view.xml               (Table with rows + Add/Refresh buttons)
  + view/SecretDialog.fragment.xml      (form for add/edit)
  + controller/Secrets.controller.js    (~150 lines: load/save/delete + dialog)
  + i18n/i18n.properties

app/admin-shell/scripts/copy-components.js   (modify)
  ~ append 'secrets' to COMPONENTS array

app/admin-shell/webapp/manifest.json   (modify)
  ~ componentUsages, target component-usage, target route-target, route entries
  ~ add models.i18n entry pointing at the new bundle (i18n migration starts here)

app/admin-shell/webapp/view/Shell.view.xml   (modify)
  ~ NavigationListItem in System group
  ~ replace notifications popover hardcoded body with bound List

app/admin-shell/webapp/controller/Shell.controller.js   (modify)
  ~ NAV_KEY_TO_ROUTE: secrets: 'secrets'
  ~ NAV_KEY_TO_TITLE: secrets: 'Secrets'
  ~ onNotificationsPress fetches /admin/secretWarnings() and binds popover

app/admin-shell/webapp/i18n/i18n.properties (CREATE — first i18n bundle in admin-shell)
  + notificationsEmpty=...

.deploy/mta.yaml   (modify line 97)
  ~ srv-qa cp chain adds srv/jobs/secret-expiry-check.js

test/unit/jobs/secret-expiry-check.test.js
  + ~6 unit tests covering classifySeverity boundaries + runSecretExpiryCheck shape

docs/developers/operations/secrets-tracking.md   (CREATE)
  + How to add a new tracked secret
  + How rotation owners receive warnings
  + Glossary of kind enum values
```

**Deliberately NOT in scope:**

- Encrypted-value columns + decryption resolver (Phase 2-C #465).
- GitHub-issue-comment poster.
- Email notifier via mail-client.js.
- `lastWarnedAt` / `warningTier` columns on Secrets (cron is stateless).
- Automated rotation handlers.
- Removing env vars from mtaext (unchanged through Phase 3 + soak window).

---

## CDS schema

Append to [db/schema.cds](../../../db/schema.cds) after the `KnowledgeGraphSettings` entity (just landed in #471):

```cds
// Phase 2-B (#464): Secrets-visibility metadata-only inventory.
// Tracks WHAT credentials exist, WHEN they expire, WHO owns rotation.
// Does NOT store secret values — those stay in CF env / mtaext / GH Actions
// secrets. Phase 2-C (#465) will add encryptedValue + encryptionKeyId
// columns once the encryption-key management decision is made.
//
// Daily cron (srv/jobs/secret-expiry-check.js, 04:11 UTC) computes
// days-remaining and surfaces warnings via /admin/secretWarnings() ↦
// admin-shell notifications popover.
//
// CSV seed at db/data/...-Secrets.csv MUST stay empty per the
// HDI-clobbers-admin-edits footgun ([feedback_cap_csv_seeds_clobber_admin_data]).
// Initial seeding is a one-shot script: scripts/seed-secrets.cjs.
entity Secrets : cuid, managed {
  ![key]              : String(120) @assert.unique;
  description         : String(500);
  kind                : String(40);
  rotationOwner       : String(120);
  rotationDocsUrl     : String(500);
  expiresAt           : Date;
  lastRotatedAt       : Timestamp;
}
```

`![key]` escapes the CDS reserved word `key` (which marks primary keys structurally). The column is `String(120)`, NOT a primary key — `cuid` already provides `ID : UUID` as the PK.

**Kind enum** — free-text for forward-compat, but documented values are:

- `github-pat` — GitHub PAT (DISPATCH_TOKEN, TUTORIALS_GITHUB_TOKEN)
- `content-api-key` — bearer token for `/content/publish` (CONTENT_API_KEY)
- `salt` — hash salt (SUBMISSION_SALT_SECRET)
- `smtp-credential` — SMTP credentials
- `service-key` — BTP service key (AI_AUTHOR_AICORE_SERVICE_KEY)
- `other` — fallback

### Change-tracking

In [db/change-tracking.cds](../../../db/change-tracking.cds), append after the existing `KnowledgeGraphSettings` annotation:

```cds
annotate ims.Secrets with @changelog;
```

Mutations appear in `/admin-ui/#changelog-display`.

### AdminService projection + function

In [srv/admin-service.cds](../../../srv/admin-service.cds), append after the `KnowledgeGraphSettings` projection (NOT `@odata.singleton` — this is a list):

```cds
@requires: 'Admin'
entity Secrets as projection on ims.Secrets;

@requires: 'Admin'
function secretWarnings() returns array of {
  ![key]            : String(120);
  description       : String(500);
  daysRemaining     : Integer;
  severity          : String(10);
  rotationOwner     : String(120);
  rotationDocsUrl   : String(500);
};
```

The `secretWarnings()` function is read-only (an OData V4 `function`, not `action`), bound to the AdminService and gated by `@requires: 'Admin'`.

### Empty CSV seed

`db/data/com.sap.developers.ims-Secrets.csv`:

```csv
ID;key;description;kind;rotationOwner;rotationDocsUrl;expiresAt;lastRotatedAt
```

Header only. HDI deploy creates the table empty; initial seeding is the one-shot script (see "Seed script" below).

---

## Cron job

`srv/jobs/secret-expiry-check.js` — new file, ~70 lines:

```javascript
// srv/jobs/secret-expiry-check.js
// Daily cron (04:11 UTC) — computes days-remaining for tracked Secrets
// and surfaces warnings via the admin-shell notifications popover. Stateless
// — no per-row state in the schema; the popover queries live via
// /admin/secretWarnings() so today's warning state is always fresh.
//
// Returns a structured summary for the scheduler's PipelineLog row so admins
// can audit the daily run history.

import cds from '@sap/cds';

const LOG = cds.log('jobs/secret-expiry-check');

const CRITICAL_THRESHOLD_DAYS = 0;   // ≤ 0 days = expired (or expires today)
const WARNING_THRESHOLD_DAYS = 7;    // 0 < days ≤ 7
const INFO_THRESHOLD_DAYS = 14;      // 7 < days ≤ 14

/** Compute calendar-day delta between today (UTC) and expiresAt.
 *  Negative = already expired. */
function daysUntil(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const expiry = new Date(expiresAt).getTime();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  return Math.floor((expiry - today) / 86_400_000);
}

/** Classify days-remaining into a severity tier. Null = no expiry tracked. */
export function classifySeverity(daysRemaining) {
  if (daysRemaining == null) return null;
  if (daysRemaining <= CRITICAL_THRESHOLD_DAYS) return 'CRITICAL';
  if (daysRemaining <= WARNING_THRESHOLD_DAYS) return 'WARNING';
  if (daysRemaining <= INFO_THRESHOLD_DAYS) return 'INFO';
  return null;  // > 14 days = silent (not in the popover)
}

/**
 * Run the daily expiry check. Returns a structured summary for PipelineLog.
 * @returns {Promise<{ critical: number, warning: number, info: number,
 *                     total: number, criticalKeys: string[] }>}
 */
export async function runSecretExpiryCheck() {
  const { Secrets } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(Secrets)
    .columns('key', 'expiresAt')
    .where({ expiresAt: { '!=': null } });

  const now = new Date();
  const counts = { critical: 0, warning: 0, info: 0 };
  const criticalKeys = [];

  for (const row of rows) {
    const days = daysUntil(row.expiresAt, now);
    const severity = classifySeverity(days);
    if (severity === 'CRITICAL') {
      counts.critical += 1;
      criticalKeys.push(row.key);
      LOG.warn(`secret ${row.key} expired or expiring today (${days} days)`);
    } else if (severity === 'WARNING') {
      counts.warning += 1;
      LOG.info(`secret ${row.key} expires in ${days} days`);
    } else if (severity === 'INFO') {
      counts.info += 1;
      LOG.info(`secret ${row.key} expires in ${days} days`);
    }
  }

  return {
    total: rows.length,
    critical: counts.critical,
    warning: counts.warning,
    info: counts.info,
    criticalKeys: criticalKeys.slice(0, 5),  // truncate for readable PipelineLog summary
  };
}
```

### Why these specifics

- **`daysUntil` truncates to UTC calendar days.** Without truncation, an expiry at "2026-06-30 00:00 UTC" would report "30 days remaining" at 23:59 UTC June 30 (seconds before expiry) AND "29 days" 1 second later. Truncation makes thresholds stable across cron-fire times.
- **`criticalKeys.slice(0, 5)`** keeps the PipelineLog `summary` column readable. The scheduler's `formatJobSummary` flattens the result object into a key=value string capped at 2000 chars. Five names is enough to convey "the problem is X" without bloating logs.
- **`4:11` cron schedule** follows the existing scheduler's off-minute convention (`:11`, `:17`, `:30`, `:13` etc.) — avoids the `:00` thundering herd.
- **`classifySeverity` is a separate exported function** so unit tests can call it directly without DB roundtrips. The `runSecretExpiryCheck()` function then becomes a thin DB-query wrapper.

### Scheduler registration

In [srv/jobs/scheduler.js](../../../srv/jobs/scheduler.js):

```javascript
import { runSecretExpiryCheck } from './secret-expiry-check.js';

// Inside registerJobs(), add:
cron.schedule('11 4 * * *', () =>
  runWithLock('secret-expiry-check', 600000, runSecretExpiryCheck)
);
```

The 10-minute lock duration matches similar jobs (cleanup-step-failures uses 60min for a heavier job; this one is much lighter — single SELECT + classification).

---

## `secretWarnings()` AdminService handler

In [srv/admin-service.js](../../../srv/admin-service.js), add the function handler alongside other AdminService handlers:

```javascript
import { classifySeverity } from './jobs/secret-expiry-check.js';

this.on('secretWarnings', async (req) => {
  const { Secrets } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(Secrets)
    .columns('key', 'description', 'expiresAt', 'rotationOwner', 'rotationDocsUrl')
    .where({ expiresAt: { '!=': null } });

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();

  const warnings = [];
  for (const row of rows) {
    const expiry = new Date(row.expiresAt).getTime();
    const daysRemaining = Math.floor((expiry - today) / 86_400_000);
    const severity = classifySeverity(daysRemaining);
    if (!severity) continue;
    warnings.push({
      key: row.key,
      description: row.description ?? '',
      daysRemaining,
      severity,
      rotationOwner: row.rotationOwner ?? '',
      rotationDocsUrl: row.rotationDocsUrl ?? '',
    });
  }

  warnings.sort((a, b) => a.daysRemaining - b.daysRemaining);
  return warnings;
});
```

### Why these specifics

- **Importing `classifySeverity` from the cron module** keeps threshold logic in one place. Both consumers (cron + handler) update together if `WARNING_THRESHOLD_DAYS` ever changes.
- **The `daysUntil` math is duplicated** intentionally (~3 lines). Extracting a shared helper means a new module for trivial code — YAGNI. Refactor when a third consumer appears.
- **Empty-string fallbacks** (`?? ''`) for nullable fields make UI binding safer; UI5 `Text.text` with `null` literally renders "null" in some control types.
- **Sort by `daysRemaining` asc** puts already-expired (negative) and most-urgent secrets at the top of the popover.

---

## Admin tile

`app/admin/secrets/webapp/`, mirroring kg-settings + Joule shape (custom XML, no Fiori Elements). Six files.

### `manifest.json`

Same shape as [app/admin/knowledgeGraph/webapp/manifest.json](../../../app/admin/knowledgeGraph/webapp/manifest.json) — substitute `secrets` / `Secrets` for `knowledgeGraph` / `KnowledgeGraph`.

### `view/Secrets.view.xml`

Table-based list with toolbar buttons + per-row Edit/Delete. Each row's `expiryState` is computed in the controller from `daysRemaining` and bound to `ObjectStatus.state` (Error/Warning/Information/None mapping):

```xml
<mvc:View
  controllerName="sap.tutorials.admin.secrets.controller.Secrets"
  xmlns:mvc="sap.ui.core.mvc"
  xmlns="sap.m"
  xmlns:core="sap.ui.core"
  height="100%">
  <Page showHeader="false">
    <VBox class="sapUiMediumMargin">
      <Title text="{i18n>pageTitle}" level="H2" class="sapUiSmallMarginBottom" />
      <MessageStrip
        text="{i18n>infoStrip}"
        type="Information"
        showIcon="true"
        class="sapUiSmallMarginBottom" />

      <Table
        id="secretsTable"
        items="{secrets>/items}"
        growing="true"
        growingThreshold="50"
        mode="None">
        <headerToolbar>
          <Toolbar>
            <Title text="{i18n>tableTitle}" level="H3" />
            <ToolbarSpacer />
            <Button text="{i18n>buttonAdd}" icon="sap-icon://add" press=".onAdd" />
            <Button icon="sap-icon://refresh" tooltip="{i18n>buttonRefresh}" press=".onRefresh" />
          </Toolbar>
        </headerToolbar>
        <columns>
          <Column><Text text="{i18n>colKey}" /></Column>
          <Column><Text text="{i18n>colKind}" /></Column>
          <Column><Text text="{i18n>colExpiresAt}" /></Column>
          <Column><Text text="{i18n>colRotationOwner}" /></Column>
          <Column hAlign="End"><Text text="{i18n>colActions}" /></Column>
        </columns>
        <items>
          <ColumnListItem>
            <cells>
              <ObjectIdentifier title="{secrets>key}" text="{secrets>description}" />
              <Text text="{secrets>kind}" />
              <ObjectStatus text="{secrets>expiresAt}" state="{secrets>expiryState}" />
              <Text text="{secrets>rotationOwner}" />
              <HBox>
                <Button icon="sap-icon://edit" press=".onEdit" tooltip="{i18n>buttonEdit}" type="Transparent" />
                <Button icon="sap-icon://delete" press=".onDelete" tooltip="{i18n>buttonDelete}" type="Transparent" />
              </HBox>
            </cells>
          </ColumnListItem>
        </items>
      </Table>
    </VBox>
  </Page>
</mvc:View>
```

### `view/SecretDialog.fragment.xml`

Reusable Add/Edit dialog. Key field disabled in edit mode (renames are deletes-then-adds):

```xml
<core:FragmentDefinition
  xmlns="sap.m"
  xmlns:core="sap.ui.core"
  xmlns:f="sap.ui.layout.form">
  <Dialog
    id="secretDialog"
    title="{dialog>/title}"
    contentWidth="500px"
    contentHeight="auto">
    <f:SimpleForm editable="true" layout="ResponsiveGridLayout">
      <Label text="{i18n>fieldKey}" required="true" />
      <Input value="{dialog>/key}" enabled="{dialog>/isNew}" placeholder="GITHUB_DISPATCH_TOKEN" />
      <Label text="{i18n>fieldDescription}" />
      <TextArea value="{dialog>/description}" rows="2" />
      <Label text="{i18n>fieldKind}" />
      <ComboBox selectedKey="{dialog>/kind}">
        <core:Item key="github-pat" text="GitHub PAT" />
        <core:Item key="content-api-key" text="Content API Key" />
        <core:Item key="salt" text="Salt / hash secret" />
        <core:Item key="smtp-credential" text="SMTP credential" />
        <core:Item key="service-key" text="BTP service key" />
        <core:Item key="other" text="Other" />
      </ComboBox>
      <Label text="{i18n>fieldRotationOwner}" />
      <Input value="{dialog>/rotationOwner}" placeholder="thomas.jung@sap.com" />
      <Label text="{i18n>fieldRotationDocsUrl}" />
      <Input value="{dialog>/rotationDocsUrl}" placeholder="https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/..." />
      <Label text="{i18n>fieldExpiresAt}" />
      <DatePicker value="{dialog>/expiresAt}" valueFormat="yyyy-MM-dd" displayFormat="yyyy-MM-dd" />
      <Label text="{i18n>fieldLastRotatedAt}" />
      <DateTimePicker value="{dialog>/lastRotatedAt}" valueFormat="yyyy-MM-ddTHH:mm:ss" />
    </f:SimpleForm>
    <buttons>
      <Button text="{i18n>buttonSave}" type="Emphasized" press=".onDialogSave" />
      <Button text="{i18n>buttonCancel}" press=".onDialogCancel" />
    </buttons>
  </Dialog>
</core:FragmentDefinition>
```

### `controller/Secrets.controller.js`

~150 lines covering load/add/edit/delete + dialog lifecycle. Pattern matches the kg-settings controller's CSRF round-trip + `credentials: 'include'` for every fetch. Key responsibilities:

- `onInit` — load existing rows via `fetch("/admin/Secrets")`. Compute `expiryState` per row (Error/Warning/Information/None mapping from `daysRemaining`).
- `onAdd` — open dialog with empty model + `isNew: true`.
- `onEdit(oEvent)` — open dialog populated with the bound row + `isNew: false` (key field disabled).
- `onDelete(oEvent)` — `MessageBox.confirm` then `DELETE /admin/Secrets(<id>)` with CSRF.
- `onDialogSave` — POST (new) or PATCH (edit) with CSRF round-trip via HEAD `/admin/$metadata`.
- `onDialogCancel` — close dialog without write.
- `onRefresh` — reload the list.

### Tile-local `i18n/i18n.properties`

```properties
appTitle=Secrets Inventory
pageTitle=Secrets Inventory
tableTitle=Tracked Secrets
infoStrip=Tracks credential metadata only — values stay in CF env / GitHub Actions secrets / mtaext. Phase 2-C will add encrypted-value storage once the encryption-key management decision is made. Daily expiry-check cron at 04:11 UTC surfaces warnings via the notifications popover (bell icon).
colKey=Key
colKind=Kind
colExpiresAt=Expires
colRotationOwner=Rotation Owner
colActions=Actions
buttonAdd=Add
buttonRefresh=Refresh
buttonEdit=Edit
buttonDelete=Delete
buttonSave=Save
buttonCancel=Cancel
fieldKey=Key (env-var name)
fieldDescription=Description
fieldKind=Kind
fieldRotationOwner=Rotation Owner (email)
fieldRotationDocsUrl=Rotation Docs URL
fieldExpiresAt=Expires At
fieldLastRotatedAt=Last Rotated At
dialogTitleAdd=Add Tracked Secret
dialogTitleEdit=Edit Tracked Secret
confirmDelete=Delete this tracked-secret entry? This removes the metadata only — the actual credential is unaffected.
```

---

## Notifications popover wiring

Two changes in admin-shell to surface warnings via the bell icon. **No permanent banner** — popover-only, live query on each open.

### `Shell.view.xml`

Replace the hardcoded popover body:

```xml
<!-- BEFORE: -->
<Popover id="notificationsPopover" placement="Bottom" title="Notifications">
  <VBox class="sapUiSmallMargin">
    <Label text="No new notifications" class="sapUiSmallMargin" />
  </VBox>
</Popover>

<!-- AFTER: -->
<Popover
  id="notificationsPopover"
  placement="Bottom"
  title="Notifications"
  contentWidth="380px">
  <VBox class="sapUiSmallMargin">
    <List
      id="notificationsList"
      items="{notifications>/items}"
      noDataText="{i18n>notificationsEmpty}"
      showSeparators="Inner">
      <CustomListItem>
        <VBox class="sapUiSmallMargin">
          <ObjectStatus
            text="{notifications>key}"
            state="{notifications>uiState}"
            icon="{notifications>uiIcon}" />
          <Text text="{notifications>summary}" class="sapUiTinyMarginTop" />
          <HBox class="sapUiTinyMarginTop">
            <Link
              text="Rotation guide"
              href="{notifications>rotationDocsUrl}"
              target="_blank"
              visible="{= !!${notifications>rotationDocsUrl} }" />
            <ToolbarSpacer />
            <Text text="{notifications>rotationOwner}" class="sapUiTinyMarginBegin" />
          </HBox>
        </VBox>
      </CustomListItem>
    </List>
  </VBox>
</Popover>
```

### `Shell.controller.js` — `onNotificationsPress`

Extend the existing handler (currently just opens the popover) to fetch warnings live on open:

```javascript
onNotificationsPress: function (oEvent) {
  var oButton = oEvent.getSource();
  var oPopover = this.byId("notificationsPopover");
  var oNotifModel = this.getView().getModel("notifications") ||
    new JSONModel({ items: [] });
  this.getView().setModel(oNotifModel, "notifications");

  // Live query — no client cache. Popover always shows fresh state.
  fetch("/admin/secretWarnings()", {
    credentials: "include",
    headers: { "Accept": "application/json" }
  })
    .then(function (res) {
      if (!res.ok) { throw new Error("HTTP " + res.status); }
      return res.json();
    })
    .then(function (body) {
      // OData V4 wraps function results in { value: [...] }
      var aWarnings = (body.value || []).map(function (w) {
        var sUiState = w.severity === "CRITICAL" ? "Error"
                     : w.severity === "WARNING"  ? "Warning"
                     : "Information";
        var sUiIcon = w.severity === "CRITICAL" ? "sap-icon://alert"
                     : w.severity === "WARNING"  ? "sap-icon://warning"
                     : "sap-icon://information";
        var sSummary = w.daysRemaining < 0
          ? "Expired " + Math.abs(w.daysRemaining) + " day(s) ago"
          : w.daysRemaining === 0
          ? "Expires today"
          : "Expires in " + w.daysRemaining + " day(s)";
        return {
          key: w.key,
          summary: sSummary,
          uiState: sUiState,
          uiIcon: sUiIcon,
          rotationOwner: w.rotationOwner,
          rotationDocsUrl: w.rotationDocsUrl,
        };
      });
      oNotifModel.setData({ items: aWarnings });
    })
    .catch(function () {
      // Soft-fail: empty popover rather than blocking user. Warnings reload on next open.
      oNotifModel.setData({ items: [] });
    });

  oPopover.openBy(oButton);
},
```

### Admin-shell i18n bundle (NEW)

Create `app/admin-shell/webapp/i18n/i18n.properties` — **first time the admin-shell needs an i18n file**:

```properties
notificationsEmpty=No notifications. All tracked secrets are in good shape (or have no expiry tracked).
```

Register the bundle in `app/admin-shell/webapp/manifest.json`'s `models.i18n` block (mirror the per-tile pattern). This unblocks future i18n migration of hardcoded XML labels (`text="Joule Settings"`, `text="Knowledge Graph"`, etc.) — out of scope for this PR but explicitly enabled.

### Admin-shell wiring summary (5 locations, mirroring the pattern from #463)

1. `app/admin-shell/scripts/copy-components.js` — append `'secrets'` to COMPONENTS array.
2. `app/admin-shell/webapp/manifest.json` — `componentUsages`, target component-usage, target route-target, route entries.
3. `app/admin-shell/webapp/manifest.json` — register the new i18n model.
4. `app/admin-shell/webapp/view/Shell.view.xml` — `<NavigationListItem text="Secrets" key="secrets" />` in the System group.
5. `app/admin-shell/webapp/controller/Shell.controller.js` — `NAV_KEY_TO_ROUTE` + `NAV_KEY_TO_TITLE` entries (the 5th wiring location that #463's implementation missed and final-review caught).

---

## Seed script

`scripts/seed-secrets.cjs` — run via `npx cds bind --exec -- node scripts/seed-secrets.cjs`. Idempotent on `key`:

```javascript
#!/usr/bin/env node
// scripts/seed-secrets.cjs — One-shot seed of the 6 known tracked secrets.
//
// Idempotent on `key` — re-running is safe; existing rows are not touched.
// Add NEW tracked secrets via:
//   1) Admin UI at /admin-ui/#secrets, OR
//   2) Edit this file's INITIAL_SECRETS array + re-run.

const cds = require('@sap/cds');

const INITIAL_SECRETS = [
  {
    key: 'GITHUB_DISPATCH_TOKEN',
    description: 'Fine-grained GitHub PAT for workflow_dispatch on rebuild-content.yml.',
    kind: 'github-pat',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: 'https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/operations/github-dispatch-pat-rotation.md',
    expiresAt: null,  // PLACEHOLDER — admin sets actual expiry post-deploy
  },
  {
    key: 'CONTENT_API_KEY',
    description: 'Bearer token for POST /content/publish.',
    kind: 'content-api-key',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'SUBMISSION_SALT_SECRET',
    description: 'IP-hash salt for /feedback/submit rate-limiter. Rotation invalidates rate-limit keys.',
    kind: 'salt',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'SMTP_PASS',
    description: 'SMTP credential for outbound contributor-notifications mail.',
    kind: 'smtp-credential',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'TUTORIALS_GITHUB_TOKEN',
    description: 'GitHub PAT for CI tutorial-fetcher (CI-only — not on tutorials-srv).',
    kind: 'github-pat',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'AI_AUTHOR_AICORE_SERVICE_KEY',
    description: 'BTP service key for AI Core orchestration (CI-only). Vendor-defined rotation.',
    kind: 'service-key',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
];

async function main() {
  await cds.connect.to('db');
  const { Secrets } = cds.entities('com.sap.developers.ims');
  const existing = await SELECT.from(Secrets).columns('key');
  const existingKeys = new Set(existing.map(r => r.key));
  const toInsert = INITIAL_SECRETS.filter(s => !existingKeys.has(s.key));

  if (toInsert.length === 0) {
    console.log(`All ${INITIAL_SECRETS.length} known secrets already present — nothing to do.`);
    return;
  }

  await INSERT.into(Secrets).entries(toInsert);
  console.log(`Inserted ${toInsert.length} new tracked secrets:`);
  toInsert.forEach(s => console.log(`  - ${s.key} (${s.kind})`));
  console.log('');
  console.log('Next: visit /admin-ui/#secrets to set expiresAt + lastRotatedAt for each row.');
  console.log('The expiry-check cron (04:11 UTC daily) will surface warnings via the bell-icon popover.');
}

main()
  .catch(err => { console.error('Seed failed:', err.message); process.exit(1); })
  .finally(() => process.exit(0));
```

### Why these specifics

- **All 6 seeds ship with `expiresAt: null`.** Cron treats null = "never expires." Shipping placeholder dates would create false-positive warnings on day 1, training admins to ignore the popover (the boy-who-cried-wolf failure mode). Better to start silent and let admins explicitly opt-in to tracking.
- **`process.exit(0)` in `.finally()`** is needed because `@sap/cds` opens DB connections that don't auto-close. Without it, the script hangs after `main()` resolves. Pattern matches existing `scripts/setup-dev-data.cjs`.
- **`INITIAL_SECRETS` array is the source of truth for known secrets.** New tracked secrets get added here OR via the admin tile — both paths converge on the same DB rows.

---

## Tests

### Unit tests — `test/unit/jobs/secret-expiry-check.test.js`

In-memory SQLite via `cds.deploy()` bootstrap (mirrors `test/unit/runtime-config/kg-settings.test.js`). ~6 cases:

1. **`classifySeverity()` boundaries — `null` for `daysRemaining > 14`.**
2. **`classifySeverity()` — `INFO` for `7 < days ≤ 14`.**
3. **`classifySeverity()` — `WARNING` for `0 < days ≤ 7`.**
4. **`classifySeverity()` — `CRITICAL` for `days ≤ 0` (including negative = expired).**
5. **`runSecretExpiryCheck()` empty table** returns `{ total: 0, critical: 0, warning: 0, info: 0, criticalKeys: [] }`.
6. **`runSecretExpiryCheck()` mixed-severity rows** produces correct counts + truncates `criticalKeys` to 5 when there are >5 critical entries.

Test bootstrap pattern: `await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:')` in `beforeAll`, `DELETE.from(Secrets)` in `beforeEach`. Same pattern as the kg-settings test.

### Tests intentionally OUT of scope

- **Hybrid round-trip tests.** Stateless cron on a 7-column entity — the unit-test SQLite path covers the cases that matter; HANA-specific edge cases would only matter for the encrypted-values phase (Phase 2-C).
- **Smoke tests against `/admin/secretWarnings()`.** Pattern-matches existing function smoke; defer to a follow-up.
- **Admin tile UI tests.** Out of scope; manual smoke during DEV deploy.

---

## Documentation

`docs/developers/operations/secrets-tracking.md` — new doc, ~150 lines:

### Sections

1. **What** — `Secrets` entity tracks credential metadata, NOT values. Encrypted-value storage is Phase 2-C (#465).
2. **How to add a new tracked secret** — admin UI (`/admin-ui/#secrets` + Add button) OR edit `scripts/seed-secrets.cjs` `INITIAL_SECRETS` array + re-run via `npx cds bind --exec -- node scripts/seed-secrets.cjs`.
3. **How rotation owners receive warnings** — bell-icon popover in admin-shell, populated by `secretWarnings()` AdminService function. Future Phase 3+ may add email/GitHub-issue-comment notifiers.
4. **Glossary of `kind` enum values.**
5. **Cross-links** — research-design parent, #463/#465/#466 issues.

---

## Acceptance criteria (from issue #464)

- [ ] All 6 secrets above appear in the admin tile after running `seed-secrets.cjs`.
- [ ] Cron job runs daily at 04:11 UTC; emits a PipelineLog row each day.
- [ ] Notifications popover (bell icon) shows warnings for any Secret with `expiresAt` ≤ 14 days from today.
- [ ] Severity tiers correctly applied: red ≤ 0 days, yellow 1-7 days, blue 8-14 days, silent > 14 days.
- [ ] Optional: GitHub-issue-comment notifier — **explicitly out of scope** for this PR per brainstorming.

---

## Risks & open questions

| Risk | Mitigation |
| --- | --- |
| Admin sees stale popover data — clicked too quickly after editing a Secret. | The popover query is fresh on every open (no client cache). Race window is sub-second; not a real risk. |
| `secretWarnings()` function returns empty when run before `seed-secrets.cjs`. | First-deploy expectation: empty popover until admin runs the seed script. Documented in the post-deploy runbook. |
| `daysUntil` timezone drift around DST boundaries. | Uses `Date.UTC` truncation — DST-immune. The cron fires at 04:11 UTC, well outside any DST shift window. |
| Cron fires on multiple instances (multi-instance srv). | `runWithLock` distributed lock (existing scheduler pattern) prevents duplicate runs across CF instances. |
| `5th wiring location` regression (Shell.controller.js NAV maps) — same bug as #463 had. | Plan explicitly lists 5 admin-shell wiring locations; the controller's NAV_KEY_TO_ROUTE + NAV_KEY_TO_TITLE maps are the 5th. Added to a Phase-3 template note in the project memory. |
| `i18n.properties` bundle creation in admin-shell is the first time. | Mirror per-tile pattern verbatim. Manifest registration in `models.i18n` block. Empty-state label is the only key for now; future expansion is additive. |
| `mta.yaml` srv-qa cp drift between `srv` and `srv-qa`. | New `srv/jobs/secret-expiry-check.js` MUST be added to the `srv-qa` `cp` list at [.deploy/mta.yaml:97](../../../.deploy/mta.yaml#L97). Plan explicitly calls this out as a mandatory step. The cp is into an existing `srv/jobs/` subdirectory — no `mkdir -p` needed (unlike #463's new `srv/lib/runtime-config/` subdirectory). |
| Encryption-key debate stalls Phase 2-C. | This PR ships the visibility win independently. Phase 2-C (#465) is a separately-mergeable follow-up. |

---

## Out of scope

- **Encrypted-value columns + decryption.** Phase 2-C (#465).
- **GitHub-issue-comment notifier.** Phase 3+ if visibility-only proves insufficient.
- **Email notifier via mail-client.js.** Phase 3+ — same gating.
- **Automated rotation handlers.** Phase 3+ — research doc explicitly defers.
- **`lastNotifiedAt` / `warningTier` columns.** Cron is stateless; popover queries live.
- **Removing env vars from mtaext.** Stays through Phase 3 + soak window.
- **i18n migration of existing hardcoded admin-shell labels.** Bundle creation here unblocks it; actual migration is a separate cleanup PR.

---

## References

- Research-design parent: [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](2026-06-20-runtime-config-research-design.md), section "Secret rotation/expiry — Tom's sub-idea"
- Sibling spec (Phase 2-A, just shipped via PR #471): [docs/superpowers/specs/2026-06-20-issue-463-runtime-config-foundation-design.md](2026-06-20-issue-463-runtime-config-foundation-design.md)
- Issue: [#464](https://github.com/sap-tutorials/tutorials-ims/issues/464)
- Precedent files: [srv/lib/rebuild-trigger.js](../../../srv/lib/rebuild-trigger.js) (GitHub API + native fetch pattern, in case we ever add the issue-comment notifier in Phase 3+), [srv/jobs/scheduler.js](../../../srv/jobs/scheduler.js) (cron registration pattern), [app/admin/knowledgeGraph/webapp/](../../../app/admin/knowledgeGraph/webapp/) (custom-XML admin tile precedent), [scripts/setup-dev-data.cjs](../../../scripts/setup-dev-data.cjs) (one-shot seed-script precedent).
- Memory: [feedback_cap_csv_seeds_clobber_admin_data], [feedback_srv_qa_cp_list_recurring], [feedback_subagent_writes_can_leak_to_parent_repo], [feedback_default_off_flags_need_live_smoke], [project_463_runtime_config_foundation_shipped] (5th wiring location lesson).
