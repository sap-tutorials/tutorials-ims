# Devtoberfest Cross-Container Value Help — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish bi-directional HDI-to-HDI cross-container access between `tutorials-hana` and `devtoberfest-planner-db`, and deliver a tutorial value help on the planner's `Session` entity so an author can assign a Tutorial GUID for completion tracking.

**Architecture:** Each container publishes a versioned view (`<DOMAIN>_<PURPOSE>_V<n>`) as its API surface plus a least-privilege `.hdbrole`; the consumer binds the other container, requests the role via `.hdbgrants` (`container_roles`), declares a `.hdbsynonym`, and wraps it in a `@cds.persistence.exists` CDS facade. First-time bring-up is base-then-enable (publish views+roles, then add grants+synonyms). Names in the synonym+facade must match the deployed HANA object names exactly (case-sensitive) — aliased in the view where needed.

**Tech Stack:** CAP Node.js (`@sap/cds` 9), SAP HANA Cloud HDI, MTA (`mbt`/`cf deploy`), `hana-cli`, Fiori Elements value help (`@Common.ValueList`).

**Repos:** This plan spans two repos. **Repo A = `sap-tutorials/tutorials-ims`** (this repo). **Repo B = `github.tools.sap/developer-relations/devtoberfest-planner`** (`D:\projects\devtoberfest-planner`, separate PR). Tasks are tagged `[Repo A]` / `[Repo B]`.

## Global Constraints

- **Only `tutorials-hana` participates** — `tutorials-hana-qa` and its deployer are out of scope; do not add cross-container artifacts to `db-qa/`.
- **Published-tutorial predicate** is exactly `status = 'ACTIVE' OR status IS NULL` (no `published` boolean exists on Tutorials).
- **Versioned view naming:** `<DOMAIN>_<PURPOSE>_V<n>`; this change ships `TUTORIAL_VALUE_HELP_V1` and `ACTIVITY_SESSION_V1`.
- **Grants request a provider role via `container_roles`** — never enumerate object privileges in a consumer's `.hdbgrants`.
- **No `.hdbsynonymconfig`** — not needed for HDI-to-HDI.
- **Exact name/case matching** (workbook D4a): synonym target + facade entity/element names must match the DEPLOYED HANA names character-for-character, case-sensitive. Introspect the deployed container with `hana-cli` and copy names verbatim; alias in the view to force a match. A mismatch fails the proxy SILENTLY.
- **Repo A dual mta:** any `mta.yaml` change must be mirrored into `.deploy/mta.yaml`.
- **Keep grantor channels in separate `.hdbgrants` files** — do not add keys to the existing `db/src/_grants.hdbgrants` (SPARQL/`tutorials-kg-grantor`); create new per-provider files.
- **Facades are `@readonly`** — proxies over another container's data, never written.
- **Reference:** [`docs/developers/architecture/cross-container-integration.md`](../../developers/architecture/cross-container-integration.md) (workbook) and [`docs/superpowers/specs/2026-07-27-devtoberfest-cross-container-design.md`](../specs/2026-07-27-devtoberfest-cross-container-design.md) (spec).

---

## File structure

**Repo A (`tutorials-ims`):**
- `db/src/TUTORIAL_VALUE_HELP_V1.hdbview` — provider view (Leg A). *Create.*
- `db/src/tutorial_value_help_reader.hdbrole` — provider reader role (Leg A). *Create.*
- `db/src/ACTIVITY_SESSION_V1.hdbsynonym` — consumer synonym → planner view (Leg B). *Create.*
- `db/src/planner-grants.hdbgrants` — consumer grant requesting planner role (Leg B). *Create.*
- `db/external/devtoberfest-planner.cds` — `@cds.persistence.exists` facade (Leg B, unused). *Create.*
- `mta.yaml` + `.deploy/mta.yaml` — add `devtoberfest-planner-db` existing-service + deployer `requires` (Leg B). *Modify.*
- `test/unit/tutorial-value-help-view.test.js` — view filter semantics. *Create.*

