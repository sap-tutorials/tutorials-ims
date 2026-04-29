# Admin UI Design Spec

**Date:** 2026-04-29  
**Status:** Draft  
**Scope:** Recreate all 11 IMS admin pages as CAP Fiori Elements + freestyle SAPUI5

---

## 1. Context & Goals

The existing IMS admin frontend is a React 15 SPA with 11 pages for managing tutorials, missions, events, user progress, analytics, and GDPR compliance. It communicates with the Java IMS backend via REST/HAL.

We are replacing it with a SAPUI5-based admin UI that:

- Consumes the existing CAP `AdminService` (OData V4 at `/admin`)
- Uses **Fiori Elements** (annotation-driven) for all CRUD pages
- Uses a **freestyle SAPUI5 app** for analytics, dashboard, export, and GDPR pages
- Runs inside a **Fiori Launchpad sandbox** with tile-based navigation
- Is served by the **existing AppRouter** via the HTML5 Application Repository
- Maintains all existing functionality while leveraging CAP patterns (drafts, compositions, value helps)

### Non-Goals

- No changes to the DeveloperService or DisplayService
- No changes to the existing Vue 3 apps in `apps/`
- No migration of end-user-facing UI (only admin)

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Existing AppRouter                   │
│  xs-app.json routes:                                 │
│    /admin-ui/** → HTML5 App Repo (Fiori apps)       │
│    /admin/**    → CAP backend (OData V4)            │
│    /apps/**     → Static Vue builds                  │
│    /**          → Static VitePress site              │
└─────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
┌─────────────────┐    ┌──────────────────────────┐
│  HTML5 App Repo  │    │   CAP AdminService       │
│                  │    │   @path: '/admin'         │
│  - 7 FE apps    │    │   @requires: 'Admin'      │
│  - 1 freestyle  │    │                           │
│  - FLP sandbox  │    │   27 entities + actions   │
└─────────────────┘    └──────────────────────────────┘
```

### Directory Convention

- **`app/`** — SAPUI5/Fiori Elements admin interface (new)
- **`apps/`** — Vue 3 public frontends (existing, unchanged)

These serve different audiences (internal admins vs. external developers), use different frameworks (SAPUI5 vs. Vue 3), and have different build toolchains (UI5 CLI vs. Vite).

---

## 3. Service Layer Changes

### 3.1 Draft Enablement

Enable OData draft on entities with complex editing flows:

```cds
annotate AdminService.Missions with @odata.draft.enabled;
annotate AdminService.Groups with @odata.draft.enabled;
annotate AdminService.Events with @odata.draft.enabled;
annotate AdminService.Accomplishments with @odata.draft.enabled;
```

**Not draft-enabled:** Prizes (single field), Tutorials (read-only), Tags (read-only), TaskRecords, Users.

### 3.2 Compositions for Nested Editing

Missions already define `completionPaths: Composition of many CompletionPaths` in the schema (`db/schema.cds` line 36). CompletionPaths in turn compose `items: Composition of many CompletionPathItems` (line 149). These compositions are already ready for Fiori Elements sub-table rendering.

**Groups are different.** Groups have an association to Missions (`missions: Association to many Missions on missions.group = $self`) but no direct composition of CompletionPaths. In the existing IMS admin, the "Group form" shows tutorials ordered within the group — this was achieved by iterating the group's missions and their paths.

For the Fiori Elements admin, Groups will:

- Show associated **Missions** as a composition table in the Object Page (add/remove missions from the group)
- The mission ordering within a group uses a new `missionOrder` field (to be added to the Missions entity or via a link table)
- Individual mission path details are viewed by navigating to the Mission Object Page (cross-app navigation via semantic object)

Schema change required:

```cds
// Add to Missions entity for ordering within a group
entity Missions : TaskBase {
  ...
  groupOrder : Integer default 0;  // Order of this mission within its parent group
}
```

**Migration note:** Existing rows get `groupOrder = 0`. A one-time script sets initial ordering based on current mission legacyId sort order within each group.

The AdminService projection already includes both Missions and CompletionPaths. No `extend` needed — the existing compositions surface automatically in Fiori Elements.

### 3.3 Value Help Entities

Tags, Events, and Tutorials are already projected in the service. We annotate them with `@Common.ValueList` so they appear as selection dialogs in Mission/Group forms.

### 3.4 Existing Actions & Functions Preserved

All existing unbound actions and functions remain unchanged. Actions mutate state; functions are read-only (relevant for HTTP method mapping and UI button vs. link treatment):

| Name | Type | Used By |
| --- | --- | --- |
| `anonymizeUser(sapId)` | action | Privacy page |
| `anonymizeByDsrRequest(sapId, dsrRequestNumber)` | action | Privacy page |
| `findByAccountNumber(sapId)` | function | Privacy page |
| `getEventStatistics(eventLegacyId)` | function | Board page |
| `getEventBurnup(eventLegacyId)` | function | Board page |
| `exportTaskRecords(eventLegacyId, format)` | function → LargeString | Statistics page |
| `exportAwardMissions(eventLegacyId)` | function → LargeString | Statistics page |
| `syncTutorialMetadata()` | action | Tutorial Dashboard |
| `sendContributorNotifications()` | action | Tutorial Dashboard |
| `cleanupStepFailures(olderThanDays)` | action | Maintenance action |
| `cleanupUnusedTags()` | action | Maintenance action |
| `setFeaturedOrder(taskLegacyId, taskType, featuredOrder)` | action | Featured Tasks page |
| `updateNotificationRecipients(emails)` | action | Settings/Notifications |
| `toggleNotifications(enabled)` | action | Settings/Notifications |
| `getNotificationConfig()` | function | Settings/Notifications |

### 3.6 Additional Operational Entities

The AdminService exposes several operational/maintenance entities that are not full CRUD pages but need admin visibility. These are surfaced as **additional Fiori Elements List Reports** (read-only or limited CRUD) within an "Operations" tile group:

| Entity | UI Treatment | Actions |
| ------ | ------------ | ------- |
| `FeaturedTasks` | List Report + inline editing of `featuredOrder` | `setFeaturedOrder` action, delete |
| `ImsConfig` | List Report + Object Page (key/value CRUD) | Standard CRUD |
| `StepFailures` | List Report (read-only, filterable by date) | `cleanupStepFailures` toolbar action |
| `NGDSFailedMessages` | List Report (read-only) | `sendToNgds` retry action per row |
| `FailedEmails` | List Report (read-only) | Delete (manual retry not supported) |
| `PrimaryAccounts` / `SecondaryAccounts` | Read-only List Reports | `getAccountMergeStatus(uuid)` unbound function via toolbar button |
| `DashboardMonitoredRecords` | Read-only (used by Board page internally) | — |

**Notification settings** (`toggleNotifications`, `updateNotificationRecipients`, `getNotificationConfig`) are surfaced as a **Settings section** within the Tutorial Dashboard freestyle page, since they relate directly to contributor notification workflows managed there.

### 3.5 Legacy ID Handling

The existing `before('CREATE')` handler assigns `legacyId` via HANA sequences. With drafts, this fires on **draft activation** (not draft creation), which is correct — drafts don't need a legacyId until they become real entities.

---

## 4. UI Annotations

All annotations live in `app/admin-annotations.cds`, imported by the service. This keeps service logic and UI concerns separate.

### 4.1 Events (Pattern Example)

```cds
annotate AdminService.Events with @UI: {
  HeaderInfo: {
    TypeName: 'Event', TypeNamePlural: 'Events',
    Title: { Value: name },
    Description: { Value: timeZone }
  },
  SelectionFields: [ name, startDate, endDate ],
  LineItem: [
    { Value: legacyId, Label: 'Event ID' },
    { Value: name, Label: 'Name' },
    { Value: startDate, Label: 'Start Date' },
    { Value: endDate, Label: 'End Date' }
  ],
  Facets: [{
    $Type: 'UI.ReferenceFacet',
    Target: '@UI.FieldGroup#General',
    Label: 'General Information'
  }],
  FieldGroup#General: { Data: [
    { Value: name },
    { Value: startDate },
    { Value: endDate },
    { Value: timeZone }
  ]}
};
```

### 4.2 Missions (Most Complex)

**List Report columns:** legacyId, title, experience, event.name

**Object Page facets:**

1. **General** — title, description, communityMissionId, experienceTag (free-text input), primaryTag (value help → Tags), status
2. **Completion Paths** — composition table. Each path row expands to show CompletionPathItems in a **custom section** with drag-and-drop reordering.

**Schema changes for richer value helps:**

```cds
// Upgrade primaryTag from String to Association for proper value help support
// Both Missions and Groups inherit from TaskBase; extend TaskBase instead:
extend TaskBase with {
  primaryTagRef : Association to Tags;  // replaces string-based primaryTag for UI binding
}
```

**Note:** The existing `primaryTag : String(255)` field is retained for backward compatibility with data migration scripts. The new `primaryTagRef` association provides proper value help behavior. A migration script populates `primaryTagRef` by matching `primaryTag` strings to `Tags.name`.

**Value helps:**

```cds
annotate AdminService.Missions with {
  primaryTagRef @Common.ValueList: {
    CollectionPath: 'Tags',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',
        LocalDataProperty: primaryTagRef_ID,
        ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly',
        ValueListProperty: 'name' }
    ]
  };
};
```

### 4.3 Groups

**List Report columns:** legacyId, title, timeToComplete, experience

**Object Page facets:**

1. **General** — title, description, experienceTag, averageTimeToComplete, primaryTagRef (value help → Tags)
2. **Missions** — composition table showing missions belonging to this group. Columns: title, experienceTag, groupOrder. Drag-and-drop extension for reordering `groupOrder`. Add button opens a value help to select existing Missions.

Navigation: clicking a mission row navigates to the Mission Object Page (intent-based navigation via semantic object `Mission-manage`).

### 4.4 Accomplishments

**List Report:** name, description, rule (truncated)  
**Object Page:** Single facet — name, description, rule (annotated with `@UI.MultiLineText`)

### 4.5 Prizes

**List Report:** legacyId, name  
**Object Page:** Single field — name. No draft.

### 4.6 Tutorials (Read-Only)

List Report only. Columns: title, primaryTag, experience, timeToComplete. Filter bar on title, primaryTag. No Object Page — external link to tutorial page.

### 4.7 Tags (Read-Only)

List Report only. Columns: legacyId, name. Searchable, sortable.

### 4.8 Summary

| Entity | List Report | Object Page | Draft | Compositions | Value Helps |
|--------|:-----------:|:-----------:|:-----:|:------------:|:-----------:|
| Events | ✓ | ✓ | ✓ | — | — |
| Missions | ✓ | ✓ | ✓ | CompletionPaths → Items | Tags, Events |
| Groups | ✓ | ✓ | ✓ | Missions (association) | Tags |
| Accomplishments | ✓ | ✓ | ✓ | — | — |
| Prizes | ✓ | ✓ | — | — | — |
| Tutorials | ✓ | — | — | — | — |
| Tags | ✓ | — | — | — | — |

---

## 5. Freestyle SAPUI5 App (Non-CRUD Pages)

A single freestyle app at `app/admin-custom/` with 4 views, sharing the FLP shell and consuming the same `/admin` OData endpoint.

### 5.1 Board / Analytics Dashboard

**Purpose:** At-a-glance tutorial health metrics.

**UI:**
- Donut/pie chart: up-to-date vs. needs-review tutorials (`sap.viz.ui5.controls.VizFrame` or `sap.suite.ui.microchart`)
- KPI cards: total tutorials, % up-to-date, % needing review
- Board items list (`sap.m.List`)

**Data source:** New unbound function `getTutorialHealthMetrics()` or client-side aggregation of `TutorialMeta`.

### 5.2 Tutorial Dashboard

**Purpose:** Operational tracking for content owners.

**UI:**
- `sap.ui.table.Table` (grid table for many columns)
- Columns: Tutorial (link), Owner, First Author, Primary Tag, Last Updated, Last Reviewed, Repository Owner, Repository, Monitored (checkbox), Reviewed (checkbox), Last Reminder Email
- Filter bar: text search, tags (multi-combo), repository (combo), "Monitored by me" toggle, "Outdated only" toggle
- Toolbar: "Mark all monitored" button, "Sync metadata" button

**Inline actions:**
- Monitored checkbox → toggling status without entering edit mode (bound action on TutorialMeta)
- Reviewed checkbox → similar toggle action

**Data source:** `AdminService.TutorialMeta` with server-side filtering/sorting/paging.

### 5.3 Statistics Export

**Purpose:** Date-range CSV download of mission completion data.

**UI:**
- `sap.m.Page` with `sap.ui.layout.form.SimpleForm`
- Fields: Start Date (DatePicker), End Date (DatePicker), Mission ID (optional, numeric Input)
- Validation: end > start, mission ID numeric only
- Download button → calls `exportTaskRecords` or `exportAwardMissions` → browser file download

### 5.4 Privacy / GDPR Tools

**Purpose:** User lookup, history view, CSV export, anonymization.

**UI:**
- `sap.m.Wizard` or sequential form (deliberate multi-step friction for compliance):
  1. Enter PET Number + DSR Request Number → submit
  2. Enter User ID (C-Number) → submit → fetch user history
  3. Results table: date, type, title, time spent (paginated `sap.m.Table`)
  4. Actions: "Download CSV" + "Anonymize" (with `sap.m.MessageBox` confirmation)

**Data source:**
- `findByAccountNumber(sapId)` for search
- `exportTaskRecords` for CSV
- `anonymizeByDsrRequest(sapId, dsrRequestNumber)` for anonymization

---

## 6. Drag-and-Drop Extension

### Purpose

Reorder CompletionPathItems within a path (Missions and Groups Object Pages).

### Implementation

A Fiori Elements **custom section** that replaces the default items table:

```
app/admin/missions/webapp/ext/
├── ItemReorder.controller.js    ← DnD logic, itemOrder recalculation
├── ItemReorder.fragment.xml     ← sap.m.Table with DragDropInfo
└── i18n/i18n.properties
```

**Behavior:**
- `sap.m.Table` with `sap.ui.core.dnd.DragDropInfo` for row reordering
- On drop: recalculates `itemOrder` for affected rows (gap numbering: 10, 20, 30...)
- Updates draft rows via OData V4 model PATCH calls
- Same extension reused in Groups app

### Value Help for Adding Items

When adding a new CompletionPathItem, a value help dialog shows available Tutorials (for Groups) or Tasks (for Missions), filtered to exclude already-added items.

---

## 7. FLP Configuration

### Tile Groups

| Group | Tiles |
|-------|-------|
| **Content Management** | Tutorials, Groups, Missions, Tags |
| **Events & Gamification** | Events, Prizes, Accomplishments |
| **Operations** | Tutorial Dashboard, Board, Statistics |
| **Compliance** | Privacy Protection |

### Semantic Objects

| Tile | Semantic Object | Action | App ID |
|------|-----------------|--------|--------|
| Tutorials | Tutorial | display | sap.tutorials.admin.tutorials |
| Groups | Group | manage | sap.tutorials.admin.groups |
| Missions | Mission | manage | sap.tutorials.admin.missions |
| Tags | Tag | display | sap.tutorials.admin.tags |
| Events | Event | manage | sap.tutorials.admin.events |
| Prizes | Prize | manage | sap.tutorials.admin.prizes |
| Accomplishments | Accomplishment | manage | sap.tutorials.admin.accomplishments |
| Board | Admin | board | sap.tutorials.admin.custom |
| Tutorial Dashboard | Admin | dashboard | sap.tutorials.admin.custom |
| Statistics | Admin | statistics | sap.tutorials.admin.custom |
| Privacy | Admin | privacy | sap.tutorials.admin.custom |

---

## 8. Deployment

### Served by Existing AppRouter

The admin UI is served by the same AppRouter that handles the tutorial site and Vue apps. A new route in `approuter/xs-app.json`:

```json
{
  "source": "^/admin-ui/(.*)$",
  "target": "/admin-ui/$1",
  "service": "html5-apps-repo-rt",
  "authenticationType": "xsuaa"
}
```

### MTA Modules

The existing `mta.yaml` needs a new `html5-apps-repo-host` resource and a binding on the AppRouter. Full delta:

```yaml
resources:
  - name: tutorials-poc-html5-repo-host
    type: org.cloudfoundry.managed-service
    parameters:
      service: html5-apps-repo
      service-plan: app-host

  - name: tutorials-poc-html5-repo-rt
    type: org.cloudfoundry.managed-service
    parameters:
      service: html5-apps-repo
      service-plan: app-runtime

modules:
  # Add html5-repo-rt binding to existing AppRouter module
  - name: tutorials-poc-approuter
    requires:
      - name: tutorials-poc-html5-repo-rt  # NEW binding

  # New: Fiori Elements admin apps + FLP sandbox
  - name: tutorials-poc-admin-ui
    type: html5
    path: app/admin
    build-parameters:
      builder: custom
      commands:
        - npm run build
    requires:
      - name: tutorials-poc-html5-repo-host
        parameters:
          content-target: true

  # New: Freestyle admin app
  - name: tutorials-poc-admin-custom
    type: html5
    path: app/admin-custom
    build-parameters:
      builder: custom
      commands:
        - npm run build
    requires:
      - name: tutorials-poc-html5-repo-host
        parameters:
          content-target: true
```

### Authorization

- No new XSUAA scopes or roles — existing `Admin` role is sufficient
- FLP tiles only render if the user's JWT contains the `Admin` scope
- CAP service already enforces `@requires: 'Admin'`

---

## 9. File Structure

```
app/
├── admin-annotations.cds              ← All @UI/@Common annotations
├── admin/
│   ├── missions/
│   │   ├── webapp/
│   │   │   ├── manifest.json
│   │   │   ├── Component.js
│   │   │   └── ext/
│   │   │       ├── ItemReorder.controller.js
│   │   │       └── ItemReorder.fragment.xml
│   │   ├── ui5.yaml
│   │   └── package.json
│   ├── groups/
│   │   ├── webapp/
│   │   │   ├── manifest.json
│   │   │   ├── Component.js
│   │   │   └── ext/
│   │   │       ├── ItemReorder.controller.js
│   │   │       └── ItemReorder.fragment.xml
│   │   ├── ui5.yaml
│   │   └── package.json
│   ├── events/
│   │   └── webapp/ (manifest.json, Component.js)
│   ├── accomplishments/
│   │   └── webapp/ (manifest.json, Component.js)
│   ├── prizes/
│   │   └── webapp/ (manifest.json, Component.js)
│   ├── tutorials/
│   │   └── webapp/ (manifest.json, Component.js)
│   └── tags/
│       └── webapp/ (manifest.json, Component.js)
├── admin-custom/
│   ├── webapp/
│   │   ├── manifest.json
│   │   ├── Component.js
│   │   ├── controller/
│   │   │   ├── Board.controller.js
│   │   │   ├── TutorialDashboard.controller.js
│   │   │   ├── Statistics.controller.js
│   │   │   └── Privacy.controller.js
│   │   ├── view/
│   │   │   ├── Board.view.xml
│   │   │   ├── TutorialDashboard.view.xml
│   │   │   ├── Statistics.view.xml
│   │   │   └── Privacy.view.xml
│   │   └── i18n/
│   │       └── i18n.properties
│   ├── ui5.yaml
│   └── package.json
└── admin-flp/
    └── webapp/
        └── test/
            └── flpSandbox.html
```

**Note:** The FLP sandbox (`admin-flp/`) is bundled and deployed as part of the `tutorials-poc-admin-ui` MTA module (same `app/admin/` path). It does not need its own MTA module entry.

---

## 10. Testing Strategy

### Unit Tests (existing infrastructure, extended)

- Draft lifecycle: create → edit → activate
- Composition CRUD: add/remove CompletionPathItems
- `itemOrder` maintained after reorder
- Value help queries return filtered results

### OPA5 Integration Tests (new)

Per Fiori Elements app:
- List Report loads with correct columns
- Object Page opens with correct facets
- Value helps resolve
- Draft create → edit → save → verify in list
- Draft discard
- Delete with confirmation

Run against `cds watch` with mock auth.

### Smoke Tests (extend existing suite)

- `/admin/$metadata` returns expected entity sets with draft annotations
- Admin UI HTML loads without 4xx/5xx
- Draft creation returns 201

### Manual Validation

- Drag-and-drop reordering persists correct order
- Privacy anonymization flow completes end-to-end
- Statistics CSV downloads with correct content

---

## 11. Migration & Parallel Operation

The new Fiori admin and the existing React admin can run simultaneously:

1. Both hit the same CAP `AdminService` backend
2. New admin deployed at `/admin-ui/` route
3. Old React admin remains at its current route
4. No data migration needed — shared backend
5. Once validated, retire the React admin (remove its route from AppRouter)

---

## 12. Functional Parity Checklist

| # | IMS Page | New Implementation | Draft | Status |
|---|----------|-------------------|:-----:|--------|
| 1 | Tutorials (read-only) | FE List Report | — | Planned |
| 2 | Groups (CRUD + paths) | FE List Report + Object Page + DnD ext | ✓ | Planned |
| 3 | Missions (CRUD + paths) | FE List Report + Object Page + DnD ext | ✓ | Planned |
| 4 | Tags (read-only) | FE List Report | — | Planned |
| 5 | Accomplishments (CRUD) | FE List Report + Object Page | ✓ | Planned |
| 6 | Events (CRUD) | FE List Report + Object Page | ✓ | Planned |
| 7 | Prizes (CRUD) | FE List Report + Object Page | — | Planned |
| 8 | Board (analytics) | Freestyle: chart + KPIs | — | Planned |
| 9 | Tutorial Dashboard | Freestyle: grid table + toggles | — | Planned |
| 10 | Statistics (export) | Freestyle: form + download | — | Planned |
| 11 | Privacy (GDPR) | Freestyle: wizard + actions | — | Planned |
