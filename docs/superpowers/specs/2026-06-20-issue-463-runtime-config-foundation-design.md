# Phase 2-A: Runtime-config foundation + Knowledge Graph migration — design

**Issue:** [#463](https://github.com/sap-tutorials/tutorials-ims/issues/463) — first migration of the runtime-config pattern from research issue [#444](https://github.com/sap-tutorials/tutorials-ims/issues/444).

**Date:** 2026-06-20

**Research-design parent:** [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](2026-06-20-runtime-config-research-design.md)

## TL;DR

Migrate 4 Knowledge Graph env vars (`KNOWLEDGE_GRAPH_ENABLED`, `KG_EXTRACT_BUILD_CAP`, `KG_MERGE_SIM_THRESHOLD`, `KG_MERGE_SIM_THRESHOLD_EXTRACT`) to a `KnowledgeGraphSettings` HANA singleton entity, with a self-contained resolver lib (`srv/lib/runtime-config/kg-settings.js`) that layers DB row → env → hardcoded default and caches with a 5-second LRU TTL. Add a custom-XML admin tile mirroring the existing Joule pattern. Backwards-compatible: empty DB row preserves current env-var behavior, so revert is safe.

This PR establishes the **template** that Phase 2-B (#464), 2-C (#465), and Phase 3 (#466) follow-ups replicate per-domain.

---

## Implementation choices made during brainstorming

| Decision | Choice |
| --- | --- |
| Resolver lib structure | **Self-contained `kg-settings.js`** — do NOT refactor `chat-settings-resolver` yet. Extract a base helper later in Phase 3 once 3+ resolvers exist to inform the abstraction. |
| Admin tile shape | **Custom XML form** mirroring the existing Joule tile (`sap.m.Switch` + `sap.m.Input` × 4 in a `f:SimpleForm`) — NOT Fiori Elements ObjectPage. |
| Cron flag-flip lag | **Per-tick re-read.** Cron jobs (`extract-concepts-job`, `consolidate-concepts-job`) call `resolveKnowledgeGraphSettings()` once at the top of `run()`. Flag flip applies on the next tick. No mid-tick re-reads. |
| Boolean null semantics | **`null → fall through to env`.** `row.enabled === false` is admin-explicit OFF; `row.enabled === null` (or empty row) reads the env var. Preserves backwards-compat after first deploy. |
| Test depth | **Unit + hybrid happy-path.** ~6 unit tests in `test/unit/runtime-config/`, ~2 hybrid round-trip tests in `test/hybrid/`. No smoke tests this PR. |
| Folder name | **`app/admin/knowledgeGraph/`** (camelCase) — NOT kebab. Hyphens collide with Fiori semantic-navigation `Object-action` separators. |

---

## File structure

```text
db/schema.cds
  + entity KnowledgeGraphSettings : cuid, managed { 4 columns }   (~10 lines)

db/data/com.sap.developers.ims-KnowledgeGraphSettings.csv
  + header-only (must stay empty per feedback_cap_csv_seeds_clobber_admin_data)

srv/admin-service.cds
  + @odata.singleton @requires:'Admin' projection on KnowledgeGraphSettings

srv/lib/runtime-config/
  + kg-settings.js   (~110 lines, self-contained, 5s LRU TTL)

srv/knowledge-graph-service.js   (modify line 439, line 698)
  ~ swap process.env.KNOWLEDGE_GRAPH_ENABLED + process.env.KG_MERGE_SIM_THRESHOLD
    for resolveKnowledgeGraphSettings()

srv/jobs/extract-concepts-job.js   (modify lines 124-131)
  ~ swap two process.env reads for one resolver call
  ~ ADD `if (!kg.enabled) return` gate (behavior tightening — see "Behavior changes")

srv/jobs/consolidate-concepts-job.js   (modify lines 61-69)
  ~ swap process.env.KG_MERGE_SIM_THRESHOLD for resolver
  ~ ADD `if (!kg.enabled) return` gate

app/admin/knowledgeGraph/webapp/
  + manifest.json                        (sap.m only, mirrors Joule)
  + Component.js
  + index.html
  + view/Settings.view.xml               (Switch + 3 Inputs in SimpleForm)
  + controller/Settings.controller.js    (~80 lines, fetch-based load + PATCH)
  + i18n/i18n.properties

app/admin-shell/webapp/manifest.json   (modify)
  ~ add componentUsages.knowledgeGraph entry mirroring `joule`
  ~ add navigation tile

test/unit/runtime-config/kg-settings.test.js
  + 6 unit tests

test/hybrid/runtime-config.test.js
  + 2 hybrid round-trip tests (CAP path + raw-SQL UPPERCASE path)

deploy/dev.mtaext, deploy/qa.mtaext, deploy/prod.mtaext
  ~ unchanged. Env vars stay in mtaext for backwards-compat through Phase 3 + soak window.
```

---

## CDS schema

Append below `ChatSettings` in [db/schema.cds](../../../db/schema.cds):

```cds
// Phase 2-A foundation. Mirrors the ChatSettings singleton pattern (#444).
// Resolver at srv/lib/runtime-config/kg-settings.js layers DB > env > default.
// CSV seed at db/data/...-KnowledgeGraphSettings.csv MUST stay empty so HDI
// redeploy doesn't clobber operator-set values (see feedback_cap_csv_seeds_clobber_admin_data).
//
// All 4 columns are nullable on purpose. Null means "fall through to env"
// in the resolver. With a fresh deploy + no row + KNOWLEDGE_GRAPH_ENABLED=true
// in mtaext, behavior is identical to today. After an admin saves the row,
// DB values win.
entity KnowledgeGraphSettings : cuid, managed {
  enabled                    : Boolean;
  extractBuildCap            : Integer       @assert.range: [0, 100000];
  mergeSimThreshold          : Decimal(3, 2) @assert.range: [0.01, 1.00];
  mergeSimThresholdExtract   : Decimal(3, 2) @assert.range: [0.01, 1.00];
}
```

`@assert.range` defends both the resolver and the admin UI: HANA enforces it at write time, Fiori Elements surfaces it as a validation hint, and a runaway value (e.g. `extractBuildCap = 1_000_000`) can't reach the cron job. `0` is intentionally allowed for `extractBuildCap` — it means "make zero LLM calls this tick" (effective dry-run mode).

`Decimal(3, 2)` matches the existing precedent at [db/schema.cds:469](../../../db/schema.cds#L469) (`ChatSettings.temperature`), so HANA rejects on floor/ceiling are already proven safe in this schema.

### AdminService projection

In [srv/admin-service.cds](../../../srv/admin-service.cds), add a sibling to the existing `ChatSettings` projection:

```cds
@odata.singleton
@requires: 'Admin'
entity KnowledgeGraphSettings as projection on ims.KnowledgeGraphSettings;
```

`@odata.singleton` makes the OData URL `/admin/KnowledgeGraphSettings` (no key suffix) — clients don't need to know the row's UUID. `@requires:'Admin'` enforces XSUAA scope.

**Change-tracking** (NOT audit-logging — they're different plugins with different sinks). Add to [db/change-tracking.cds](../../../db/change-tracking.cds), mirroring the existing `ChatSettings` line at [db/change-tracking.cds:17](../../../db/change-tracking.cds#L17):

```cds
annotate ims.KnowledgeGraphSettings with @changelog;
```

`@cap-js/change-tracking` writes mutations to the `ChangeLog` entity, surfaced via the existing admin tile at `/admin-ui/#changelog-display`. The `@cap-js/audit-logging` plugin is a different mechanism — it requires `@PersonalData` field-level annotations (used today on Users / TaskRecords / etc., not on ChatSettings or other config entities). The KG settings entity carries no personal data, so change-tracking is the correct plugin.

### CSV seed (empty)

`db/data/com.sap.developers.ims-KnowledgeGraphSettings.csv`:

```csv
ID
```

Header only. HDI deploy creates the table empty; resolver falls through to env vars; identical to current behavior. **MUST stay empty** — see [feedback_cap_csv_seeds_clobber_admin_data](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_cap_csv_seeds_clobber_admin_data.md). Future admin edits would be re-clobbered on every deploy if a non-empty CSV ships.

---

## Resolver lib

`srv/lib/runtime-config/kg-settings.js`:

```javascript
// srv/lib/runtime-config/kg-settings.js
// Resolves the 4 Knowledge Graph runtime knobs. Layered precedence:
//   1. KnowledgeGraphSettings row (CDS-via-cds.entities)
//   2. KnowledgeGraphSettings raw-SQL UPPERCASE (HANA build-pipeline path)
//   3. process.env.KNOWLEDGE_GRAPH_ENABLED / KG_EXTRACT_BUILD_CAP /
//      KG_MERGE_SIM_THRESHOLD / KG_MERGE_SIM_THRESHOLD_EXTRACT
//   4. Hardcoded defaults: enabled=false, cap=200, thresholds 0.92/0.85
//
// 5-second LRU TTL. Hot-path consumers (knowledge-graph-service.js per-request
// gate) hit cache; cron consumers (extract/consolidate jobs) call once per tick.
//
// Backwards-compatible: with an empty DB row, behavior is identical to the
// current process.env reads in the 3 consumer files. Reverting this PR is safe.
//
// Pattern derived from srv/lib/chat-settings-resolver.js (#318). Self-contained
// per Phase 2-A spec — base helper extraction deferred to Phase 3.

import cds from '@sap/cds';
import { LRUCache } from 'lru-cache';

const LOG = cds.log('kg-settings-resolver');

const CACHE_KEY = 'kg-settings';
const cache = new LRUCache({ max: 1, ttl: 5_000 });

const DEFAULTS = {
  enabled: false,
  extractBuildCap: 200,
  mergeSimThreshold: 0.92,
  mergeSimThresholdExtract: 0.85,
};

/** Read the singleton row, tolerant of build-pipeline contexts where
 *  cds.entities() isn't initialized yet. Returns null on any failure. */
async function readRow() {
  try {
    if (typeof cds.entities === 'function') {
      const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
      return (await SELECT.one.from(KnowledgeGraphSettings)) ?? null;
    }
    const db = await cds.connect.to('db');
    const rows = await db.run(
      'SELECT enabled, extractBuildCap, mergeSimThreshold, mergeSimThresholdExtract ' +
      'FROM COM_SAP_DEVELOPERS_IMS_KNOWLEDGEGRAPHSETTINGS LIMIT 1'
    );
    return rows?.[0] ?? null;
  } catch (err) {
    LOG.warn('KnowledgeGraphSettings read failed; using env-var defaults', err.message);
    return null;
  }
}

/** HANA returns UPPERCASE column names from raw db.run; CAP returns lowercase. */
function pick(row, lower, upper) {
  if (row == null) return null;
  const v = row[lower];
  if (v !== undefined && v !== null) return v;
  const u = row[upper];
  return u !== undefined && u !== null ? u : null;
}

function envFlag(name) {
  const v = process.env[name];
  if (v === undefined) return null;
  return v === 'true';
}

function envNumber(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve all 4 knobs at once. Returns a fully-populated object (no nulls).
 * @returns {Promise<{ enabled: boolean, extractBuildCap: number,
 *                     mergeSimThreshold: number, mergeSimThresholdExtract: number }>}
 */
export async function resolveKnowledgeGraphSettings() {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;

  const row = await readRow();

  const settings = {
    enabled:
      pick(row, 'enabled', 'ENABLED')
      ?? envFlag('KNOWLEDGE_GRAPH_ENABLED')
      ?? DEFAULTS.enabled,
    extractBuildCap:
      pick(row, 'extractBuildCap', 'EXTRACTBUILDCAP')
      ?? envNumber('KG_EXTRACT_BUILD_CAP')
      ?? DEFAULTS.extractBuildCap,
    mergeSimThreshold:
      pick(row, 'mergeSimThreshold', 'MERGESIMTHRESHOLD')
      ?? envNumber('KG_MERGE_SIM_THRESHOLD')
      ?? DEFAULTS.mergeSimThreshold,
    mergeSimThresholdExtract:
      pick(row, 'mergeSimThresholdExtract', 'MERGESIMTHRESHOLDEXTRACT')
      ?? envNumber('KG_MERGE_SIM_THRESHOLD_EXTRACT')
      ?? DEFAULTS.mergeSimThresholdExtract,
  };

  cache.set(CACHE_KEY, settings);
  return settings;
}

/** Test-only: clear the cache so a unit test can assert TTL behavior or
 *  exercise a fresh read after seeding a row. Not exported through any
 *  public surface. */
export function _resetCacheForTests() {
  cache.clear();
}
```

### Why these specific design choices

- **Nullish-coalesce (`??`), not OR (`||`).** `||` would mistake `enabled: false` (admin explicit OFF) for "fallback to env." `??` only falls through `null`/`undefined` and preserves admin-set false. Same applies to `extractBuildCap: 0` (dry-run mode).
- **`pick()` helper.** With 4 fields × 2 case variants, repeating inline OR-chains would be 8 falls per call. The helper makes the precedence chain readable as 4 logical lines.
- **`max: 1` LRU.** The cache holds exactly one key (`'kg-settings'`). LRU is overkill for a singleton, but it gives battle-tested TTL semantics for free — no manual `Date.now()` arithmetic, no edge cases. Same library is already a dependency (used by `srv/lib/content-store.js`).
- **No throw on missing row.** Unlike `chat-settings-resolver.js` which throws when `deploymentId` ends up null (because no fallback can save you on AI Hub calls), the KG resolver always has a hardcoded default. Worst case is "feature off, default cap, default thresholds" — never a runtime error.
- **`_resetCacheForTests` export.** Underscore-prefix signals "internal." Tests need this — otherwise a TTL test takes 5+ seconds of real time per case, and write-then-read-fresh tests fight stale cache. Pattern matches `srv/lib/embedding-query.js`.

---

## Consumer conversions

### `srv/knowledge-graph-service.js`

Two reads to convert. Per-request hot path on line 439:

```javascript
// Before:
if (process.env.KNOWLEDGE_GRAPH_ENABLED !== 'true') {
  // ...return 503
}

// After:
const kg = await resolveKnowledgeGraphSettings();
if (!kg.enabled) {
  // ...return 503
}
```

Threshold read on line 698:

```javascript
// Before:
const thresholdRaw = process.env.KG_MERGE_SIM_THRESHOLD;
// ...parse + bounds check inline

// After:
const { mergeSimThreshold: MERGE_THRESHOLD } = await resolveKnowledgeGraphSettings();
// resolver returns Number; @assert.range enforces bounds at write time
```

### `srv/jobs/extract-concepts-job.js`

Top of `run()` (lines 124-131), the env-var reads collapse into one resolver call:

```javascript
// Before:
const capRaw = process.env.KG_EXTRACT_BUILD_CAP;
const buildCap = capRaw !== undefined ? Number(capRaw) : 200;
const thresholdRaw = Number(process.env.KG_MERGE_SIM_THRESHOLD_EXTRACT);
const MERGE_THRESHOLD = Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 1
  ? thresholdRaw : 0.85;

// After:
const kg = await resolveKnowledgeGraphSettings();
if (!kg.enabled) return;
const { extractBuildCap: buildCap, mergeSimThresholdExtract: MERGE_THRESHOLD } = kg;
```

### `srv/jobs/consolidate-concepts-job.js`

Top of `run()` (lines 61-69):

```javascript
// Before:
const thresholdRaw = process.env.KG_MERGE_SIM_THRESHOLD;
const MERGE_THRESHOLD = Number.isFinite(Number(thresholdRaw))
  ? Number(thresholdRaw) : 0.92;

// After:
const kg = await resolveKnowledgeGraphSettings();
if (!kg.enabled) return;
const { mergeSimThreshold: MERGE_THRESHOLD } = kg;
```

Both `runExtractConcepts` and `runConsolidateConcepts` are already `async` (verified at `srv/jobs/extract-concepts-job.js:115` and `srv/jobs/consolidate-concepts-job.js:52`), so no signature changes needed.

### Behavior changes

**This PR introduces one intentional behavior tightening** beyond a literal env→DB swap: the two cron jobs now gate on `kg.enabled`. Today, flipping `KNOWLEDGE_GRAPH_ENABLED=false` only stops the HTTP gate; the cron jobs keep extracting and consolidating concepts in the background, and writes still hit the DB. Phase 2-A makes the flag actually mean "stop."

This is the obviously-correct behavior — and an admin who sees `Enabled = OFF` in the new tile would be surprised if cron writes kept happening — but it IS a behavior change that anyone reviewing the PR diff should be aware of. Call it out in the PR body and the spec.

---

## Admin tile

`app/admin/knowledgeGraph/webapp/`, mirroring [app/admin/joule/webapp/](../../../app/admin/joule/webapp/) shape exactly.

### `manifest.json`

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.knowledgeGraph",
    "type": "application",
    "title": "{{appTitle}}",
    "i18n": "i18n/i18n.properties"
  },
  "sap.ui5": {
    "rootView": {
      "viewName": "sap.tutorials.admin.knowledgeGraph.view.Settings",
      "type": "XML",
      "id": "settings",
      "async": true
    },
    "dependencies": {
      "minUI5Version": "1.136.0",
      "libs": { "sap.m": {}, "sap.ui.core": {}, "sap.ui.layout": {} }
    },
    "models": {
      "i18n": {
        "type": "sap.ui.model.resource.ResourceModel",
        "settings": { "bundleName": "sap.tutorials.admin.knowledgeGraph.i18n.i18n" }
      }
    },
    "contentDensities": { "compact": true, "cozy": true }
  }
}
```

### `view/Settings.view.xml`

```xml
<mvc:View
  controllerName="sap.tutorials.admin.knowledgeGraph.controller.Settings"
  xmlns:mvc="sap.ui.core.mvc"
  xmlns="sap.m"
  xmlns:f="sap.ui.layout.form"
  height="100%">
  <ScrollContainer height="100%" width="100%" vertical="true" horizontal="false">
    <VBox class="sapUiMediumMargin">
      <Title text="{i18n>pageTitle}" level="H2" class="sapUiSmallMarginBottom" />
      <MessageStrip
        text="{i18n>infoStrip}"
        type="Information"
        showIcon="true"
        class="sapUiSmallMarginBottom" />

      <Panel headerText="{i18n>generalHeader}" class="sapUiSmallMarginBottom">
        <f:SimpleForm editable="true" layout="ResponsiveGridLayout">
          <Label text="{i18n>fieldEnabled}" />
          <Switch state="{settings>/enabled}" />

          <Label text="{i18n>fieldExtractBuildCap}" />
          <Input value="{settings>/extractBuildCap}" type="Number"
                 placeholder="{i18n>placeholderExtractBuildCap}" />

          <Label text="{i18n>fieldMergeSimThreshold}" />
          <Input value="{settings>/mergeSimThreshold}" type="Number"
                 placeholder="{i18n>placeholderMergeSimThreshold}" />

          <Label text="{i18n>fieldMergeSimThresholdExtract}" />
          <Input value="{settings>/mergeSimThresholdExtract}" type="Number"
                 placeholder="{i18n>placeholderMergeSimThresholdExtract}" />
        </f:SimpleForm>
      </Panel>

      <HBox justifyContent="End">
        <Button text="{i18n>buttonReload}" press=".onReload" />
        <Button text="{i18n>buttonSave}" type="Emphasized" press=".onSave"
                class="sapUiTinyMarginBegin" />
      </HBox>
    </VBox>
  </ScrollContainer>
</mvc:View>
```

Save button is **always enabled** — Joule controller does not implement dirty-tracking, and `JSONModel.attachPropertyChange` does NOT fire for two-way binding leaf mutations from `<Input value="{settings>/x}" />` (it only fires on explicit `setProperty()` calls). Mirroring the Joule precedent verbatim avoids inheriting a non-existent dirty flag.

### `controller/Settings.controller.js`

```javascript
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, MessageToast, MessageBox) {
  "use strict";

  return Controller.extend("sap.tutorials.admin.knowledgeGraph.controller.Settings", {
    onInit: function () {
      var oJSON = new JSONModel({
        enabled: false,
        extractBuildCap: null,
        mergeSimThreshold: null,
        mergeSimThresholdExtract: null
      });
      this.getView().setModel(oJSON, "settings");
      this._loadSettings();
    },

    _loadSettings: function () {
      var oModel = this.getView().getModel("settings");
      fetch("/admin/KnowledgeGraphSettings", {
        credentials: "include",
        headers: { "Accept": "application/json" }
      })
        .then(function (res) {
          if (!res.ok) { throw new Error("HTTP " + res.status); }
          return res.json();
        })
        .then(function (data) {
          oModel.setData({
            enabled: !!data.enabled,
            extractBuildCap: data.extractBuildCap != null ? data.extractBuildCap : null,
            mergeSimThreshold: data.mergeSimThreshold != null ? data.mergeSimThreshold : null,
            mergeSimThresholdExtract: data.mergeSimThresholdExtract != null ? data.mergeSimThresholdExtract : null
          });
        })
        .catch(function (err) {
          MessageToast.show("Failed to load settings: " + err.message);
        });
    },

    onReload: function () {
      this._loadSettings();
    },

    onSave: function () {
      var data = this.getView().getModel("settings").getData();
      var cap = data.extractBuildCap === "" || data.extractBuildCap == null ? null : parseInt(data.extractBuildCap, 10);
      var t1  = data.mergeSimThreshold === "" || data.mergeSimThreshold == null ? null : Number(data.mergeSimThreshold);
      var t2  = data.mergeSimThresholdExtract === "" || data.mergeSimThresholdExtract == null ? null : Number(data.mergeSimThresholdExtract);
      var body = {
        enabled: !!data.enabled,
        extractBuildCap: cap,
        mergeSimThreshold: t1,
        mergeSimThresholdExtract: t2
      };

      // CSRF round-trip: HEAD /admin/$metadata returns the token; PATCH echoes it.
      // CAP enforces CSRF on writes; no exemption for /admin/. Joule does the same.
      fetch("/admin/$metadata", {
        method: "HEAD",
        credentials: "include",
        headers: { "x-csrf-token": "fetch" }
      })
        .then(function (res) {
          return res.headers.get("x-csrf-token") || "";
        })
        .then(function (token) {
          return fetch("/admin/KnowledgeGraphSettings", {
            method: "PATCH",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "x-csrf-token": token
            },
            body: JSON.stringify(body)
          });
        })
        .then(function (res) {
          if (!res.ok) { throw new Error("HTTP " + res.status); }
          MessageToast.show("Saved");
        })
        .catch(function (err) {
          MessageBox.error("Save failed: " + err.message);
        });
    }
  });
});
```

Pattern is line-for-line equivalent to [app/admin/joule/webapp/controller/Settings.controller.js](../../../app/admin/joule/webapp/controller/Settings.controller.js) for the CSRF round-trip, `credentials: "include"`, and JSONModel usage. **No dirty flag** — Save is always enabled; Reload always reloads.

### `i18n/i18n.properties`

```properties
appTitle=Knowledge Graph Settings
pageTitle=Knowledge Graph Settings
generalHeader=General
infoStrip=Changes take effect within 5 seconds across all server instances. Cron jobs honor flag changes on the next tick.
fieldEnabled=Enabled
fieldExtractBuildCap=Extract Build Cap (LLM calls per tick)
fieldMergeSimThreshold=Consolidator Merge Threshold (0.01 — 1.00)
fieldMergeSimThresholdExtract=Extract-time Merge Threshold (0.01 — 1.00)
placeholderExtractBuildCap=200
placeholderMergeSimThreshold=0.92
placeholderMergeSimThresholdExtract=0.85
buttonSave=Save
buttonReload=Reload
```

The `infoStrip` is real UX honesty: without it, an admin who flips Enabled and immediately checks `/graph/*` and sees it still working will think the toggle is broken. This is the [feedback_default_off_flags_need_live_smoke](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_default_off_flags_need_live_smoke.md) lesson applied at the UI layer.

### `Component.js` and `index.html`

Standard UI5 component shell, mirroring `app/admin/joule/webapp/`. ~10 lines combined.

### Admin-shell wiring

In `app/admin-shell/webapp/manifest.json`, add a `componentUsages` entry mirroring the existing `joule` entry, plus a navigation tile entry that points to the same destination. Approximately 20-30 lines added; pattern is mechanical and proven from every existing tile.

In `app/admin-shell/webapp/i18n/i18n.properties`, add the side-nav label key (e.g. `nav.knowledgeGraph=Knowledge Graph`). One line.

`mta.yaml`: the `cp -r ../app/<tile>/webapp/. static/admin-ui/components/<tile>/` pattern is already established. Adding `knowledgeGraph` to that list of `cp` targets is one line in [.deploy/mta.yaml](../../../.deploy/mta.yaml).

---

## Tests

### Unit tests — `test/unit/runtime-config/kg-settings.test.js`

In-memory SQLite, ~6 cases:

1. **Hardcoded defaults** when DB empty + env unset.
2. **Env-var fallback** when DB row absent.
3. **DB row wins** over env var (admin override of env).
4. **Null DB column** falls through to env var.
5. **Cache hit** within 5s TTL — second read returns cached value even after row mutation.
6. **Cache reset** returns fresh row (simulating TTL expiry via `_resetCacheForTests`).

**Test bootstrap:** Each test file MUST call `cds.test('serve')` (or use `vitest.config.ts`'s existing test-context wiring — verify the project's pattern in `test/unit/` siblings before writing) so `cds.entities('com.sap.developers.ims')` is populated before the resolver's `readRow()` runs. Without this, the unit tests fail with an opaque `Cannot read property KnowledgeGraphSettings of undefined`. Pattern lives in existing unit-test files; this spec doesn't dictate the exact bootstrap line because it's project convention.

### Hybrid tests — `test/hybrid/runtime-config.test.js`

Real HANA via `cds bind --exec`, 2 cases:

1. **CAP path round-trip.** Write via `INSERT.into(KnowledgeGraphSettings)`, read back via resolver, verify all 4 fields.
2. **Raw-SQL UPPERCASE path round-trip.** Write via raw `db.run(...)` (simulating build-pipeline context where `cds.entities` isn't initialized), read back, verify resolver picks UPPERCASE column names.

Both use `ensureWriteAllowed()` from `test/hybrid/_guard.js` and clean up via `afterAll`. Test rows are tagged with random UUIDs and tracked in a `cleanup` array.

### Tests intentionally OUT of scope

- **Smoke tests against deployed admin endpoint.** Pattern-matches existing tile-smoke, defer to a follow-up.
- **Change-tracking entry verification.** `@cap-js/change-tracking` is plugin-driven; coverage exists at the plugin level, no project-specific test needed for this PR.
- **`extractBuildCap === 0` edge case.** The nullish-coalesce `0 ?? 200 → 0` preserves it correctly. No additional test; covered as a comment in the schema.
- **OData V4 contract test.** The projection is a one-liner against an existing pattern; smoke would catch any regression on first deploy.

---

## Backwards-compatibility & rollback

The PR is **revertible mid-flight** without breaking anything:

1. **Empty DB row + existing env vars in mtaext** = identical behavior to today.
2. Reverting the PR removes the `KnowledgeGraphSettings` table, the resolver, and the admin tile. Code consumers fall back to direct `process.env.X` reads. Env vars stay set in mtaext (they don't get removed until Phase 3 + soak window).
3. The HDI delta on a deploy that re-creates the table from a missing state DROPS the now-orphaned table on the next `db-deployer` push. No data loss because the table is empty.

The env-var-still-in-mtaext invariant is the safety net for all of Phase 2 + Phase 3. Spec [2026-06-20-runtime-config-research-design.md](2026-06-20-runtime-config-research-design.md) commits to keeping env vars through Phase 3 + a soak window before any deletion PR.

---

## Risks & open questions

| Risk | Mitigation |
| --- | --- |
| Cron job behavior tightening (gate on `kg.enabled`) silently changes prod behavior on first DEV deploy where someone was using `KNOWLEDGE_GRAPH_ENABLED=false` to stop cron writes via env. | Today the env-var pattern is strict — `process.env.KNOWLEDGE_GRAPH_ENABLED !== 'true'` blocks the HTTP gate. Cron jobs DON'T currently honor it (verified at [srv/jobs/extract-concepts-job.js:115](../../../srv/jobs/extract-concepts-job.js#L115) — no env check before the body runs). PR diff comment + PR body call this out as the intentional behavior change. The change is the obviously-correct one — env was misleading admins about what the flag did. |
| HANA HDI rejects `Decimal(3, 2)` columns with no default on first deploy. | Same precision/scale as `ChatSettings.temperature` at [db/schema.cds:469](../../../db/schema.cds#L469); proven safe in this schema. **Do NOT widen to `Decimal(4, 2)` "to be safe"** — `Decimal(3, 2)` represents `0.00`–`9.99` and the bounds `0.01`–`1.00` fit. Parity with `ChatSettings.temperature` matters for HANA-rejection symmetry. |
| Admin saves null Boolean (cleared the field), expecting "use env var" — but writes a non-null entity with explicit null field; resolver correctly falls through to env. | Clarified in the `null DB column → env` unit test. The admin UI's `Switch` widget can't write null (only true/false), so this only matters for direct OData writes (e.g. via Postman). Acceptable surface. |
| Concurrent `knowledge-graph-service` requests trigger N parallel `readRow()` calls within the same first 5s window before cache populates. | LRU `set` is synchronous; multiple parallel requests racing to populate the same key all complete the read and overwrite each other harmlessly. Worst case: ~3-5 redundant DB reads in the first 5s after server boot. Negligible. |
| `extractBuildCap === 0` cron edge case (today's "dry-run" knob via env) is now redundant in cron path because `if (!kg.enabled) return` short-circuits before the cap is read. | Acceptable — the canonical way to halt extraction is `enabled = false`; `cap = 0` was always a workaround. The hot-path `knowledge-graph-service.js` consumer still reads the cap, so the value retains semantic meaning for any future per-request consumer. Resolver's nullish-coalesce (`0 ?? 200 → 0`) preserves the value correctly via `pick()`'s `!== null` guard. |
| `mta.yaml` `cp` target list drift between `srv` and `srv-qa` (per [feedback_srv_qa_cp_list_recurring](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_srv_qa_cp_list_recurring.md)). | The new module is in a NEW subdirectory `srv/lib/runtime-config/`. The srv-qa cp step is a flat-file `cp` chain at [.deploy/mta.yaml:97](../../../.deploy/mta.yaml#L97). **Two edits required**, mirroring the existing `srv/lib/branch/` precedent: (a) add `mkdir -p srv/lib/runtime-config` to the `bash -c "..."` chain, and (b) add a separate `cp ../../srv/lib/runtime-config/kg-settings.js srv/lib/runtime-config/` after that mkdir. Without this, srv-qa boot crashes on the first `import` of the resolver. Plan should explicitly call this out as a mandatory step. |

---

## Acceptance criteria (from issue #463)

- [ ] All 4 KG env vars resolve from DB → env → default in tested order (verified via 6 unit tests).
- [ ] Admin tile shows + edits + saves all 4 values (manual smoke during DEV deploy + tile loads from `/admin-ui/#knowledgeGraph-display`).
- [ ] Change-tracking entry on every write to `KnowledgeGraphSettings` (via existing `@cap-js/change-tracking` plugin; verified by checking `ChangeLog` table after admin save and confirming the entry appears in `/admin-ui/#changelog-display`).
- [ ] 5-second TTL verified via test (write DB row → first read returns new value within 5s, second read within window returns cache).
- [ ] Existing env-var path still works when no DB row + env var set (regression test).
- [ ] CSV seed is empty so HDI redeploy doesn't clobber operator-set values.
- [ ] **PR body and release notes call out the cron behavior tightening** — `extract-concepts-job` and `consolidate-concepts-job` now early-return when `KnowledgeGraphSettings.enabled` is OFF. Previously these jobs ran regardless of `KNOWLEDGE_GRAPH_ENABLED`. Operators relying on the (broken) env-flag-stops-cron behavior should set `enabled = false` in the new tile after first deploy.
- [ ] **`.deploy/mta.yaml` srv-qa cp chain updated** — `mkdir -p srv/lib/runtime-config` and a separate `cp` line for the new resolver module added to the `bash -c "..."` chain at line 97. Verified by inspecting srv-qa boot logs after deploy.

---

## Out of scope

- **Migrating any env var beyond KG.** Phase 3 (#466) covers Batch 2/3.
- **Encrypted secrets.** Phase 2-B (#464) and 2-C (#465).
- **Push-based hot-reload.** Research doc rejected; revisit if a sub-second use case appears.
- **`AI_AUTHOR_ENABLED`.** Build-time only (0 srv consumers per the research-doc inventory).

---

## References

- Research-design parent: [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](2026-06-20-runtime-config-research-design.md)
- Issue: [#463](https://github.com/sap-tutorials/tutorials-ims/issues/463)
- Precedent files: [srv/lib/chat-settings-resolver.js](../../../srv/lib/chat-settings-resolver.js), [db/schema.cds:465-487](../../../db/schema.cds#L465-L487) `ChatSettings` entity, [srv/admin-service.cds:82-89](../../../srv/admin-service.cds#L82-L89) `ChatSettings` projection, [app/admin/joule/webapp/](../../../app/admin/joule/webapp/) custom-XML tile precedent.
- Memory: [feedback_cap_csv_seeds_clobber_admin_data](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_cap_csv_seeds_clobber_admin_data.md), [feedback_default_off_flags_need_live_smoke](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_default_off_flags_need_live_smoke.md), [feedback_cds_entities_runtime_only](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_cds_entities_runtime_only.md), [feedback_srv_qa_cp_list_recurring](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_srv_qa_cp_list_recurring.md), [project_318_319_resolver_and_telemetry_shipped](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\project_318_319_resolver_and_telemetry_shipped.md).