**Repo B (`devtoberfest-planner`):**
- `db/src/ACTIVITY_SESSION_V1.hdbview` + `db/src/activity_session_reader.hdbrole` — provider (Leg B). *Create.*
- `db/src/TUTORIAL_VALUE_HELP_V1.hdbsynonym` + `db/src/tutorials-grants.hdbgrants` — consumer (Leg A). *Create.*
- `db/external/tutorials.cds` — `@cds.persistence.exists` facade (Leg A). *Create.*
- `db/schema.cds` — add `tutorial` assoc + `tutorialSlug`/`tutorialTitle` to `Session`. *Modify.*
- `srv/sessions-service.cds` — `@readonly Tutorials` projection over the facade. *Modify.*
- `app/devtoberfest/sessions-annotations.cds` — `@Common.ValueList` on `Session.tutorial_ID`. *Modify.*
- `mta.yaml` — pin `service-name`, add `tutorials-hana` existing-service + deployer `requires`. *Modify.*
- Snapshot copy: an `srv` handler or FE-side onChange (decided in Task B7).

---

## Prerequisite (do first, blocks column-exact tasks)

### Task 0: Introduce deployed planner names + confirm value-help columns `[Repo B]`

**Files:** none (investigation + decision record appended to the spec's "Open items").

**Interfaces:**
- Produces: the exact deployed physical names for the planner `Session`/`Track` objects and the confirmed `ACTIVITY_SESSION_V1` column list — consumed by Tasks A1-view? no — by Tasks B1 (planner view) and B4 (tutorials facade over planner) and A5 (tutorials facade).

- [ ] **Step 1: Bind `hana-cli` to the deployed planner container in DEV**

```bash
# from D:\projects\devtoberfest-planner, logged into the DEV CF space
cds bind -2 devtoberfest-planner-db            # or create a service key and bind
cds bind --exec -- hana-cli status             # confirm connection to the planner container
```

- [ ] **Step 2: Read the true physical table + column names (case-sensitive)**

```bash
cds bind --exec -- hana-cli inspectTable --table <Session physical name> --output json
# also inspect the Track table for isActivityTrack
```
Record the exact object names and column names/case. Expect CDS `devtoberfest.Session` → a mangled physical name; camelCase fields may deploy quoted/mixed-case.

- [ ] **Step 3: Confirm the exposed column set with the planner owner**

Proposed (no PII): `ID, sessionCode, title, trackTitle, isActivityTrack, tutorial_ID, scheduledDate`. Get owner sign-off; adjust.

- [ ] **Step 4: Record findings**

Append the confirmed names + columns to the spec's "Open items for implementation" section (mark resolved). Commit that doc update to the Repo A branch.

```bash
git add docs/superpowers/specs/2026-07-27-devtoberfest-cross-container-design.md
git commit -m "docs(cross-container): record deployed planner names + confirmed ACTIVITY_SESSION_V1 columns"
```

---

## Phase 1 artifacts — BASE (publish views + roles; no cross-deps)

### Task A1: `TUTORIAL_VALUE_HELP_V1` provider view + reader role `[Repo A]`

**Files:**
- Create: `db/src/TUTORIAL_VALUE_HELP_V1.hdbview`
- Create: `db/src/tutorial_value_help_reader.hdbrole`
- Test: `test/unit/tutorial-value-help-view.test.js`

**Interfaces:**
- Produces: physical view `TUTORIAL_VALUE_HELP_V1` exposing columns `ID, slug, title, primaryTag` (aliased, quoted) filtered to active/null status; role `tutorial_value_help_reader` granting `SELECT` on it. Consumed by Repo B Task B3 (synonym) + B4 (facade) + B2 (grant).

- [ ] **Step 1: Confirm base column case** — `hana-cli inspectTable --table com_sap_developers_ims_Tutorials --output json` against the deployed `tutorials-hana`; note exact case of `ID, slug, title, primaryTag, status`.

- [ ] **Step 2: Write the failing test** (view filter semantics, SQLite-equivalent)

```javascript
// test/unit/tutorial-value-help-view.test.js
const cds = require('@sap/cds')
const { expect } = require('chai')

describe('TUTORIAL_VALUE_HELP_V1 filter semantics', () => {
  let db
  before(async () => { db = await cds.connect.to('db') })

  it('includes ACTIVE and NULL-status tutorials, excludes INACTIVE', async () => {
    // Model the view predicate against ims.Tutorials seeded in the test DB.
    const { Tutorials } = cds.entities('com.sap.developers.ims')
    const rows = await SELECT.from(Tutorials)
      .columns('ID','slug','title','primaryTag')
      .where(`status = 'ACTIVE' or status is null`)
    const statuses = new Set(rows.map(r => r.status))
    expect([...rows]).to.be.an('array')
    // seed assertion: an INACTIVE row must not appear
    const inactive = await SELECT.from(Tutorials).where({ status: 'INACTIVE' })
    for (const r of inactive) expect(rows.find(x => x.ID === r.ID)).to.be.undefined
  })
})
```

- [ ] **Step 3: Run it, expect FAIL** — `npx vitest run test/unit/tutorial-value-help-view.test.js` → fails until a seed row of each status exists / assertion wired.

- [ ] **Step 4: Author the view** (aliased quoted identifiers per D4a; confirm case from Step 1)

```sql
-- db/src/TUTORIAL_VALUE_HELP_V1.hdbview
VIEW "TUTORIAL_VALUE_HELP_V1" AS
  SELECT "ID"         AS "ID",
         "SLUG"       AS "slug",
         "TITLE"      AS "title",
         "PRIMARYTAG" AS "primaryTag"
  FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
  WHERE "STATUS" = 'ACTIVE' OR "STATUS" IS NULL
```

- [ ] **Step 5: Author the reader role**

```json
// db/src/tutorial_value_help_reader.hdbrole
{
  "role": {
    "name": "tutorial_value_help_reader",
    "object_privileges": [
      { "name": "TUTORIAL_VALUE_HELP_V1", "type": "VIEW", "privileges": [ "SELECT" ] }
    ]
  }
}
```

- [ ] **Step 6: Compile-check the db model** — `npx cds build --production` (or `cds deploy --to sqlite::memory:` for the CDS side); confirm the `.hdbview`/`.hdbrole` are copied into `gen/db/src/` and no HDI plugin error.

- [ ] **Step 7: Run the unit test, expect PASS** — `npx vitest run test/unit/tutorial-value-help-view.test.js`.

- [ ] **Step 8: Commit**

```bash
git add db/src/TUTORIAL_VALUE_HELP_V1.hdbview db/src/tutorial_value_help_reader.hdbrole test/unit/tutorial-value-help-view.test.js
git commit -m "feat(cross-container): publish TUTORIAL_VALUE_HELP_V1 view + reader role (Leg A provider)"
```

### Task B1: `ACTIVITY_SESSION_V1` provider view + reader role `[Repo B]`

**Files (Repo B):**
- Create: `db/src/ACTIVITY_SESSION_V1.hdbview`
- Create: `db/src/activity_session_reader.hdbrole`

**Interfaces:**
- Consumes: deployed planner names + confirmed columns from Task 0.
- Produces: physical view `ACTIVITY_SESSION_V1` + role `activity_session_reader`. Consumed by Repo A Tasks A3 (synonym), A4 (grant), A5 (facade).

- [ ] **Step 1: Author the view** using the exact deployed physical table/column names from Task 0, aliasing every output column with quoted identifiers to a stable proxy contract:

```sql
-- db/src/ACTIVITY_SESSION_V1.hdbview  (column sources = Task 0 physical names)
VIEW "ACTIVITY_SESSION_V1" AS
  SELECT s."<ID phys>"            AS "ID",
         s."<sessionCode phys>"   AS "sessionCode",
         s."<title phys>"         AS "title",
         t."<title phys>"         AS "trackTitle",
         t."<isActivityTrack phys>" AS "isActivityTrack",
         s."<tutorial_ID phys>"   AS "tutorial_ID",
         s."<scheduledDate phys>" AS "scheduledDate"
  FROM "<Session phys>" AS s
  LEFT JOIN "<Track phys>" AS t ON s."<track_ID phys>" = t."<ID phys>"
```

- [ ] **Step 2: Author the reader role**

```json
// db/src/activity_session_reader.hdbrole
{
  "role": {
    "name": "activity_session_reader",
    "object_privileges": [
      { "name": "ACTIVITY_SESSION_V1", "type": "VIEW", "privileges": [ "SELECT" ] }
    ]
  }
}
```

- [ ] **Step 3: Compile-check** — `npx cds build --production` in Repo B; confirm artifacts land in `gen/db/src/`.

- [ ] **Step 4: Commit (Repo B branch)**

```bash
git add db/src/ACTIVITY_SESSION_V1.hdbview db/src/activity_session_reader.hdbrole
git commit -m "feat(cross-container): publish ACTIVITY_SESSION_V1 view + reader role (Leg B provider)"
```

### Task B0: Pin `service-name` on the planner HDI container `[Repo B]`

**Files (Repo B):** Modify `mta.yaml` (hdi-container resource).

- [ ] **Step 1: Add the pin**

```yaml
  - name: devtoberfest-planner-db
    type: com.sap.xs.hdi-container
    parameters:
      service: hana
      service-plan: hdi-shared
      service-name: devtoberfest-planner-db      # <-- add: stable name for cross-container reference
```

- [ ] **Step 2: Verify it matches the existing deployed instance name** (so the pin reuses, not reprovisions) — `cf services | grep devtoberfest-planner-db`. If the deployed name differs, use the actual deployed name here.

- [ ] **Step 3: Commit (Repo B branch)**

```bash
git add mta.yaml
git commit -m "chore(mta): pin devtoberfest-planner-db service-name for cross-container referencing"
```

> **Deploy gate — Phase 1:** Deploy Repo A db (publishes `TUTORIAL_VALUE_HELP_V1` + role) and Repo B db (publishes `ACTIVITY_SESSION_V1` + role) independently. No synonyms exist yet, so both deploy cleanly. Verify each view exists via `hana-cli views`.

---

## Phase 2 artifacts — ENABLE (grants + synonyms + facades)

### Task A2: mta wiring — bind planner container to Repo A db deployer `[Repo A]`

**Files:** Modify `mta.yaml` AND `.deploy/mta.yaml` (mirror).

**Interfaces:** Produces a bound `devtoberfest-planner-db` service available to `tutorials-db-deployer` (needed for Task A4's grant key + Task A3's synonym resolution).

- [ ] **Step 1: Add the existing-service resource** (both files)

```yaml
  - name: devtoberfest-planner-db
    type: org.cloudfoundry.existing-service
    parameters:
      service-name: devtoberfest-planner-db
```

- [ ] **Step 2: Add `requires` to `tutorials-db-deployer`** (both files) — leave `tutorials-db-qa-deployer` untouched.

```yaml
  - name: tutorials-db-deployer
    type: hdb
    path: gen/db
    parameters:
      buildpack: nodejs_buildpack
    requires:
      - name: tutorials-hana
      - name: tutorials-cloud-logging
      - name: tutorials-kg-grantor
      - name: devtoberfest-planner-db      # <-- add (Leg B consumer bind)
```

- [ ] **Step 3: Diff-verify both mta files match** — `difft mta.yaml .deploy/mta.yaml` (only the path prefixes `gen/db` vs `../gen/db` should differ in the relevant blocks).

- [ ] **Step 4: Commit**

```bash
git add mta.yaml .deploy/mta.yaml
git commit -m "chore(mta): bind devtoberfest-planner-db to tutorials-db-deployer (Leg B consumer)"
```

### Task A3+A4+A5: Leg B consumer artifacts — synonym + grant + facade `[Repo A]`

**Files:**
- Create: `db/src/planner-grants.hdbgrants`
- Create: `db/src/ACTIVITY_SESSION_V1.hdbsynonym`
- Create: `db/external/devtoberfest-planner.cds`

**Interfaces:**
- Consumes: `ACTIVITY_SESSION_V1` + `activity_session_reader` (Repo B Task B1); bound `devtoberfest-planner-db` (Task A2).
- Produces: facade `external.devtoberfest.ActivitySessionV1` — **not projected in any service** (reserved).

- [ ] **Step 1: Author the grant** (requests the planner's role; separate file from `_grants.hdbgrants`)

```jsonc
// db/src/planner-grants.hdbgrants
{
  "devtoberfest-planner-db": {
    "object_owner":     { "container_roles": [ "activity_session_reader" ] },
    "application_user": { "container_roles": [ "activity_session_reader" ] }
  }
}
```

- [ ] **Step 2: Author the synonym**

```jsonc
// db/src/ACTIVITY_SESSION_V1.hdbsynonym
{
  "ACTIVITY_SESSION_V1": {
    "target": { "object": "ACTIVITY_SESSION_V1" }
  }
}
```

- [ ] **Step 3: Generate the facade from the DEPLOYED view** (after Phase-1 deploy of Repo B; D4a — do not hand-type)

```bash
# bound to tutorials-hana; introspect the synonym/view and emit CDS
cds bind --exec -- hana-cli inspectView --view ACTIVITY_SESSION_V1 --output cds
```
Land the output as `db/external/devtoberfest-planner.cds`, annotated:

```cds
namespace external.devtoberfest;

@cds.persistence.exists
entity ActivitySessionV1 {
  key ID          : String(36);
      sessionCode : String(...);   // types/case COPIED from hana-cli output, not guessed
      title       : String(...);
      trackTitle  : String(...);
      isActivityTrack : Boolean;
      tutorial_ID : String(36);
      scheduledDate   : Date;
}
```

- [ ] **Step 4: Verify csn build** — `npx cds build --production`; confirm the facade compiles and emits NO CREATE (it's `@cds.persistence.exists`), and the grants/synonym files copy into `gen/db/src/`.

- [ ] **Step 5: Add the `srv-qa` cp-list audit check** — this touches `db/`, not `srv/lib/`, so no cp-list impact; note "N/A" and move on.

- [ ] **Step 6: Commit**

```bash
git add db/src/planner-grants.hdbgrants db/src/ACTIVITY_SESSION_V1.hdbsynonym db/external/devtoberfest-planner.cds
git commit -m "feat(cross-container): Leg B consumer — synonym + grant + facade over planner ACTIVITY_SESSION_V1 (reserved)"
```

### Task B2+B3+B4: Leg A consumer artifacts — synonym + grant + facade `[Repo B]`

**Files (Repo B):**
- Create: `db/src/tutorials-grants.hdbgrants`
- Create: `db/src/TUTORIAL_VALUE_HELP_V1.hdbsynonym`
- Create: `db/external/tutorials.cds`
- Modify: `mta.yaml` (add `tutorials-hana` existing-service + deployer `requires`)

**Interfaces:**
- Consumes: `TUTORIAL_VALUE_HELP_V1` + `tutorial_value_help_reader` (Repo A Task A1).
- Produces: facade `external.tutorials.TutorialValueHelpV1` — consumed by Task B5 (service projection).

- [ ] **Step 1: mta — add `tutorials-hana` existing-service + `requires` on `devtoberfest-planner-db-deployer`**

```yaml
  - name: tutorials-hana
    type: org.cloudfoundry.existing-service
    parameters:
      service-name: tutorials-hana
# ...
  - name: devtoberfest-planner-db-deployer
    type: hdb
    path: gen/db
    parameters:
      buildpack: nodejs_buildpack
    requires:
      - name: devtoberfest-planner-db
      - name: tutorials-hana            # <-- add (Leg A consumer bind)
```

- [ ] **Step 2: Author grant + synonym**

```jsonc
// db/src/tutorials-grants.hdbgrants
{ "tutorials-hana": {
    "object_owner":     { "container_roles": [ "tutorial_value_help_reader" ] },
    "application_user": { "container_roles": [ "tutorial_value_help_reader" ] } } }
```
```jsonc
// db/src/TUTORIAL_VALUE_HELP_V1.hdbsynonym
{ "TUTORIAL_VALUE_HELP_V1": { "target": { "object": "TUTORIAL_VALUE_HELP_V1" } } }
```

- [ ] **Step 3: Generate the facade from the DEPLOYED tutorials view** (D4a)

```bash
cds bind --exec -- hana-cli inspectView --view TUTORIAL_VALUE_HELP_V1 --output cds
```
```cds
// db/external/tutorials.cds
namespace external.tutorials;

@cds.persistence.exists
entity TutorialValueHelpV1 {
  key ID         : String(36);
      slug       : String(255);
      title      : String(255);
      primaryTag : String(255);
}
```

- [ ] **Step 4: Compile-check** — `npx cds build --production` (Repo B).

- [ ] **Step 5: Commit (Repo B branch)**

```bash
git add mta.yaml db/src/tutorials-grants.hdbgrants db/src/TUTORIAL_VALUE_HELP_V1.hdbsynonym db/external/tutorials.cds
git commit -m "feat(cross-container): Leg A consumer — synonym + grant + facade over tutorials TUTORIAL_VALUE_HELP_V1"
```

### Task B5: Expose read-only `Tutorials` in `SessionsService` `[Repo B]`

**Files (Repo B):** Modify `srv/sessions-service.cds`.

**Interfaces:** Produces OData `GET /sessions/Tutorials` over the facade; consumed by Task B6 value help `CollectionPath`.

- [ ] **Step 1: Add the projection**

```cds
using external.tutorials from '../db/external/tutorials';
// inside service SessionsService { ... }
  @readonly entity Tutorials as projection on tutorials.TutorialValueHelpV1;
```

- [ ] **Step 2: Boot check** — `cds watch --profile hybrid` (bound to both containers) and `GET /sessions/Tutorials?$top=1` returns a row over the synonym.

- [ ] **Step 3: Commit (Repo B branch)**

```bash
git add srv/sessions-service.cds
git commit -m "feat(cross-container): expose read-only Tutorials value-help collection in SessionsService"
```

### Task B6: `Session.tutorial` field + snapshot columns `[Repo B]`

**Files (Repo B):** Modify `db/schema.cds` (`Session` entity).

**Interfaces:** Produces `Session.tutorial_ID` (FK) + `tutorialSlug`/`tutorialTitle`; consumed by Task B7 (value help + snapshot).

- [ ] **Step 1: Add fields**

```cds
using external.tutorials from './external/tutorials';
// inside entity Session { ... }
  tutorial      : Association to tutorials.TutorialValueHelpV1;
  tutorialSlug  : String(255);
  tutorialTitle : String(255);
```

- [ ] **Step 2: Build check** — `cds build --production`; confirm the association compiles against the `@cds.persistence.exists` target (no FK constraint emitted cross-container).

- [ ] **Step 3: Commit (Repo B branch)**

```bash
git add db/schema.cds
git commit -m "feat(cross-container): add tutorial assoc + slug/title snapshot to Session"
```

### Task B7: Value help + snapshot copy `[Repo B]`

**Files (Repo B):** Modify `app/devtoberfest/sessions-annotations.cds`; add snapshot handler in `srv/` (or FE onChange — decide here).

**Interfaces:** Consumes `Tutorials` collection (B5) + `Session.tutorial_ID` (B6).

- [ ] **Step 1: Add `@Common.ValueList`** (mirror the existing `track` value help at `sessions-annotations.cds:256`)

```cds
annotate SessionsService.Sessions with {
  tutorial @Common.ValueList: {
    CollectionPath: 'Tutorials',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: tutorial_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'title' }
    ]
  }
};
```

- [ ] **Step 2: Decide + implement snapshot copy** — recommended: an `after`-save (or `before`-save on draft activate) handler in `srv/sessions-service.js` that, when `tutorial_ID` changed, reads `slug`/`title` from `Tutorials` and writes `tutorialSlug`/`tutorialTitle`. (If the planner prefers FE, wire an onChange in the app extension instead.) Record the decision in the spec.

```javascript
// srv/sessions-service.js  (illustrative)
this.before(['CREATE','UPDATE'], 'Sessions', async (req) => {
  const id = req.data.tutorial_ID
  if (!id) return
  const t = await SELECT.one.from('SessionsService.Tutorials').where({ ID: id }).columns('slug','title')
  if (t) { req.data.tutorialSlug = t.slug; req.data.tutorialTitle = t.title }
})
```

- [ ] **Step 3: Manual verify (hybrid)** — open a Session object page, pick a tutorial via value help, save; confirm `tutorial_ID` + snapshot columns persist.

- [ ] **Step 4: Commit (Repo B branch)**

```bash
git add app/devtoberfest/sessions-annotations.cds srv/sessions-service.js
git commit -m "feat(cross-container): tutorial value help on Session + slug/title snapshot on save"
```

---

## Phase 3 — deploy bootstrap + verification (operational)

### Task V1: Bootstrap deploy + synonym-resolution verification

**Files:** none (operational runbook; confirm deploy scope with maintainer first).

- [ ] **Step 1: Phase 0** — ensure both containers exist with pinned `service-name` (Repo A `tutorials-hana` already; Repo B `devtoberfest-planner-db` from Task B0).
- [ ] **Step 2: Phase 1 deploy** — deploy Repo A db (view+role) and Repo B db (view+role) with the Phase-1 artifacts only. Confirm each view via `hana-cli views` on its own container.
- [ ] **Step 3: Phase 2 deploy** — deploy Repo B db with Leg A consumer artifacts + srv/app; deploy Repo A db with Leg B consumer artifacts.
- [ ] **Step 4: Phase 3 verify (the gate)** — through each synonym, run a real SQL read:
  ```bash
  # in the planner container: read tutorials via the synonym
  cds bind --exec -- hana-cli querySimple --query 'SELECT COUNT(*) FROM "TUTORIAL_VALUE_HELP_V1"'
  # in tutorials container: read planner sessions via the synonym
  cds bind --exec -- hana-cli querySimple --query 'SELECT COUNT(*) FROM "ACTIVITY_SESSION_V1"'
  ```
  Both must return rows before trusting the CAP facades.
- [ ] **Step 5: End-to-end** — in the planner UI, confirm the tutorial value help lists active tutorials and a pick persists.
- [ ] **Step 6: Update the workbook link registry** — flip both rows from `planned` to `live`.

```bash
# Repo A
git add docs/developers/architecture/cross-container-integration.md
git commit -m "docs(cross-container): mark Devtoberfest links live in registry"
```

---

## Self-review

**Spec coverage:** Leg A provider (A1) ✓, Leg A consumer (B2-B4) ✓, Leg A service+field+valuehelp (B5-B7) ✓, Leg B provider (B1) ✓, Leg B consumer reserved (A2-A5) ✓, service-name pin (B0) ✓, deployed-name introspection (Task 0, D4a) ✓, bootstrap phases (V1) ✓, registry update (V1.6) ✓, QA excluded (global constraint) ✓, separate-grants-file rule (A3 step 1) ✓, dual-mta mirror (A2) ✓.

**Placeholder scan:** Physical-name placeholders `<... phys>` in Task B1/A5 are intentional and gated on Task 0 (which produces them) — flagged, not vague. Facade column types in A5/B4 are copied from `hana-cli` output at build time (D4a), not guessed. Snapshot mechanism (B7) is a recorded decision point, not a TODO.

**Type consistency:** View name `TUTORIAL_VALUE_HELP_V1` / role `tutorial_value_help_reader` / facade `external.tutorials.TutorialValueHelpV1` used consistently across A1↔B2-B4-B5-B6-B7. `ACTIVITY_SESSION_V1` / `activity_session_reader` / `external.devtoberfest.ActivitySessionV1` consistent across B1↔A3-A5. Grant key = bound service name (`tutorials-hana` / `devtoberfest-planner-db`) matches the existing-service resource names.

## Notes for the executor

- **Cross-repo ordering:** Task 0 → (A1, B1, B0 in parallel) → Phase-1 deploy → (A2-A5, B2-B7) → Phase-2 deploy → V1. Provider views (A1/B1) must be deployed before the opposite repo's facade generation (A5 needs B1 deployed; B4 needs A1 deployed).
- **Repo B changes are a separate PR** in `devtoberfest-planner`; this repo's PR (#1350 + these Repo A tasks) is independent.
- Most validation is deploy-time on real containers — the only fast unit test is A1's filter semantics. Do not expect local unit coverage for synonym/facade resolution.
