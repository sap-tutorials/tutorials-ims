# Task-level Value Help (Tutorials + Puzzles) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Devtoberfest Planner author assign either a Tutorial or a Puzzle to an Activity, by publishing a cross-container union value-help view from tutorials-ims and re-wiring the planner's Activity value help onto it.

**Architecture:** tutorials-ims (`tutorials-hana` HDI container) is the **provider**: it publishes a new versioned union view `TASK_VALUE_HELP_V1` (Tutorials ∪ Puzzles, `TASKTYPE` discriminator, `SOLUTION` excluded) and grows its existing `tutorial_reader` role to grant SELECT on it. devtoberfest-planner (`devtoberfest-planner-db` container) is the **consumer**: a synonym + `@cds.persistence.exists` facade + read-only projection back a Fiori `@Common.ValueList` on a single discriminated `Activity.task` association. Provider-first deploy (workbook D5); the two repos ship as separate PRs.

**Tech Stack:** SAP CAP (Node.js) + CDS, SAP HANA Cloud HDI (`.hdbview`/`.hdbrole`/`.hdbsynonym`/`.hdbgrants`), Fiori Elements value-help annotations, `hana-cli` for deployed-object introspection, vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-07-31-task-value-help-tutorials-and-puzzles-design.md`
**Cross-container playbook:** `docs/developers/architecture/cross-container-integration.md`

## Global Constraints

- **Provider view output aliases MUST be UPPERCASE** (`AS "SLUG"`, not `AS "slug"`) — the consumer's generated view references them unquoted → HANA folds to UPPERCASE (workbook D4a). Facade entity elements MUST match, also UPPERCASE.
- **`Puzzles.solution` / `SOLUTION` MUST NEVER appear** in any view, projection, facade, or grant. Server-only per `srv/puzzle-service.cds`.
- **Published predicate is `STATUS = 'ACTIVE' OR STATUS IS NULL`** — applied per UNION branch.
- **Do NOT modify `TUTORIAL_VALUE_HELP_V1`** — new view alongside it (versioning policy D2).
- **Grow the existing `tutorial_reader` role; add NO new role and change NO consumer `.hdbgrants`** (workbook D3).
- **Introspect the DEPLOYED container with `hana-cli` for exact physical names/types before authoring the view** — never retype from CDS source (D4a / pre-flight checklist).
- **View version suffix `_V1` stays** — breaking changes go to `_V2`, never mutate `_V1` in a breaking way once consumed.
- **This repo's mta is dual-file** (`mta.yaml` + `.deploy/mta.yaml`) — but this plan adds only `db/src/*` HDI artifacts, which are picked up by the existing db-deployer module globs; no mta edit is required (verify in Task 1).
- **Repo A tasks (1–4) are executable in this worktree. Repo B tasks (5–12) target `D:\projects\devtoberfest-planner` — a separate repo and separate PR;** they are specified here for completeness but committed there, not in this worktree.

---

## File Structure

### Repo A — tutorials-ims (this repo/worktree)
- `db/src/TASK_VALUE_HELP_V1.hdbview` — **create**: union view, the provider API surface.
- `db/src/tutorial_reader.hdbrole` — **modify**: add SELECT on the new view.
- `db/src/tutorial_reader_grantable.hdbrole` — **modify**: add SELECT-with-grant on the new view.
- `test/unit/task-value-help-view.test.js` — **create**: view-shape + filter + no-solution assertions.
- `docs/developers/architecture/cross-container-integration.md` — **modify**: registry row.

### Repo B — devtoberfest-planner (separate repo, separate PR)
- `db/src/TASK_VALUE_HELP_V1.hdbsynonym` — **create**
- `db/external/tutorials.cds` — **modify**: add facade
- `db/schema.cds` — **modify**: `Activity` field rename/add
- `srv/sessions-service.cds` — **modify**: `Tasks` projection
- `srv/sessions-service-auth.cds` — **modify**: `Tasks` READ restriction
- `app/maintain-activities/annotations.cds` — **modify**: value help + LineItem + FieldGroup
- `srv/sessions-service.js` (or equivalent handler file) — **modify/create**: snapshot copy handler
- `db/data/*Activity*.csv` or a migration script — **create**: DEV data backfill

---

## Task 1: Introspect deployed tables + verify deploy wiring

**Files:**
- Read-only investigation; no file changes. Produces the verified physical column facts Task 2 depends on.

**Interfaces:**
- Produces: confirmed physical names/types for `COM_SAP_DEVELOPERS_IMS_TUTORIALS` and `COM_SAP_DEVELOPERS_IMS_PUZZLES` (columns `ID, SLUG, TITLE, PRIMARYTAG, EXPERIENCETAG, AVERAGETIMETOCOMPLETE, DESCRIPTION, STATUS, MDFILEURL, STEPCOUNT, LAYOUT`), and confirmation that `db/src/*.hdbview`/`*.hdbrole` are auto-globbed by the db-deployer (no mta edit).

- [ ] **Step 1: Bind to the deployed container and introspect both tables**

Run (from repo root; `cf` already targets `tutorial-system/dev`):
```bash
hana-cli inspectTable --table COM_SAP_DEVELOPERS_IMS_TUTORIALS
hana-cli inspectTable --table COM_SAP_DEVELOPERS_IMS_PUZZLES
```
(Or the MCP `hana_inspect_table` tool.) Record the **exact** catalog column names + HANA types for the columns listed in Interfaces. Confirm `SOLUTION` exists on Puzzles (so you know to exclude it) and note the catalog types of `LAYOUT` (expected NCLOB), `MDFILEURL` (expected NVARCHAR(1000)), `STEPCOUNT` (expected INTEGER). These drive the `CAST(NULL AS …)` pads in Task 2.

Expected: both tables resolve; columns present with the documented names (uppercase catalog identifiers).

- [ ] **Step 2: Verify HDI artifacts are auto-globbed (no mta edit needed)**

Read the db-deployer module in `.deploy/mta.yaml` (and `mta.yaml`) and the existing `db/src/TUTORIAL_VALUE_HELP_V1.hdbview` / `tutorial_reader.hdbrole` — confirm they are NOT individually enumerated anywhere (i.e. the deployer picks up everything under `db/src/`). 

Run:
```bash
grep -rn "TUTORIAL_VALUE_HELP_V1\|tutorial_reader" mta.yaml .deploy/mta.yaml || echo "not enumerated — glob-picked, good"
```
Expected: no hits (artifacts are glob-picked). If there ARE hits, the new view/role must be added to the same list — note it and handle in Task 2/3.

- [ ] **Step 3: Snapshot the existing view for the SQLite unit-test equivalent**

Re-read `db/src/TUTORIAL_VALUE_HELP_V1.hdbview` so Task 2's new view mirrors its alias style exactly. No commit in this task.

---

## Task 2: Publish the `TASK_VALUE_HELP_V1` union view

**Files:**
- Create: `db/src/TASK_VALUE_HELP_V1.hdbview`

**Interfaces:**
- Consumes: physical column names/types from Task 1.
- Produces: deployed HANA view `TASK_VALUE_HELP_V1` with columns (UPPERCASE) `ID, SLUG, TITLE, PRIMARYTAG, EXPERIENCETAG, AVERAGETIMETOCOMPLETE, DESCRIPTION, TASKTYPE, MDFILEURL, STEPCOUNT, LAYOUT`; `TASKTYPE ∈ {'TUTORIAL','PUZZLE'}`; rows filtered to `STATUS='ACTIVE' OR STATUS IS NULL`; NO `SOLUTION`.

- [ ] **Step 1: Write the view file**

Create `db/src/TASK_VALUE_HELP_V1.hdbview` (adjust `CAST` types only if Task 1 found different catalog types):
```sql
VIEW "TASK_VALUE_HELP_V1" AS
  SELECT "ID"                    AS "ID",
         "SLUG"                  AS "SLUG",
         "TITLE"                 AS "TITLE",
         "PRIMARYTAG"            AS "PRIMARYTAG",
         "EXPERIENCETAG"         AS "EXPERIENCETAG",
         "AVERAGETIMETOCOMPLETE" AS "AVERAGETIMETOCOMPLETE",
         "DESCRIPTION"           AS "DESCRIPTION",
         'TUTORIAL'              AS "TASKTYPE",
         "MDFILEURL"             AS "MDFILEURL",
         "STEPCOUNT"             AS "STEPCOUNT",
         CAST(NULL AS NCLOB)     AS "LAYOUT"
  FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
  WHERE "STATUS" = 'ACTIVE' OR "STATUS" IS NULL
  UNION ALL
  SELECT "ID"                    AS "ID",
         "SLUG"                  AS "SLUG",
         "TITLE"                 AS "TITLE",
         "PRIMARYTAG"            AS "PRIMARYTAG",
         "EXPERIENCETAG"         AS "EXPERIENCETAG",
         "AVERAGETIMETOCOMPLETE" AS "AVERAGETIMETOCOMPLETE",
         "DESCRIPTION"           AS "DESCRIPTION",
         'PUZZLE'                AS "TASKTYPE",
         CAST(NULL AS NVARCHAR(1000)) AS "MDFILEURL",
         CAST(NULL AS INTEGER)   AS "STEPCOUNT",
         "LAYOUT"                AS "LAYOUT"
  FROM "COM_SAP_DEVELOPERS_IMS_PUZZLES"
  WHERE "STATUS" = 'ACTIVE' OR "STATUS" IS NULL
```

- [ ] **Step 2: Sanity-check the SQL locally**

`.hdbview` is HANA-only (won't deploy to SQLite), so validation is by inspection + (optionally) a hybrid deploy in Task 4's verify. Confirm by eye: 11 columns, identical column count/order both branches, every alias UPPERCASE and double-quoted, no `SOLUTION`, `WHERE` on both branches.

Run:
```bash
grep -ci "solution" db/src/TASK_VALUE_HELP_V1.hdbview
```
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add db/src/TASK_VALUE_HELP_V1.hdbview
git commit -m "feat(xc): publish TASK_VALUE_HELP_V1 union view (tutorials + puzzles) for planner value help"
```

---

## Task 3: Grow the `tutorial_reader` role(s) to cover the new view

**Files:**
- Modify: `db/src/tutorial_reader.hdbrole`
- Modify: `db/src/tutorial_reader_grantable.hdbrole`

**Interfaces:**
- Consumes: view name `TASK_VALUE_HELP_V1` from Task 2.
- Produces: `tutorial_reader` grants SELECT on both `TUTORIAL_VALUE_HELP_V1` and `TASK_VALUE_HELP_V1`; `tutorial_reader#` grants SELECT-with-grant on both. No new role name; the planner's existing `container_roles: ["tutorial_reader"]` grant automatically picks up the new view.

- [ ] **Step 1: Add the object privilege to `tutorial_reader.hdbrole`**

Edit so `object_privileges` lists both views:
```json
{
  "role": {
    "name": "tutorial_reader",
    "object_privileges": [
      { "name": "TUTORIAL_VALUE_HELP_V1", "type": "VIEW", "privileges": [ "SELECT" ] },
      { "name": "TASK_VALUE_HELP_V1",      "type": "VIEW", "privileges": [ "SELECT" ] }
    ]
  }
}
```

- [ ] **Step 2: Add the grant-option privilege to `tutorial_reader_grantable.hdbrole`**

```json
{
  "role": {
    "name": "tutorial_reader#",
    "object_privileges": [
      { "name": "TUTORIAL_VALUE_HELP_V1", "type": "VIEW", "privileges_with_grant_option": [ "SELECT" ] },
      { "name": "TASK_VALUE_HELP_V1",      "type": "VIEW", "privileges_with_grant_option": [ "SELECT" ] }
    ]
  }
}
```

- [ ] **Step 3: Validate JSON**

Run:
```bash
jq . db/src/tutorial_reader.hdbrole db/src/tutorial_reader_grantable.hdbrole > /dev/null && echo "valid json"
```
Expected: `valid json`.

- [ ] **Step 4: Commit**

```bash
git add db/src/tutorial_reader.hdbrole db/src/tutorial_reader_grantable.hdbrole
git commit -m "feat(xc): grant tutorial_reader SELECT on TASK_VALUE_HELP_V1"
```

---

## Task 4: Unit test the view contract (SQLite equivalent) + hybrid deploy verify

**Files:**
- Create: `test/unit/task-value-help-view.test.js`

**Interfaces:**
- Consumes: the view semantics from Task 2 (union of active tutorials+puzzles, `TASKTYPE` discriminator, no `SOLUTION`).
- Produces: an automated guard that the union semantics hold. Because `.hdbview` doesn't run on SQLite, the unit test asserts the **equivalent SELECT** against the CDS entities to lock the contract; the real deployed view is verified via `hana-cli` in Step 4.

- [ ] **Step 1: Write the failing test**

Create `test/unit/task-value-help-view.test.js`. Mirror the union view's logic against the in-memory CDS model so the contract (columns, discriminator, filter, no-solution) is guarded. Follow the existing unit-test bootstrap in this repo (`cds.test('serve','--project','.','--in-memory')` — per the CLAUDE.md gotcha; do NOT use `cds.deploy(cds.model)`):
```javascript
const cds = require('@sap/cds');
const { expect } = require('chai');

describe('TASK_VALUE_HELP_V1 union contract (SQLite equivalent)', () => {
  const { GET, POST } = cds.test('serve', '--project', '.', '--in-memory');
  let db;
  before(async () => { db = await cds.connect.to('db'); });

  it('unions active tutorials and puzzles with a TASKTYPE discriminator, excluding SOLUTION', async () => {
    const { Tutorials, Puzzles } = cds.entities('com.sap.developers.ims');
    await db.run(INSERT.into(Tutorials).entries(
      { ID: cds.utils.uuid(), title: 'T-active',   slug: 't-active',   status: 'ACTIVE' },
      { ID: cds.utils.uuid(), title: 'T-null',     slug: 't-null',     status: null },
      { ID: cds.utils.uuid(), title: 'T-inactive', slug: 't-inactive', status: 'INACTIVE' },
    ));
    await db.run(INSERT.into(Puzzles).entries(
      { ID: cds.utils.uuid(), title: 'P-active', slug: 'p-active', status: 'ACTIVE',
        layout: '{"grid":[]}', solution: '{"0,0":"A"}' },
      { ID: cds.utils.uuid(), title: 'P-inactive', slug: 'p-inactive', status: 'INACTIVE',
        layout: '{}', solution: '{}' },
    ));

    // Equivalent of the union view (SQLite): active/null tutorials + active/null puzzles.
    const tuts = await db.run(SELECT.from(Tutorials)
      .columns('ID','slug','title','primaryTag','experienceTag','averageTimeToComplete','description','mdFileUrl','stepCount')
      .where(`status = 'ACTIVE' or status is null`));
    const puzs = await db.run(SELECT.from(Puzzles)
      .columns('ID','slug','title','primaryTag','experienceTag','averageTimeToComplete','description','layout')
      .where(`status = 'ACTIVE' or status is null`));

    const rows = [
      ...tuts.map(r => ({ ...r, TASKTYPE: 'TUTORIAL', LAYOUT: null })),
      ...puzs.map(r => ({ ...r, TASKTYPE: 'PUZZLE', mdFileUrl: null, stepCount: null })),
    ];

    const titles = rows.map(r => r.title).sort();
    expect(titles).to.deep.equal(['P-active', 'T-active', 'T-null']); // no inactive rows
    expect(rows.filter(r => r.TASKTYPE === 'TUTORIAL')).to.have.length(2);
    expect(rows.filter(r => r.TASKTYPE === 'PUZZLE')).to.have.length(1);
    for (const r of rows) expect(r).to.not.have.property('solution');
    for (const r of rows) expect(r).to.not.have.property('SOLUTION');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (or errors) first**

Run:
```bash
npx vitest run test/unit/task-value-help-view.test.js
```
Expected: FAIL initially if entity/import names are off — fix names against `db/schema.cds` until the test expresses the intended contract, then it should PASS once the SELECTs are correct. (This test encodes the contract; it passes when the equivalent logic is right. Its value is as a regression guard + documentation of intent.)

- [ ] **Step 3: Make it pass + run the full unit suite**

Run:
```bash
npx vitest run test/unit/task-value-help-view.test.js
npm test
```
Expected: target test PASS; no regressions in the suite.

- [ ] **Step 4: Hybrid deploy + `hana-cli` probe of the REAL view (verification gate)**

This is the load-bearing check that the `.hdbview` actually deploys and returns rows. Deploy the db module to DEV (confirm scope with maintainer — this is a db-only, additive deploy) or use an existing hybrid binding, then:
```bash
hana-cli query "SELECT \"TASKTYPE\", COUNT(*) AS N FROM \"TASK_VALUE_HELP_V1\" GROUP BY \"TASKTYPE\""
hana-cli query "SELECT COUNT(*) FROM \"TASK_VALUE_HELP_V1\""   # sanity
```
Expected: two rows (`TUTORIAL`, `PUZZLE`) with non-negative counts; the view resolves. Confirm no `SOLUTION` column: `hana-cli inspectView --view TASK_VALUE_HELP_V1` shows 11 columns, none named `SOLUTION`.

- [ ] **Step 5: Commit**

```bash
git add test/unit/task-value-help-view.test.js
git commit -m "test(xc): guard TASK_VALUE_HELP_V1 union contract (both types, active-only, no solution)"
```

---

## Task 5: Update cross-container registry + close out Repo A

**Files:**
- Modify: `docs/developers/architecture/cross-container-integration.md`

**Interfaces:**
- Consumes: the deployed view + role from Tasks 2–4.
- Produces: an up-to-date link registry so the next engineer sees `TASK_VALUE_HELP_V1` as a live provider surface.

- [ ] **Step 1: Add the registry row**

In the "Cross-container link registry" table, add:
```markdown
| `tutorials-hana` | `TASK_VALUE_HELP_V1` | `devtoberfest-planner-db` | `external.tutorials.TASK_VALUE_HELP_V1` | V1 | planned | Activity task (tutorial/puzzle) value help |
```

- [ ] **Step 2: Commit + open the Repo A PR**

```bash
git add docs/developers/architecture/cross-container-integration.md
git commit -m "docs(xc): register TASK_VALUE_HELP_V1 link"
git push -u origin worktree-task-value-help-1417
gh pr create --draft --title "feat(xc): TASK_VALUE_HELP_V1 union value-help view (tutorials + puzzles)" \
  --body "Provider side of the Devtoberfest Activity task value help. Publishes TASK_VALUE_HELP_V1 (tutorials ∪ puzzles, TASKTYPE discriminator, SOLUTION excluded) + grows tutorial_reader. Consumer wiring is a separate PR in devtoberfest-planner. Spec: docs/superpowers/specs/2026-07-31-task-value-help-tutorials-and-puzzles-design.md"
```

---

## Repo B — devtoberfest-planner (SEPARATE REPO + SEPARATE PR)

> Tasks 6–12 are implemented in `D:\projects\devtoberfest-planner`, on its own branch, and pushed to `github.tools.sap/developer-relations/devtoberfest-planner`. Do NOT commit them in the tutorials-ims worktree. Deploy them ONLY after Repo A's view is live on DEV and Task 4 Step 4's probe passed (workbook D5 provider-first).

## Task 6: Synonym targeting the new view

**Files:**
- Create: `db/src/TASK_VALUE_HELP_V1.hdbsynonym`

**Interfaces:**
- Consumes: deployed `TASK_VALUE_HELP_V1` in `tutorials-hana`; existing `tutorials-grants.hdbgrants` (requests `tutorial_reader`, now covers this view — no grants change).
- Produces: local synonym `TASK_VALUE_HELP_V1` resolving to the provider view.

- [ ] **Step 1: Create the synonym**
```jsonc
{ "TASK_VALUE_HELP_V1": { "target": { "object": "TASK_VALUE_HELP_V1" } } }
```
No `.hdbsynonymconfig` (HDI-to-HDI).

- [ ] **Step 2: Verify grants already cover it (no change expected)**

Run in the planner repo:
```bash
cat db/src/tutorials-grants.hdbgrants   # confirm container_roles: ["tutorial_reader"]
```
Expected: `tutorial_reader` requested for `object_owner` + `application_user`; no edit needed.

- [ ] **Step 3: Commit** (in planner repo)
```bash
git add db/src/TASK_VALUE_HELP_V1.hdbsynonym
git commit -m "feat(xc): synonym for tutorials-hana TASK_VALUE_HELP_V1"
```

---

## Task 7: `@cds.persistence.exists` facade for the union view

**Files:**
- Modify: `db/external/tutorials.cds`

**Interfaces:**
- Consumes: the deployed view's exact column names/case (introspect, don't retype).
- Produces: `external.tutorials.TASK_VALUE_HELP_V1` facade entity with UPPERCASE elements matching the view.

- [ ] **Step 1: Generate the facade from the DEPLOYED view (not by hand)**

After the synonym deploys (or against the provider directly), run:
```bash
hana-cli inspectView --view TASK_VALUE_HELP_V1 --output cds
```
Verify it emits UPPERCASE element names. Append to `db/external/tutorials.cds`:
```cds
@cds.persistence.exists
entity TASK_VALUE_HELP_V1 {
  key ID                    : String(36);
      SLUG                  : String(255);
      TITLE                 : String(255);
      PRIMARYTAG            : String(255);
      EXPERIENCETAG         : String(255);
      AVERAGETIMETOCOMPLETE : Integer;
      DESCRIPTION           : LargeString;
      TASKTYPE              : String(20);
      MDFILEURL             : String(1000);
      STEPCOUNT             : Integer;
      LAYOUT                : LargeString;
}
```
Keep the existing `TUTORIAL_VALUE_HELP_V1` facade in the file (untouched).

- [ ] **Step 2: Compile-check the planner model**

Run:
```bash
npx cds compile db/external/tutorials.cds
```
Expected: compiles, no errors.

- [ ] **Step 3: Commit** (planner repo)
```bash
git add db/external/tutorials.cds
git commit -m "feat(xc): facade over TASK_VALUE_HELP_V1"
```

---

## Task 8: Rewire `Activity` to a discriminated `task` association

**Files:**
- Modify: `db/schema.cds` (the planner's, `namespace devtoberfest`)

**Interfaces:**
- Consumes: facade `external.tutorials.TASK_VALUE_HELP_V1` (Task 7).
- Produces: `Activity.task` (Association → facade), `Activity.taskType : String(20)`, `Activity.taskSlug`, `Activity.taskTitle`. Removes `Activity.tutorial`, `tutorialSlug`, `tutorialTitle`.

- [ ] **Step 1: Edit the `Activity` entity**

Replace:
```cds
tutorial      : Association to tutorials.TUTORIAL_VALUE_HELP_V1 @mandatory @changelog @title: 'Tutorial';
tutorialSlug  : String(255);
tutorialTitle : String(255);
```
with:
```cds
task      : Association to tutorials.TASK_VALUE_HELP_V1 @mandatory @changelog @title: 'Task';
taskType  : String(20) @title: 'Type';   // 'TUTORIAL' | 'PUZZLE' snapshot of task.TASKTYPE
taskSlug  : String(255);
taskTitle : String(255);
```
Confirm the `using { external.tutorials }` import already present (it is).

- [ ] **Step 2: Compile-check**

Run:
```bash
npx cds compile db/schema.cds
```
Expected: compiles (the `@mandatory` association generates `task_ID` FK column).

- [ ] **Step 3: Commit** (planner repo)
```bash
git add db/schema.cds
git commit -m "feat: Activity.task discriminated link (tutorial or puzzle) replaces Activity.tutorial"
```

---

## Task 9: Project `Tasks` in SessionsService + auth restriction

**Files:**
- Modify: `srv/sessions-service.cds`
- Modify: `srv/sessions-service-auth.cds`

**Interfaces:**
- Consumes: facade (Task 7).
- Produces: `SessionsService.Tasks` read-only projection (value-help source), READ-restricted to `['SystemAdmin','TrackOwner','TrackViewer']`. Removes `SessionsService.Tutorials`.

- [ ] **Step 1: Swap the projection in `sessions-service.cds`**

Replace:
```cds
@readonly entity Tutorials     as projection on tutorials.TUTORIAL_VALUE_HELP_V1;
```
with:
```cds
// Cross-container task value help (tutorials ∪ puzzles) over TASK_VALUE_HELP_V1.
@readonly entity Tasks as projection on tutorials.TASK_VALUE_HELP_V1;
```

- [ ] **Step 2: Swap the auth annotation in `sessions-service-auth.cds`**

Replace the `SessionsService.Tutorials` restriction block with:
```cds
annotate SessionsService.Tasks @(restrict: [
  { grant: 'READ', to: ['SystemAdmin', 'TrackOwner', 'TrackViewer'] }
]);
```

- [ ] **Step 3: Compile-check the service**

Run:
```bash
npx cds compile srv/sessions-service.cds
```
Expected: compiles; no reference to a now-missing `Tutorials` entity remains (grep to be sure):
```bash
grep -rn "SessionsService.Tutorials\|entity Tutorials" srv/ app/ || echo "no dangling Tutorials refs"
```

- [ ] **Step 4: Commit** (planner repo)
```bash
git add srv/sessions-service.cds srv/sessions-service-auth.cds
git commit -m "feat: expose SessionsService.Tasks value help; retire Tutorials projection"
```

---

## Task 10: Repoint the Activity value help + list/detail UI

**Files:**
- Modify: `app/maintain-activities/annotations.cds`

**Interfaces:**
- Consumes: `SessionsService.Tasks` (Task 9) and `Activity.task_ID`/`taskType`/`taskTitle` (Task 8).
- Produces: a `@Common.ValueList` on `task_ID` sourced from `Tasks`, showing the kind; LineItem + FieldGroup updated.

- [ ] **Step 1: Replace the `tutorial` value help with a `task` value help**

Replace the `tutorial @( … )` block with:
```cds
  task @(
    Common.Label                   : 'Task',
    Common.Text                    : task.TITLE,
    Common.TextArrangement         : #TextOnly,
    Common.ValueListWithFixedValues: false,
    Common.ValueList               : {
      $Type         : 'Common.ValueListType',
      CollectionPath: 'Tasks',
      Parameters    : [
        { $Type: 'Common.ValueListParameterOut',         LocalDataProperty: task_ID, ValueListProperty: 'ID' },
        { $Type: 'Common.ValueListParameterDisplayOnly',  ValueListProperty: 'TASKTYPE' },
        { $Type: 'Common.ValueListParameterDisplayOnly',  ValueListProperty: 'TITLE' },
        { $Type: 'Common.ValueListParameterDisplayOnly',  ValueListProperty: 'SLUG' },
        { $Type: 'Common.ValueListParameterDisplayOnly',  ValueListProperty: 'PRIMARYTAG' }
      ]
    }
  );
```

- [ ] **Step 2: Update LineItem + FieldGroup**

In `UI.LineItem`, replace the `{ Value: tutorialTitle, Label: 'Tutorial' }` entry with:
```cds
    { Value: taskTitle, Label: 'Task' },
    { Value: taskType,  Label: 'Type' },
```
In `UI.FieldGroup #Details`, replace `{ Value: tutorial_ID, Label: 'Tutorial' }` with:
```cds
      { Value: task_ID,  Label: 'Task' },
      { Value: taskType, Label: 'Type' },
```

- [ ] **Step 3: Compile-check**

Run:
```bash
npx cds compile app/maintain-activities/annotations.cds
grep -rn "tutorial_ID\|tutorialTitle\|CollectionPath: 'Tutorials'" app/ || echo "no dangling tutorial refs"
```
Expected: compiles; no dangling `tutorial_*` references.

- [ ] **Step 4: Commit** (planner repo)
```bash
git add app/maintain-activities/annotations.cds
git commit -m "feat: Activity task value help lists tutorials + puzzles with kind"
```

---

## Task 11: Snapshot copy handler (taskType/slug/title at save)

**Files:**
- Modify (or create): the SessionsService implementation file — `srv/sessions-service.js` (check for an existing handler file first; the planner may already have a snapshot handler for the old `tutorial` field to adapt).

**Interfaces:**
- Consumes: picked `task_ID` on Activity draft-save; the `Tasks`/facade for lookup.
- Produces: `taskType`, `taskSlug`, `taskTitle` populated from the picked row on CREATE/UPDATE (draft save).

- [ ] **Step 1: Find any existing tutorial-snapshot handler**

Run in planner repo:
```bash
grep -rn "tutorialSlug\|tutorialTitle\|tutorial_ID" srv/
```
If a handler copied `tutorial` snapshot fields, adapt it; otherwise add a fresh one.

- [ ] **Step 2: Write the failing hybrid test**

Add a test asserting that saving an Activity with a `task_ID` populates the snapshot. Use the planner's existing test bootstrap (match its pattern — check `test/`):
```javascript
// test/activities-snapshot.test.js (adapt to the planner's harness)
it('copies taskType/slug/title from the picked task on save', async () => {
  const tasks = await GET(`/sessions/Tasks?$top=1`);
  const picked = tasks.data.value[0];
  const created = await POST(`/sessions/Activities`, {
    title: 'A1', track_ID: someActivityTrackId, points: 10, task_ID: picked.ID,
  });
  expect(created.data.taskType).to.equal(picked.TASKTYPE);
  expect(created.data.taskSlug).to.equal(picked.SLUG);
  expect(created.data.taskTitle).to.equal(picked.TITLE);
});
```

- [ ] **Step 3: Run it — expect fail**

Run: `npx cds test` (or the planner's test command). Expected: FAIL (snapshot fields empty).

- [ ] **Step 4: Implement the handler**

In `srv/sessions-service.js`:
```javascript
module.exports = cds.service.impl(function () {
  const { Activities, Tasks } = this.entities;
  this.before(['CREATE', 'UPDATE'], Activities, async (req) => {
    const taskId = req.data.task_ID;
    if (!taskId) return;
    const row = await SELECT.one.from(Tasks).where({ ID: taskId })
      .columns('TASKTYPE', 'SLUG', 'TITLE');
    if (row) {
      req.data.taskType  = row.TASKTYPE;
      req.data.taskSlug  = row.SLUG;
      req.data.taskTitle = row.TITLE;
    }
  });
});
```
(If the file already has an impl, merge this `before` handler in rather than overwriting.)

- [ ] **Step 5: Run tests — expect pass**

Run: `npx cds test`. Expected: PASS.

- [ ] **Step 6: Commit** (planner repo)
```bash
git add srv/sessions-service.js test/
git commit -m "feat: snapshot taskType/slug/title on Activity save"
```

---

## Task 12: DEV data migration for existing Activities + planner PR

**Files:**
- Create: a one-shot migration (SQL script or CSV) appropriate to the planner's tooling.

**Interfaces:**
- Consumes: existing DEV `Activity` rows with old `tutorial_ID`/`tutorialSlug`/`tutorialTitle` values (if any).
- Produces: those rows carry `task_ID` (= old `tutorial_ID`), `taskType='TUTORIAL'`, `taskSlug`/`taskTitle` (= old snapshot).

- [ ] **Step 1: Check whether DEV has any Activity rows to migrate**

Run (against planner DEV via hana-cli / cds bind):
```bash
hana-cli query "SELECT COUNT(*) FROM \"DEVTOBERFEST_ACTIVITY\""
```
If 0 → no migration needed; note it and skip to Step 3. Confirm ownership with the planner owner regardless (spec open item).

- [ ] **Step 2: Backfill (only if rows exist)**

The column rename drops the old columns on redeploy; capture old values BEFORE deploy or from the pre-deploy table. Backfill script:
```sql
UPDATE "DEVTOBERFEST_ACTIVITY"
   SET "TASK_ID"   = "TUTORIAL_ID",
       "TASKTYPE"  = 'TUTORIAL',
       "TASKSLUG"  = "TUTORIALSLUG",
       "TASKTITLE" = "TUTORIALTITLE"
 WHERE "TASK_ID" IS NULL AND "TUTORIAL_ID" IS NOT NULL;
```
(Exact column identifiers per the deployed catalog — verify with `hana-cli inspectTable`.) Since existing links are all tutorials, `TASKTYPE='TUTORIAL'` is correct for every migrated row.

- [ ] **Step 3: Deploy planner to DEV, then run the e2e verify**

Per workbook D5, Repo A view must already be live (Task 4 gate passed). Deploy the planner, open `app/maintain-activities`, edit an Activity, open the Task value help — confirm **both** a tutorial and a puzzle appear and are labelled by type; pick each and confirm `task_ID` + `taskType` + snapshot persist. (This is the "test the actual thing" gate — exercise it in the browser, not just curl.)

- [ ] **Step 4: Commit + open the planner PR**
```bash
git add <migration file>
git commit -m "chore: migrate existing Activity tutorial links to task_ID"
git push -u origin <planner-branch>
gh pr create --draft --title "feat: Activity task value help (tutorials + puzzles)" \
  --body "Consumer side. Synonym+facade over tutorials-hana TASK_VALUE_HELP_V1; Activity.task discriminated link; value help lists tutorials + puzzles. Requires tutorials-ims provider PR deployed first. Spec: (tutorials-ims) docs/superpowers/specs/2026-07-31-task-value-help-tutorials-and-puzzles-design.md"
```

---

## Self-Review

**Spec coverage:**
- A1 view → Task 2 ✓; A2 role growth → Task 3 ✓; A3 unit test → Task 4 ✓; registry → Task 5 ✓.
- B1 synonym → Task 6 ✓; B2 facade → Task 7 ✓; B3 schema → Task 8 ✓; B4 projection → Task 9 ✓; B5 auth → Task 9 ✓; B6 annotations → Task 10 ✓; B7 snapshot handler → Task 11 ✓; B8 migration → Task 12 ✓.
- Deploy sequence (provider-first, verify gate) → Task 4 Step 4 gate + Task 12 Step 3 ordering ✓.
- "No SOLUTION" constraint → Task 2 Step 2 + Task 4 assertions ✓.
- D4a UPPERCASE → Global Constraints + Task 2 (aliases) + Task 7 (facade generated from deployed view) ✓.

**Placeholder scan:** No TBD/TODO; every code step has concrete content. Task 1 is investigation (no code) but produces named facts. Migration exact identifiers flagged to verify against catalog (legitimate — physical names must be introspected per D4a, not guessed).

**Type consistency:** `TASK_VALUE_HELP_V1` columns are UPPERCASE consistently across view (Task 2), facade (Task 7), value-help `ValueListProperty` (Task 10), and handler SELECT (Task 11). `Activity.task`/`task_ID`/`taskType`/`taskSlug`/`taskTitle` consistent across Tasks 8, 10, 11, 12.

**Note on Task 4 test:** the `.hdbview` cannot execute on SQLite, so the unit test asserts the *equivalent* CDS-level query, and the real deployed view is verified by `hana-cli` probe (Task 4 Step 4). This is the honest guard available; called out explicitly rather than pretending the SQLite test exercises the physical view.
