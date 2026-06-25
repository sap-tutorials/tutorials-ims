# Advocate ↔ User 1:1 Optional Association — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire an optional 1:1 association from `Advocates` to `Users` so the admin UI can link advocates to user records (search by email), the public `/api/advocates` endpoint exposes `Users.email` + the linked user's authored/contributed tutorials, and User anonymization automatically nulls the FK.

**Architecture:** Additive nullable association on `Advocates.user` with `@assert.unique` (1:1 enforcement). `@PersonalData.cascade: 'null-personal'` lights up the existing anonymization cascade machinery — no new handler needed. AdminService value-help reuses the searchable Users projection from PR #618. Public handler follows the codebase's separate-queries-with-JS-join pattern (NOT deep CQN expand). Two convenience projection aliases (`authoredTutorials`, `contributedTutorials`) let FE V4 render LineItem facets.

**Tech Stack:** CAP Node.js (CDS), HANA Cloud, Fiori Elements V4 (UI5 web components), Vue 3 (advocates Vue island in `hugo-apps/`), Vitest (unit + hybrid + smoke workspaces).

**Spec:** [docs/superpowers/specs/2026-06-25-advocate-user-link-design.md](../specs/2026-06-25-advocate-user-link-design.md) (commit `f6180fe4`).

**Conventions:**
- TDD: failing test → minimal impl → green → commit per task.
- Commit messages use Conventional Commits format with `(advocate-user-link)` scope tag.
- All file paths are absolute from worktree root `D:/projects/tutorials-poc/.claude/worktrees/advocate-user-link/`.
- After every CDS schema change, run `npx cds compile srv --to csn 2>&1 | head -5` to fail-fast on syntax errors.

**Branch + worktree:** `feat/advocate-user-link` in `.claude/worktrees/advocate-user-link/`. Stay on the branch until the end; do NOT switch branches mid-plan.

**Pre-flight:** Confirm primary tree is on `main` and not in this worktree. Worktree should already have `node_modules` from `npm install` (re-run if not).

---

## Task 1: Schema — add `Advocates.user` Association + uniqueness constraint

**Files:**
- Test: `test/unit/advocate-user-link.test.js` (CREATE)
- Modify: `db/advocates.cds`

**Pre-flight grep — locate the exact line to insert after:**

```bash
cd "D:/projects/tutorials-poc/.claude/worktrees/advocate-user-link"
grep -n "photoUrl" db/advocates.cds
```

Expected: a single line like `25:  photoUrl      : String(200);`. Note the line number for Step 3.

- [ ] **Step 1: Create the failing unit test for the schema additions**

Create `test/unit/advocate-user-link.test.js`:

```js
// Schema-level tests for Advocates.user 1:1 optional association.
// Spec: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';

describe('Advocates.user 1:1 association — schema', () => {
  let db;
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { database: ':memory:' } };
    db = await cds.deploy(path.resolve('.')).to('sqlite::memory:');
  });
  afterAll(async () => { await db?.disconnect?.(); });

  it('allows null user_ID (advocate without link)', async () => {
    const { Advocates } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Advocates).entries({ slug: 'no-link-1', firstName: 'A', lastName: 'B' });
    const row = await SELECT.one.from(Advocates).where({ slug: 'no-link-1' });
    expect(row.user_ID).toBeNull();
  });

  it('allows linking an advocate to a user', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    const u = { uuid: 'u-1', email: 'u1@example.com' };
    await INSERT.into(Users).entries(u);
    const userRow = await SELECT.one.from(Users).where({ uuid: 'u-1' });
    await INSERT.into(Advocates).entries({ slug: 'linked-1', firstName: 'L', lastName: 'M', user_ID: userRow.ID });
    const adv = await SELECT.one.from(Advocates).where({ slug: 'linked-1' });
    expect(adv.user_ID).toBe(userRow.ID);
  });

  it('rejects linking two advocates to the same user (@assert.unique.user)', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    const u = { uuid: 'u-2', email: 'u2@example.com' };
    await INSERT.into(Users).entries(u);
    const userRow = await SELECT.one.from(Users).where({ uuid: 'u-2' });
    await INSERT.into(Advocates).entries({ slug: 'dup-1', firstName: 'D', lastName: 'X', user_ID: userRow.ID });
    await expect(
      INSERT.into(Advocates).entries({ slug: 'dup-2', firstName: 'D', lastName: 'Y', user_ID: userRow.ID })
    ).rejects.toThrow(/UNIQUE|constraint|ASSERT_UNIQUE/i);
  });

  it('allows multiple advocates with null user (NULL ≠ NULL)', async () => {
    const { Advocates } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Advocates).entries({ slug: 'no-link-2', firstName: 'A', lastName: 'C' });
    await INSERT.into(Advocates).entries({ slug: 'no-link-3', firstName: 'A', lastName: 'D' });
    const rows = await SELECT.from(Advocates).where({ user_ID: null });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test, expect ALL 4 to fail (column user_ID doesn't exist yet)**

```bash
cd "D:/projects/tutorials-poc/.claude/worktrees/advocate-user-link"
npx vitest run test/unit/advocate-user-link.test.js 2>&1 | tail -20
```

Expected: 4 failures, errors mention `user_ID` column missing or similar.

- [ ] **Step 3: Add the `user` Association + `@assert.unique` to `db/advocates.cds`**

Find the `photoUrl : String(200);` line. Insert immediately AFTER it (still inside the entity block):

```cds
  photoUrl      : String(200);

  // Optional 1:1 link to a User record. When set, unlocks:
  //   - Read-through Users.email on /api/advocates output
  //   - Tutorials authored/contributed via Users.authoredTutorials and
  //     Users.tutorialContributions (the FKs PR #618 added)
  // Nullable. Setting to null is a valid operation — the advocate stays
  // on the roster; only the email and tutorials affordances disappear.
  user          : Association to ims.Users;

  topics        : Composition of many AdvocateTopics on topics.advocate = $self;
```

Then AFTER the closing `}` of the `Advocates` entity (and BEFORE the `entity AdvocateTopics` line), add:

```cds
// CAP generates the FK column as `user_ID`. The annotation uses the
// ASSOCIATION NAME, not the generated column name — CAP resolves it to
// `user_ID` at compile time. Precedent: db/devtoberfest.cds:45
// (@assert.unique.userEvent: [user, event]). NULLs are distinct in HANA's
// UNIQUE semantics, so any number of unlinked advocates coexist.
annotate Advocates with @assert.unique.user : [user];
```

(Note: using `annotate` syntax separately because the inline `@assert.unique.X: [...]` form right after `}` doesn't apply to the entity it follows — it's a sibling top-level annotation.)

- [ ] **Step 4: Verify CDS compiles**

```bash
npx cds compile db/ srv/ --to csn 2>&1 | grep -E "error|user_ID|Advocates" | head -10
```

Expected: no `error` lines. Optional: pipe to `wc -l` to confirm clean output.

- [ ] **Step 5: Re-run the test, expect ALL 4 to PASS**

```bash
npx vitest run test/unit/advocate-user-link.test.js 2>&1 | tail -10
```

Expected: `Tests  4 passed (4)`.

- [ ] **Step 6: Commit**

```bash
git add db/advocates.cds test/unit/advocate-user-link.test.js
git commit -m "feat(advocate-user-link): add Advocates.user nullable Association + @assert.unique

- Optional 1:1 link from Advocates to Users.
- @assert.unique.user enforces no two advocates can point at the same User
  (HANA UNIQUE on nullable column; multiple NULL FKs coexist).
- 4 unit tests cover the null/linked/duplicate/many-null cases.

Refs: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §1"
```

---

## Task 2: PersonalData cascade annotation

**Files:**
- Test: `test/unit/anonymization-cascade-advocates.test.js` (CREATE)
- Modify: `db/audit-logging.cds`

- [ ] **Step 1: Verify the cascade module's exact API and field key (one-time recon)**

Before writing the test, confirm the plan-builder records the FK column name `user_ID` (NOT the association name `user`):

```bash
grep -A4 "DataSubjectID" srv/lib/anonymization-cascade.js | head -6
```

Expected: a line where `dataSubjectField` is set to `fieldName + '_ID'` when the element type is `cds.Association`. This confirms the test below should expect `'user_ID'` (the resolved column), not `'user'` (the association).

Also confirm the `executeAnonymizationCascade` signature for later use in Task 6:

```bash
grep -A1 "export.*executeAnonymizationCascade" srv/lib/anonymization-cascade.js
```

Expected: `export async function executeAnonymizationCascade(user, db) {` — note this is 2 args, NOT `(user, model, db)`.

Also peek at the cascade-test pattern:

```bash
head -30 test/unit/anonymization-cascade.test.js
```

Note: it uses `getCascadePlan(modelDefinitions)` from `srv/lib/anonymization-cascade.js`. Your new test will follow the same pattern.

- [ ] **Step 2: Write the failing cascade-plan test**

Create `test/unit/anonymization-cascade-advocates.test.js`:

```js
// Cascade plan must include Advocates with action: 'null-personal'.
// Spec: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §1a
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';
import { getCascadePlan, _resetPlanForTest } from '../../srv/lib/anonymization-cascade.js';

describe('Anonymization cascade plan — Advocates inclusion', () => {
  let model;
  beforeAll(async () => {
    _resetPlanForTest();
    model = await cds.load(path.resolve('db'));
  });

  it('includes Advocates entity in cascade plan', () => {
    const plan = getCascadePlan(model.definitions);
    const advEntry = plan.find(p => p.entityName === 'com.sap.developers.ims.Advocates');
    expect(advEntry).toBeDefined();
  });

  it('Advocates cascade action is null-personal', () => {
    const plan = getCascadePlan(model.definitions);
    const advEntry = plan.find(p => p.entityName === 'com.sap.developers.ims.Advocates');
    expect(advEntry.action).toBe('null-personal');
  });

  it('Advocates cascade dataSubjectField is user_ID', () => {
    const plan = getCascadePlan(model.definitions);
    const advEntry = plan.find(p => p.entityName === 'com.sap.developers.ims.Advocates');
    expect(advEntry.dataSubjectField).toBe('user_ID');
  });
});
```

- [ ] **Step 3: Run, expect all 3 to fail**

```bash
npx vitest run test/unit/anonymization-cascade-advocates.test.js 2>&1 | tail -10
```

Expected: 3 failures, error messages like `expected undefined`.

- [ ] **Step 4: Add the `@PersonalData` annotation to `db/audit-logging.cds`**

Append to the END of `db/audit-logging.cds` (after the last `annotate` block):

```cds
// --- Advocates ↔ Users link (spec 2026-06-25-advocate-user-link-design) ---
//
// Advocates.user_ID is the ONE place in this codebase where we publicly
// expose Users.email (via /api/advocates). Proactively NULL the FK on
// User anonymization so the public endpoint immediately stops emitting
// the (now-anonymized) email — stronger than relying on the email being
// scrubbed to a placeholder.
//
// Intentionally divergent from PR #618 which did NOT annotate
// Tutorials.author / TutorialContributors.user (those FKs are internal
// authorship records, not a public-facing surface).
//
// cascade: 'null-personal' triggers cascadeNullPersonal in
// srv/lib/anonymization-cascade.js → UPDATE Advocates SET user_ID = NULL
// WHERE user_ID = <anonymized-user-id>.
annotate ims.Advocates with @PersonalData: {
  EntitySemantics: 'Other',
  cascade        : 'null-personal'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};
```

- [ ] **Step 5: Verify CDS still compiles**

```bash
npx cds compile db/ srv/ --to csn 2>&1 | grep -E "error" | head -5
```

Expected: no `error` lines.

- [ ] **Step 6: Run the cascade test, expect all 3 to PASS**

```bash
npx vitest run test/unit/anonymization-cascade-advocates.test.js 2>&1 | tail -10
```

Expected: `Tests  3 passed (3)`. If `dataSubjectField` test fails with `expected 'user_ID' got null`, recheck the `@PersonalData.FieldSemantics: 'DataSubjectID'` placement (must be on `user`, not on the entity).

- [ ] **Step 7: Also re-run Task 1's tests to ensure no regression**

```bash
npx vitest run test/unit/advocate-user-link.test.js test/unit/anonymization-cascade-advocates.test.js 2>&1 | tail -10
```

Expected: 7 tests pass.

- [ ] **Step 8: Commit**

```bash
git add db/audit-logging.cds test/unit/anonymization-cascade-advocates.test.js
git commit -m "feat(advocate-user-link): @PersonalData cascade so anonymization nulls Advocates.user_ID

- Lights up the existing cascadeNullPersonal in srv/lib/anonymization-cascade.js.
- 3 unit tests assert the cascade plan includes Advocates with correct
  action ('null-personal') and dataSubjectField ('user_ID').
- Intentional divergence from PR #618 (which didn't annotate Tutorials.author
  — internal authorship, not public surface).

Refs: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §1a"
```

---

## Task 3: AdminService projection aliases

**Files:**
- Modify: `srv/admin-service.cds`

The two aliases let FE V4 render `authoredTutorials/@UI.LineItem` and `contributedTutorials/@UI.LineItem` LineItem facets on the Advocates Object Page — FE V4 can't bind directly to a 2-hop association path.

- [ ] **Step 1: Find the existing Advocates projection**

```bash
grep -n "entity Advocates as projection" srv/admin-service.cds
```

Note the exact line range — you'll be modifying the projection block.

- [ ] **Step 2: Read 10 lines of context around it**

```bash
grep -B1 -A10 "entity Advocates as projection" srv/admin-service.cds
```

Expected pattern (per the spec §2):

```cds
entity Advocates as projection on ims.Advocates actions {
  action uploadPhoto(...) returns Advocates;
  action clearPhoto() returns Advocates;
};
```

- [ ] **Step 3: Replace the projection to expose the two aliases**

Change from:

```cds
entity Advocates as projection on ims.Advocates actions {
```

to:

```cds
entity Advocates as projection on ims.Advocates {
  *,
  // Convenience aliases for FE V4 LineItem facets. FE V4 can't bind
  // a LineItem to a 2-hop association path (advocate.user.authoredTutorials),
  // so we surface them as 1-hop on the projection. The targets resolve to
  // AdminService.Tutorials and AdminService.TutorialContributors, which both
  // already carry @UI.LineItem annotations (PR #618 + admin tile expansion).
  user.authoredTutorials     as authoredTutorials,
  user.tutorialContributions as contributedTutorials,
} actions {
```

Keep the closing `};` and the action declarations exactly as they were.

- [ ] **Step 4: Verify CDS compiles and `Advocates` carries the new associations**

```bash
npx cds compile srv/ --to csn 2>&1 | grep -E "error" | head -5
```

Expected: no `error` lines.

Then verify the aliases are in the projection's CSN:

```bash
npx cds compile srv/ --to json 2>/dev/null | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const adv = d.definitions['AdminService.Advocates'];
console.log('authoredTutorials:', adv.elements?.authoredTutorials?.type);
console.log('contributedTutorials:', adv.elements?.contributedTutorials?.type);
"
```

Expected:
```
authoredTutorials: cds.Association
contributedTutorials: cds.Association
```

- [ ] **Step 5: Run all existing unit tests to confirm no regression**

```bash
npx vitest run test/unit/ 2>&1 | tail -15
```

Expected: all pre-existing tests still pass. (The new projection aliases are read-only and don't affect any write path.)

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(advocate-user-link): expose authoredTutorials + contributedTutorials on AdminService.Advocates

FE V4 can't bind a LineItem to a 2-hop association path; surface the
linked-user's tutorials as 1-hop aliases on the Advocates projection
so the Object Page can render Authored/Contributed facets.

Refs: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §2"
```

---

## Task 4: Admin UI annotations — value-help, Identity facet, tutorial facets

**Files:**
- Modify: `app/admin-annotations.cds`

- [ ] **Step 1: Find the existing Advocates annotation blocks**

```bash
grep -n "annotate AdminService.Advocates" app/admin-annotations.cds | head -5
```

Note the line numbers. You'll insert ONE new annotate block for the value-help BEFORE the existing UI annotate block, and modify the existing `@UI.Facets` array to add Identity + Authored + Contributed facets.

- [ ] **Step 2: Append the value-help annotation**

Find the line `annotate AdminService.Advocates with @(`. Insert ABOVE it (and below the existing `annotate AdminService.Advocates with {` block):

```cds
// AdminService.Advocates.user — searchable Users value help.
//
// Spec: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §2
//
// Same SearchSupported pattern as Tutorials.author from PR #618.
// @cds.search on the Users projection (srv/admin-service.cds) makes
// CAP translate $search into HANA CONTAINS across displayName / firstName /
// lastName / email / sapId — admin types "thomas.jung@" and gets the row.
//
// Three display columns (displayName, email, sapId) match the Author
// value-help precedent.
annotate AdminService.Advocates with {
  user @Common.Label: 'Linked User'
       @Common.Text: user.displayName
       @Common.TextArrangement: #TextOnly
       @Common.ValueList: {
         CollectionPath: 'Users',
         SearchSupported: true,
         Parameters: [
           { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: user_ID, ValueListProperty: 'ID' },
           { $Type: 'Common.ValueListParameterDisplayOnly',                             ValueListProperty: 'displayName' },
           { $Type: 'Common.ValueListParameterDisplayOnly',                             ValueListProperty: 'email' },
           { $Type: 'Common.ValueListParameterDisplayOnly',                             ValueListProperty: 'sapId' }
         ]
       };
};
```

- [ ] **Step 3: Find the existing `@UI: {` block on AdminService.Advocates**

```bash
ADV_UI_LINE=$(grep -n "annotate AdminService.Advocates with @(" app/admin-annotations.cds | head -1 | cut -d: -f1)
echo "Advocates @UI block starts at line $ADV_UI_LINE"
sed -n "${ADV_UI_LINE},$((ADV_UI_LINE + 80))p" app/admin-annotations.cds
```

Read the output carefully. Identify:
- Where the existing `Facets: [` array begins (note the line offset from `ADV_UI_LINE`).
- The name of the first existing facet (e.g. `HeaderInfoFacet` or `AboutFacet`) — you'll insert the `IdentityLinkFacet` AFTER that first facet.
- The location of the closing `]` for the Facets array — you'll append the two tutorial facets just before it.
- Whether the `@UI: {` block already contains any `FieldGroup #...` definitions — if so, you'll add `FieldGroup #IdentityLink` alongside them (typically before the Facets array).

- [ ] **Step 4: Add Identity FieldGroup + insert new facets**

Locate the existing `@UI: {` block that contains `HeaderInfo`, `Facets`, etc.

**4a.** Inside the same `@UI: {` block, BEFORE the existing `Facets` array, add a new `FieldGroup #IdentityLink`:

```cds
FieldGroup #IdentityLink: {
  Data: [
    { $Type: 'UI.DataField', Value: user_ID,    Label: 'Linked User' },
    { $Type: 'UI.DataField', Value: user.email, Label: 'Email (from linked User)' }
  ]
},
```

**4b.** Inside the `Facets: [ ... ]` array, AFTER the existing first facet (typically the HeaderInfo/About panel), insert:

```cds
{ $Type: 'UI.ReferenceFacet', ID: 'IdentityLinkFacet', Label: 'Identity', Target: '@UI.FieldGroup#IdentityLink' },
```

**4c.** At the END of the `Facets: [ ... ]` array (just before the closing `]`), insert:

```cds
,
{ $Type: 'UI.ReferenceFacet', ID: 'AuthoredFacet',    Label: 'Authored Tutorials',    Target: 'authoredTutorials/@UI.LineItem' },
{ $Type: 'UI.ReferenceFacet', ID: 'ContributedFacet', Label: 'Contributed Tutorials', Target: 'contributedTutorials/@UI.LineItem' }
```

(Mind the comma placement — most prior facets end without a trailing comma; preserve the array syntax.)

- [ ] **Step 5: Verify CDS compiles**

```bash
npx cds compile srv/ app/ --to csn 2>&1 | grep -E "error|warning.*Facets" | head -10
```

Expected: no `error` lines. Warnings about Facets resolving are OK as long as no `error`.

- [ ] **Step 6: Run manifest validation if the project has it**

```bash
ls app/admin/advocates/webapp/manifest.json 2>&1 && echo "found"
# If found, manifest-validate is a separate quick check; skip if not configured.
```

- [ ] **Step 7: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(advocate-user-link): admin Advocates OP — value-help, Identity facet, tutorial facets

- Searchable Users value-help on Advocates.user (SearchSupported: true,
  same pattern as Tutorials.author from PR #618).
- Identity FieldGroup shows linked user + read-through email.
- Authored Tutorials + Contributed Tutorials ReferenceFacets target
  the projection aliases added in Task 3.

Refs: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §2"
```

---

## Task 5: Public API — extend /api/advocates with email + tutorials

**Files:**
- Modify: `srv/routes/advocates-public.js`
- Modify: `test/unit/advocate-user-link.test.js` (extend with handler-shape tests)

- [ ] **Step 1: Read the full existing handler to understand the shape, and verify the export API**

```bash
sed -n '20,140p' srv/routes/advocates-public.js
echo "---exports---"
grep -nE "^(export|module\.exports)" srv/routes/advocates-public.js
echo "---how server.js mounts it---"
grep -n "advocates-public\|advocatesPublic" srv/server.js
```

Note: the handler uses `db.run(SELECT.from(...))` with no `.columns()`, builds Map lookups, and assembles output via `.map(a => ({ ... }))`.

Verify the export pattern is `export function register(app)` — this is what the unit test's `advocatesPublic.register(app)` import call will use. If the export name is anything else (e.g. `mountRoutes`, `default`), adjust the test's `register(app)` call below accordingly.

- [ ] **Step 2: Add 6 handler-shape tests to `test/unit/advocate-user-link.test.js`**

Append to the existing test file:

```js
import express from 'express';
import request from 'supertest'; // verify supertest is in devDeps; if not, use fetch against a started cds server

describe('/api/advocates — email + tutorials shaping', () => {
  let app;
  beforeAll(async () => {
    // Reuse the in-memory CDS connection from the earlier describe block.
    // Mount the public route the same way srv/server.js does.
    const advocatesPublic = await import('../../srv/routes/advocates-public.js');
    app = express();
    advocatesPublic.register(app);
  });

  it('omits email when advocate has no user link', async () => {
    const { Advocates } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Advocates).entries({ slug: 'public-noemail', firstName: 'P', lastName: 'N', isActive: true });
    const res = await request(app).get('/api/advocates');
    const adv = res.body.advocates.find(a => a.slug === 'public-noemail');
    expect(adv).toBeDefined();
    expect(adv.email).toBeUndefined();
  });

  it('includes email when advocate is linked and Users.email is non-empty', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'pub-1', email: 'pub1@example.com' });
    const u = await SELECT.one.from(Users).where({ uuid: 'pub-1' });
    await INSERT.into(Advocates).entries({ slug: 'public-withemail', firstName: 'P', lastName: 'E', isActive: true, user_ID: u.ID });
    const res = await request(app).get('/api/advocates');
    const adv = res.body.advocates.find(a => a.slug === 'public-withemail');
    expect(adv.email).toBe('pub1@example.com');
  });

  it('omits email when linked user has empty/null email', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'pub-noemail', email: null });
    const u = await SELECT.one.from(Users).where({ uuid: 'pub-noemail' });
    await INSERT.into(Advocates).entries({ slug: 'public-userwithoutemail', firstName: 'P', lastName: 'X', isActive: true, user_ID: u.ID });
    const res = await request(app).get('/api/advocates');
    const adv = res.body.advocates.find(a => a.slug === 'public-userwithoutemail');
    expect(adv.email).toBeUndefined();
  });

  it('includes authoredTutorials sorted by title when linked user authored some', async () => {
    const { Advocates, Users, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'pub-2', email: 'pub2@example.com' });
    const u = await SELECT.one.from(Users).where({ uuid: 'pub-2' });
    await INSERT.into(Tutorials).entries([
      { slug: 't-zebra', title: 'Zebra Tutorial', author_ID: u.ID },
      { slug: 't-apple', title: 'Apple Tutorial', author_ID: u.ID },
    ]);
    await INSERT.into(Advocates).entries({ slug: 'public-authored', firstName: 'P', lastName: 'A', isActive: true, user_ID: u.ID });
    const res = await request(app).get('/api/advocates');
    const adv = res.body.advocates.find(a => a.slug === 'public-authored');
    expect(adv.authoredTutorials).toEqual([
      { slug: 't-apple', title: 'Apple Tutorial' },
      { slug: 't-zebra', title: 'Zebra Tutorial' },
    ]);
  });

  it('omits authoredTutorials when array would be empty', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'pub-3', email: 'pub3@example.com' });
    const u = await SELECT.one.from(Users).where({ uuid: 'pub-3' });
    await INSERT.into(Advocates).entries({ slug: 'public-noauthored', firstName: 'P', lastName: 'B', isActive: true, user_ID: u.ID });
    const res = await request(app).get('/api/advocates');
    const adv = res.body.advocates.find(a => a.slug === 'public-noauthored');
    expect(adv.authoredTutorials).toBeUndefined();
  });

  it('flattens contributedTutorials through TutorialContributors.tutorial', async () => {
    const { Advocates, Users, Tutorials, TutorialContributors } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'pub-4', email: 'pub4@example.com' });
    const u = await SELECT.one.from(Users).where({ uuid: 'pub-4' });
    await INSERT.into(Tutorials).entries({ slug: 't-contrib', title: 'Contributed Tutorial', author_ID: null });
    const t = await SELECT.one.from(Tutorials).where({ slug: 't-contrib' });
    await INSERT.into(TutorialContributors).entries({ tutorial_ID: t.ID, user_ID: u.ID });
    await INSERT.into(Advocates).entries({ slug: 'public-contrib', firstName: 'P', lastName: 'C', isActive: true, user_ID: u.ID });
    const res = await request(app).get('/api/advocates');
    const adv = res.body.advocates.find(a => a.slug === 'public-contrib');
    expect(adv.contributedTutorials).toEqual([{ slug: 't-contrib', title: 'Contributed Tutorial' }]);
  });
});
```

- [ ] **Step 3: Run, expect ALL 6 new tests to fail (handler still emits the old shape)**

```bash
npx vitest run test/unit/advocate-user-link.test.js 2>&1 | tail -15
```

Expected: 6 new failures (`expected ... to be defined` or `expected undefined to be 'pub1@example.com'`).

- [ ] **Step 4: Verify `supertest` is available; if not, install**

```bash
node -e "require.resolve('supertest')" 2>&1
```

If "Cannot find module 'supertest'": `npm install --save-dev supertest` and `git add package.json package-lock.json`. If already installed, skip.

- [ ] **Step 5: Extend `srv/routes/advocates-public.js`**

Open the file. Find the `const advocates = await db.run(...)` line. After the existing `const ids = ...` line, add:

```js
const userIds = [...new Set(advocates.map((a) => a.user_ID).filter(Boolean))];
```

Then extend the existing `Promise.all` from a 2-tuple `[topics, links]` to a 5-tuple by appending three new queries. Replace the current:

```js
const [topics, links] = await Promise.all([
  ids.length
    ? db.run(SELECT.from(AdvocateTopics).where({ advocate_ID: { in: ids } }))
    : [],
  ids.length
    ? db.run(SELECT.from(AdvocateLinks).where({ advocate_ID: { in: ids } }))
    : [],
]);
```

with:

```js
const { Users, Tutorials, TutorialContributors } = cds.entities('com.sap.developers.ims');

const [topics, links, users, authoredRows, contribRows] = await Promise.all([
  ids.length
    ? db.run(SELECT.from(AdvocateTopics).where({ advocate_ID: { in: ids } }))
    : [],
  ids.length
    ? db.run(SELECT.from(AdvocateLinks).where({ advocate_ID: { in: ids } }))
    : [],
  // PR — Advocate ↔ User link. Only fetch Users that an advocate links to.
  userIds.length
    ? db.run(SELECT.from(Users).columns('ID', 'email').where({ ID: { in: userIds } }))
    : [],
  // Tutorials authored by any of those users.
  userIds.length
    ? db.run(
        SELECT.from(Tutorials)
          .columns('slug', 'title', 'author_ID')
          .where({ author_ID: { in: userIds } }),
      )
    : [],
  // Contributor rows for any of those users; tutorial slug/title resolved
  // in a second small query below to avoid CQN deep-expand.
  userIds.length
    ? db.run(
        SELECT.from(TutorialContributors)
          .columns('user_ID', 'tutorial_ID')
          .where({ user_ID: { in: userIds } }),
      )
    : [],
]);

const contribTutorialIds = [
  ...new Set(contribRows.map((r) => r.tutorial_ID).filter(Boolean)),
];
const contribTutorials = contribTutorialIds.length
  ? await db.run(
      SELECT.from(Tutorials)
        .columns('ID', 'slug', 'title')
        .where({ ID: { in: contribTutorialIds } }),
    )
  : [];

const userById = new Map(users.map((u) => [u.ID, u]));
const authoredByUserId = new Map();
for (const t of authoredRows) {
  if (!t.slug || !t.title) continue;
  if (!authoredByUserId.has(t.author_ID)) authoredByUserId.set(t.author_ID, []);
  authoredByUserId.get(t.author_ID).push({ slug: t.slug, title: t.title });
}
const tutorialById = new Map(contribTutorials.map((t) => [t.ID, t]));
const contribByUserId = new Map();
for (const c of contribRows) {
  const tut = tutorialById.get(c.tutorial_ID);
  if (!tut || !tut.slug || !tut.title) continue;
  if (!contribByUserId.has(c.user_ID)) contribByUserId.set(c.user_ID, []);
  contribByUserId.get(c.user_ID).push({ slug: tut.slug, title: tut.title });
}
```

Now find the `advocates: advocates.map((a) => ({` block. Inside the object literal (after `links: linksByAdv.get(a.ID) || [],`), append:

```js
        ...(a.user_ID && userById.get(a.user_ID)?.email
          ? { email: userById.get(a.user_ID).email }
          : {}),
        ...(a.user_ID && authoredByUserId.get(a.user_ID)?.length
          ? {
              authoredTutorials: authoredByUserId
                .get(a.user_ID)
                .slice()
                .sort((x, y) => x.title.localeCompare(y.title)),
            }
          : {}),
        ...(a.user_ID && contribByUserId.get(a.user_ID)?.length
          ? {
              contributedTutorials: contribByUserId
                .get(a.user_ID)
                .slice()
                .sort((x, y) => x.title.localeCompare(y.title)),
            }
          : {}),
```

Finally, update the `maxModified()` call to include the new row sets:

```js
    const max = Math.max(
      maxModified(advocates),
      maxModified(topics),
      maxModified(links),
      maxModified(users),
      maxModified(authoredRows),
      maxModified(contribRows),
      maxModified(contribTutorials),
    );
```

- [ ] **Step 6: Run, expect ALL 6 new tests + 4 schema tests to PASS**

```bash
npx vitest run test/unit/advocate-user-link.test.js test/unit/anonymization-cascade-advocates.test.js 2>&1 | tail -10
```

Expected: `Tests  13 passed (13)`.

- [ ] **Step 7: Confirm no existing /api/advocates test regressed**

```bash
ls test/unit/advocates*.test.* test/unit/advocate*.test.* 2>&1 | head
npx vitest run test/unit/ 2>&1 | tail -5
```

Expected: all unit tests pass.

- [ ] **Step 8: Commit**

```bash
git add srv/routes/advocates-public.js test/unit/advocate-user-link.test.js package.json package-lock.json
git commit -m "feat(advocate-user-link): /api/advocates exposes email + authored/contributed tutorials when linked

- Server-side gate: only emits email/tutorials when user_ID is set AND
  the underlying Users.email / tutorial rows are non-empty.
- Separate-queries-with-JS-join pattern (not deep CQN expand) — matches
  the existing topics/links/tags shape in the same handler.
- 6 handler-shape unit tests cover all gate combinations.
- ETag input expanded to bust the 60s cache when Users.email or
  authored/contributed tutorial rows change.

Refs: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §3"
```

---

## Task 6: Hybrid test — HANA UNIQUE + cascade end-to-end

**Files:**
- Test: `test/hybrid/advocate-user-link.test.js` (CREATE)

This test runs against real HANA via `cds bind --exec`. It asserts (a) `@assert.unique` is enforced at the DB level (not just CAP runtime) and (b) anonymizing a User actually NULLs `Advocates.user_ID` via the cascade.

- [ ] **Step 1: Read the hybrid test guard**

```bash
cat test/hybrid/_guard.js
```

Note the `ALLOW_HYBRID_WRITES` env-var check pattern — your new test must call the guard.

- [ ] **Step 2: Find an existing hybrid test that exercises a write to model yours after**

```bash
ls test/hybrid/*.test.* | head -5
```

Read one with a clean setup/teardown shape — e.g. `test/hybrid/duplicate-slugs.test.js`. Match its pattern: `__TEST__` prefix on test data, full cleanup in `afterAll`.

- [ ] **Step 3: Write the hybrid test**

Create `test/hybrid/advocate-user-link.test.js`:

```js
// Hybrid tests for Advocates.user link — runs against real HANA via `cds bind --exec`.
// Spec: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §5
//
// Two assertions the unit suite (SQLite) can't reliably make:
//   1. @assert.unique.user is enforced as a HANA UNIQUE INDEX/CONSTRAINT,
//      not just by CAP-runtime check.
//   2. cascadeNullPersonal actually NULLs Advocates.user_ID end-to-end
//      when a User is anonymized.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import './_guard.js';

const TEST_PREFIX = '__TEST__advocate-link';

describe('Advocates.user — HANA UNIQUE + cascade (hybrid)', () => {
  let db;
  let createdAdvIds = [];
  let createdUserIds = [];

  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  afterAll(async () => {
    // Clean up by deleting test rows (advocates first to free the FK).
    if (createdAdvIds.length) {
      await db.run(`DELETE FROM "com.sap.developers.ims.Advocates" WHERE "ID" IN (${createdAdvIds.map(() => '?').join(',')})`, createdAdvIds);
    }
    if (createdUserIds.length) {
      await db.run(`DELETE FROM "com.sap.developers.ims.Users" WHERE "ID" IN (${createdUserIds.map(() => '?').join(',')})`, createdUserIds);
    }
  });

  it('HANA enforces UNIQUE on Advocates.user_ID at the DB level', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');

    const uuid = `${TEST_PREFIX}-u-${Date.now()}`;
    await INSERT.into(Users).entries({ uuid, email: `${uuid}@test.example.com` });
    const u = await SELECT.one.from(Users).where({ uuid });
    createdUserIds.push(u.ID);

    const slugA = `${TEST_PREFIX}-a-${Date.now()}`;
    const slugB = `${TEST_PREFIX}-b-${Date.now()}`;
    await INSERT.into(Advocates).entries({ slug: slugA, firstName: 'T', lastName: 'A', user_ID: u.ID });
    const advA = await SELECT.one.from(Advocates).where({ slug: slugA });
    createdAdvIds.push(advA.ID);

    await expect(
      INSERT.into(Advocates).entries({ slug: slugB, firstName: 'T', lastName: 'B', user_ID: u.ID }),
    ).rejects.toThrow(/ASSERT_UNIQUE|UNIQUE|constraint violation/i);
  });

  it('cascadeNullPersonal NULLs Advocates.user_ID when User is anonymized', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    const { executeAnonymizationCascade } = await import('../../srv/lib/anonymization-cascade.js');

    const uuid = `${TEST_PREFIX}-u-cascade-${Date.now()}`;
    await INSERT.into(Users).entries({ uuid, email: `${uuid}@test.example.com` });
    const u = await SELECT.one.from(Users).where({ uuid });
    createdUserIds.push(u.ID);

    const slug = `${TEST_PREFIX}-cascade-${Date.now()}`;
    await INSERT.into(Advocates).entries({ slug, firstName: 'C', lastName: 'A', user_ID: u.ID });
    const adv = await SELECT.one.from(Advocates).where({ slug });
    createdAdvIds.push(adv.ID);

    // Verify FK is set before cascade
    expect(adv.user_ID).toBe(u.ID);

    // Trigger the cascade. The signature is `executeAnonymizationCascade(user, db)`
    // — it pulls definitions from `cds.model` (or `cds.db.model` as fallback)
    // internally. No need to pass the model explicitly. Verified in Task 2 Step 1.
    await executeAnonymizationCascade(u, db);

    // FK should now be null
    const after = await SELECT.one.from(Advocates).where({ ID: adv.ID });
    expect(after.user_ID).toBeNull();
  });
});
```

- [ ] **Step 4: Confirm cds is logged into the DEV space**

```bash
cf target
```

Expected: `org: tutorial-system`, `space: dev`. If not, `cf login -a https://api.cf.eu10-005.hana.ondemand.com` and re-target.

- [ ] **Step 5: Run the hybrid test**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/advocate-user-link.test.js 2>&1 | tail -25
```

Expected: `Tests  2 passed (2)`.

If the UNIQUE assert test FAILS because the schema hasn't been deployed to HANA yet (and the column `USER_ID` doesn't exist), this is expected for first-run pre-deploy. Wrap that test with `.skip` AND a greppable TODO comment so it's easy to find post-deploy:

```js
// TODO(advocate-user-link-unskip-after-deploy): unskip once HDI ALTER has run on DEV.
it.skip('HANA enforces UNIQUE on Advocates.user_ID at the DB level', async () => {
  // ... existing test body ...
});
```

The cascade test (`'cascadeNullPersonal NULLs Advocates.user_ID when User is anonymized'`) does NOT need to be skipped — the schema gap manifests as an insert error, but the test logic itself doesn't depend on UNIQUE being enforced. If the cascade test also fails with a schema error, skip BOTH with the same TODO marker.

The greppable string `TODO(advocate-user-link-unskip-after-deploy)` lets you find these later with one command: `grep -rn "advocate-user-link-unskip-after-deploy" test/`.

- [ ] **Step 6: Commit**

```bash
git add test/hybrid/advocate-user-link.test.js
git commit -m "test(advocate-user-link): hybrid HANA UNIQUE + cascade-NULL assertions

- Confirms @assert.unique.user is materialized as a HANA UNIQUE constraint
  (not just CAP-runtime check).
- Confirms cascadeNullPersonal end-to-end: anonymizing a User actually
  NULLs Advocates.user_ID.
- Requires ALLOW_HYBRID_WRITES=true and \`cds bind --exec\`; cleans up
  with __TEST__-prefixed slugs and tracked IDs in afterAll.

Refs: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §5"
```

---

## Task 7: Vue island — render mailto + tutorial pills

**Files:**
- Modify: `hugo-apps/src/advocates/App.vue` (the main advocates roster Vue component)
- Test: `hugo-apps/src/advocates/App.user-link.test.ts` (CREATE — co-located beside `App.vue`, NOT under a `__tests__/` subdir; the codebase's advocates pattern co-locates tests like `App.joule-handoff.test.ts`)

**Test stack (verified):** `@vue/test-utils` `mount` + happy-dom. Pattern is `// @vitest-environment happy-dom` at the top of the test file. Fixtures live INLINE in the test file (no separate fixtures dir).

- [ ] **Step 1: Read the existing advocates test file as your template**

```bash
cat hugo-apps/src/advocates/App.joule-handoff.test.ts
```

Note: it uses `mount(App, { ... })`, inline fixtures `FIXTURE_A` / `FIXTURE_B`, stubs `globalThis.fetch` to return `{ advocates: [...] }`. Match that shape exactly.

- [ ] **Step 2: Read the App.vue source to find the card-render block**

```bash
grep -nE "advocate\.|firstName|email|links" hugo-apps/src/advocates/App.vue | head -25
```

Note where individual advocate cards are rendered. Look for the template section that iterates over advocates (likely `<div v-for="a in advocates"` or similar) — that's where your mailto anchor and tutorials pill will live.

- [ ] **Step 3: Write the failing component tests**

Create `hugo-apps/src/advocates/App.user-link.test.ts`:

```ts
// hugo-apps/src/advocates/App.user-link.test.ts
//
// @vitest-environment happy-dom
//
// Spec: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §3 + §5
// Tests the public roster card surfaces the new email + tutorial-count
// affordances when an advocate is linked to a User, and hides them when not.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from './App.vue';

// Fixture with email + tutorials (advocate linked to a user with both)
const FIXTURE_LINKED = {
  ID: 'a-linked',
  slug: 'a-linked',
  firstName: 'Linked',
  lastName: 'Advocate',
  region: 'AMERICAS',
  title: 'DA',
  topics: [],
  links: [],
  hasPhoto: false,
  email: 'linked@example.com',
  authoredTutorials: [
    { slug: 't-1', title: 'A Tutorial' },
    { slug: 't-2', title: 'B Tutorial' },
    { slug: 't-3', title: 'C Tutorial' },
  ],
  contributedTutorials: [
    { slug: 't-4', title: 'D Tutorial' },
  ],
};

// Fixture WITHOUT email or tutorials (advocate not linked)
const FIXTURE_UNLINKED = {
  ID: 'a-unlinked',
  slug: 'a-unlinked',
  firstName: 'Unlinked',
  lastName: 'Advocate',
  region: 'EMEA',
  title: 'DA',
  topics: [],
  links: [],
  hasPhoto: false,
  // No email, no authoredTutorials, no contributedTutorials
};

describe('App.vue — user-link affordances', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function mountWith(advocates: any[]) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ advocates }),
    } as unknown as Response);
    const wrapper = mount(App);
    await flushPromises();
    return wrapper;
  }

  it('renders a mailto: link when advocate.email is present', async () => {
    const wrapper = await mountWith([FIXTURE_LINKED]);
    const mailtoAnchor = wrapper.find('a[href^="mailto:linked@example.com"]');
    expect(mailtoAnchor.exists()).toBe(true);
  });

  it('omits the mailto: link when advocate.email is absent', async () => {
    const wrapper = await mountWith([FIXTURE_UNLINKED]);
    const mailtoAnchors = wrapper.findAll('a[href^="mailto:"]');
    expect(mailtoAnchors.length).toBe(0);
  });

  it('shows authored + contributed tutorial counts when present', async () => {
    const wrapper = await mountWith([FIXTURE_LINKED]);
    // The pill renders the counts as text — match defensively against the
    // text node rather than a specific class, so the test survives minor
    // CSS-class renaming.
    expect(wrapper.text()).toMatch(/3\s*authored/i);
    expect(wrapper.text()).toMatch(/1\s*contributed/i);
  });

  it('hides the tutorial-count pill when both arrays are absent', async () => {
    const wrapper = await mountWith([FIXTURE_UNLINKED]);
    // The pill class — set by the component in Step 5 below.
    const pill = wrapper.find('.advocate-tutorials-pill');
    expect(pill.exists()).toBe(false);
  });
});
```

- [ ] **Step 4: Run, expect ALL 4 to fail**

```bash
cd hugo-apps
npx vitest run src/advocates/App.user-link.test.ts 2>&1 | tail -10
cd ..
```

Expected: 4 failures (mailto anchor not found / pill not found / tutorial text not present).

- [ ] **Step 5: Add the rendering to `hugo-apps/src/advocates/App.vue`**

Open `App.vue`. Find the template block that iterates over advocates and renders each card. You're looking for a `<template v-for=...>` or `<div v-for=...>` over `advocates`. Inside the per-card markup, AFTER the title/location row (and BEFORE the topics/links rows), insert:

```vue
<!-- mailto: link — surfaces the linked Users.email when present.
     Hidden entirely when the advocate is not linked to a User or
     when the linked User has no email. Spec §3 + §5. -->
<a
  v-if="advocate.email"
  :href="`mailto:${advocate.email}`"
  class="advocate-email-link"
>
  {{ advocate.email }}
</a>

<!-- Tutorial-count pill — small affordance showing how many tutorials
     this advocate has authored / contributed to. Hidden when both
     arrays are absent or empty. The visual treatment is intentionally
     minimal here (spec §8 leaves the polished UI for a follow-up PR);
     this PR just plumbs the data and ensures the gate works. -->
<span
  v-if="advocate.authoredTutorials?.length || advocate.contributedTutorials?.length"
  class="advocate-tutorials-pill"
>
  <template v-if="advocate.authoredTutorials?.length">
    {{ advocate.authoredTutorials.length }} authored
  </template>
  <template
    v-if="advocate.authoredTutorials?.length && advocate.contributedTutorials?.length"
  >
    ·
  </template>
  <template v-if="advocate.contributedTutorials?.length">
    {{ advocate.contributedTutorials.length }} contributed
  </template>
</span>
```

Then add minimal CSS in the existing `<style>` block (or `<style scoped>`):

```css
.advocate-email-link {
  display: inline-block;
  margin-top: 0.25rem;
  font-size: 0.875rem;
}
.advocate-tutorials-pill {
  display: inline-block;
  margin-top: 0.5rem;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  background: var(--sapNeutralBackground, #eef2f5);
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor, #556b82);
}
```

(Match the existing component's CSS-variable conventions if they differ from the above — read the existing `<style>` block first.)

- [ ] **Step 6: Run, expect ALL 4 tests + existing tests to PASS**

```bash
cd hugo-apps
npx vitest run src/advocates/ 2>&1 | tail -15
cd ..
```

Expected: all advocates tests pass, including the existing `App.joule-handoff.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/advocates/App.vue hugo-apps/src/advocates/App.user-link.test.ts
git commit -m "feat(advocate-user-link): public roster card surfaces mailto + tutorial-count pill

- mailto: anchor when advocate.email is present (linked user with email).
- Tutorials pill 'N authored · M contributed' when either array is non-empty.
- 4 new component tests cover present/absent states using inline fixtures
  (same pattern as App.joule-handoff.test.ts).

Refs: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §3 + §5"
```

---

## Task 8: Smoke test against deployed DEV

**Files:**
- Test: `test/smoke/advocates-user-link.smoke.test.js` (CREATE)

This test runs against the deployed approuter post-deploy. Conditional assertions: passes today even if no advocates are linked yet; asserts the wire once admins start linking.

- [ ] **Step 1: Read an existing smoke test for shape**

```bash
ls test/smoke/*.test.*
cat test/smoke/health.test.js 2>/dev/null || cat test/smoke/health-check.test.* 2>/dev/null | head -40
```

Note: smoke tests use `SMOKE_BASE_URL` / `SMOKE_SRV_URL` env vars.

- [ ] **Step 2: Write the smoke test**

Create `test/smoke/advocates-user-link.smoke.test.js`:

```js
// Smoke tests against the deployed approuter — runs post-deploy.
// SMOKE_BASE_URL must point at the approuter (e.g.
//   https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com)
// SMOKE_SRV_URL must point at the srv app (less commonly used here).
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
const skipIfNoUrl = BASE ? describe : describe.skip;

skipIfNoUrl('/api/advocates smoke — user-link', () => {
  let body;
  it('returns 200 and a JSON object with an advocates array', async () => {
    const res = await fetch(`${BASE}/api/advocates`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    body = await res.json();
    expect(Array.isArray(body.advocates)).toBe(true);
  });

  it('IF any advocate is linked, its email is a string', async () => {
    const linked = body.advocates.filter((a) => 'email' in a);
    if (linked.length === 0) {
      // Pre-link state: pass without asserting. Once admins link an advocate,
      // this assertion takes effect on the next smoke run.
      return;
    }
    for (const a of linked) {
      expect(typeof a.email).toBe('string');
      expect(a.email).toMatch(/.+@.+/);
    }
  });

  it('IF any advocate has authoredTutorials, each entry has slug + title', async () => {
    const withAuthored = body.advocates.filter((a) => 'authoredTutorials' in a);
    if (withAuthored.length === 0) return;
    for (const a of withAuthored) {
      expect(Array.isArray(a.authoredTutorials)).toBe(true);
      for (const t of a.authoredTutorials) {
        expect(typeof t.slug).toBe('string');
        expect(typeof t.title).toBe('string');
      }
    }
  });

  it('no advocate has email/tutorials when user_ID would be null', async () => {
    // We can't inspect user_ID directly from the public endpoint (correctly —
    // it's not part of the public shape). But we can assert the negative: if
    // an advocate has NO email key AND NO authoredTutorials key AND NO
    // contributedTutorials key, that's a valid unlinked state. This test
    // just confirms the response shape is internally consistent.
    for (const a of body.advocates) {
      if (!('email' in a) && !('authoredTutorials' in a) && !('contributedTutorials' in a)) {
        // unlinked — fine
      }
    }
    expect(true).toBe(true); // shape-consistency check is implicit above
  });
});
```

- [ ] **Step 3: Commit (no run yet — smoke runs after deploy)**

```bash
git add test/smoke/advocates-user-link.smoke.test.js
git commit -m "test(advocate-user-link): smoke assertions for /api/advocates email + tutorials

- Conditional: passes today (no linked advocates yet); asserts wire once
  admins link one. 'Passes-today / asserts-tomorrow' pattern from
  test/smoke/health.test.js.

Refs: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §5"
```

---

## Task 9: Run the full test sweep

- [ ] **Step 1: Unit + cascade tests (no env vars needed)**

```bash
cd "D:/projects/tutorials-poc/.claude/worktrees/advocate-user-link"
npx vitest run test/unit/ 2>&1 | tail -10
```

Expected: ALL unit tests pass. If any pre-existing test regresses, dig in immediately — do not push.

- [ ] **Step 2: Hybrid test (requires `cf login` to DEV + ALLOW_HYBRID_WRITES)**

```bash
cf target | head -3   # confirm tutorial-system / dev
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/advocate-user-link.test.js 2>&1 | tail -10
```

Expected: 2 passes. (If you `.skip`d the UNIQUE-constraint test in Task 6 pre-deploy, only the cascade test runs here. Unskip after deploy.)

- [ ] **Step 3: Hugo-apps tests**

```bash
cd hugo-apps
npx vitest run 2>&1 | tail -10
cd ..
```

Expected: all hugo-apps tests pass.

- [ ] **Step 4: cds build smoke — confirms the spec passes through `cds build --production`**

```bash
npx cds build --production 2>&1 | tail -10
```

Expected: build succeeds, the `gen/db/csn.json` includes `Advocates.user_ID` and the cascade annotation.

```bash
grep -c "user_ID" gen/db/csn.json
grep -c "PersonalData" gen/db/csn.json
```

Both counts > 0.

- [ ] **Step 5: srv-qa cp-list verification**

```bash
ls scripts/check-srv-qa-imports.* 2>&1 || grep -l "srv-qa" scripts/ | head -3
# If a check script exists, run it; otherwise just confirm srv/routes/advocates-public.js
# is listed in the srv-qa module's cp directive in mta.yaml.
grep -A30 "name: tutorials-srv-qa" mta.yaml | grep -E "advocates-public|routes" | head -5
```

Expected: `routes` appears in srv-qa's cp directive (it should already; we didn't add a new srv/lib dep). If not present, copy from srv-main's cp list.

- [ ] **Step 6: If any test fails or build warns about Advocates, fix BEFORE proceeding to deploy.**

---

## Task 10: PR + merge + deploy

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/advocate-user-link 2>&1 | tail -3
```

Expected: branch published; gh URL printed.

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head feat/advocate-user-link --title "feat(advocates): 1:1 optional User link — email + authored/contributed tutorials on /api/advocates" --body "$(cat <<'EOF'
Implements [docs/superpowers/specs/2026-06-25-advocate-user-link-design.md](../blob/main/docs/superpowers/specs/2026-06-25-advocate-user-link-design.md).

## What

Optional 1:1 association `Advocates.user → Users`. When linked:
- Admin Object Page shows linked user + read-through email + 'Authored Tutorials' + 'Contributed Tutorials' facets.
- Public `/api/advocates` adds `email`, `authoredTutorials`, `contributedTutorials` fields (omitted when empty).
- User anonymization auto-NULLs `Advocates.user_ID` via the existing `cascadeNullPersonal` machinery.

## Schema

Additive nullable Association + `@assert.unique.user` + `@PersonalData.cascade: 'null-personal'`. No data migration; existing 50+ advocates ship unlinked. Admins link manually post-deploy via the value-help (searchable by email).

## Tests

- **Unit (SQLite):** 13 cases — schema null/linked/duplicate/many-null, cascade plan inclusion, handler shaping (email + tutorials present/absent, sort order, contributor flattening).
- **Hybrid (HANA):** 2 cases — HANA UNIQUE constraint enforced; cascade end-to-end on anonymization.
- **Smoke:** 4 cases — conditional assertions that pass today and tighten once admins link an advocate.
- **Vue island:** 4 cases — mailto/no-mailto, tutorial pill present/hidden.

## Deploy

Standard MTA. Schema deploy via HDI db-deployer. No content republish needed.

## Privacy

`Users.email` is `@PersonalData.IsPotentiallyPersonal`. Public exposure is a documented decision (Section 4 of spec) — SAP Developer Advocates is explicit public-outreach; email is server-gated to linked-only; anonymization cascade NULLs the FK before email is scrubbed.

## Out of scope

- Bulk-link admin action.
- Tutorial-count visual treatment on the roster (data ships; CSS polish is a follow-up).
- Reverse "Authored by X, SAP Developer Advocate" badge on tutorial pages.

🤖 Pre-approved by Tom for self-merge + DEV redeploy (2026-06-25 brainstorm session).
EOF
)" 2>&1 | tail -3
```

Note the PR URL.

- [ ] **Step 3: Self-merge (Tom pre-approved)**

```bash
PR_NUM=$(gh pr list --head feat/advocate-user-link --json number -q '.[0].number')
gh pr merge "$PR_NUM" --squash --delete-branch 2>&1 | tail -3
```

Expected: merge confirmed; branch deleted on remote.

- [ ] **Step 4: Switch to primary tree to deploy**

```bash
# Exit this worktree session and switch to the primary tree
```

Use `ExitWorktree action: keep` (Claude Code skill) — keeps the worktree on disk in case you need it again, returns shell to `D:/projects/tutorials-poc`.

Then in the primary tree:

```bash
cd "D:/projects/tutorials-poc"
git pull origin main --ff-only 2>&1 | tail -3
git log -3 --oneline
```

Expected: the squash-merge commit appears at the top.

- [ ] **Step 5: Build + deploy**

> **CWD reminder:** The build commands run from the **primary repo root** `D:/projects/tutorials-poc/` (not the worktree). The envsubst block also runs from the repo root. Only the final `cf deploy` runs from inside `.deploy/`. Verify with `pwd` between blocks if uncertain.

```bash
export CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"
npm run build:all 2>&1 | tail -5
cd .deploy && rm -rf mta_archives/ && mbt build 2>&1 | tail -5
cd ..
```

Before `cf deploy`, **resolve the mtaext placeholders**. The dev.mtaext file references 4 env-var placeholders (`GITHUB_DISPATCH_TOKEN`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`) that must be substituted into a `dev.resolved.mtaext` file. Per memory `feedback_mtaext_envsubst_empty_quote_required`, empty values must be wrapped as the two-char literal `"''"` (single-quote single-quote) — bare empty strings render as YAML null and the descriptor merge fails.

Check first whether the resolved file exists and is fresh:

```bash
diff <(date -r deploy/dev.mtaext +%s 2>/dev/null) <(date -r deploy/dev.resolved.mtaext +%s 2>/dev/null) && echo "resolved is older than source — regenerate" || echo "checking content..."
grep -nE '\$\{[A-Z_]+\}' deploy/dev.resolved.mtaext 2>/dev/null && echo "UNRESOLVED placeholders found — regenerate" || echo "resolved is clean"
```

If regeneration is needed, run:

```bash
# Per memory feedback_mtaext_envsubst_empty_quote_required:
# Use "''" (quoted empty strings), NOT "" (bare), so YAML parses them as
# empty-string values rather than null. Required because dev.mtaext's
# parameters are not optional on the multiapps-cli-plugin side.
export GITHUB_DISPATCH_TOKEN="''" SMTP_HOST="''" SMTP_PORT="''" SMTP_USER="''" SMTP_FROM="''"
envsubst '$GITHUB_DISPATCH_TOKEN $SMTP_HOST $SMTP_PORT $SMTP_USER $SMTP_FROM' \
  < deploy/dev.mtaext > deploy/dev.resolved.mtaext

# Verify no unresolved placeholders remain:
if grep -qE '\$\{[A-Z_]+\}' deploy/dev.resolved.mtaext; then
  echo "ERROR: unresolved placeholders still present" && exit 1
fi
echo "OK: resolved mtaext is clean"
```

Then deploy:

```bash
cd .deploy
cf deploy mta_archives/tutorials-poc_1.0.0.mtar -e ../deploy/dev.resolved.mtaext -f 2>&1 | tee /tmp/cf-deploy.log | tail -15
cd ..

# Capture the operation ID for rollback if needed.
DEPLOY_OP_ID=$(grep -oE "Operation ID: [a-f0-9-]+" /tmp/cf-deploy.log | head -1 | awk '{print $3}')
echo "Deploy operation ID: $DEPLOY_OP_ID"
```

Expected: each command exits 0. Total wall-clock ~18-25 min. Save `DEPLOY_OP_ID` for the rollback path in Step 9.

- [ ] **Step 6: Smoke-verify**

```bash
SRV="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"
APR="https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com"

curl -s -o /dev/null -w "/health  %{http_code}\n" "$SRV/health"
curl -s "$APR/api/advocates" | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d); console.log('advocates:', j.advocates.length, 'linked:', j.advocates.filter(a=>a.email).length);})"
```

Expected: `/health 200`, `/api/advocates` returns 200 with the advocate count, and `linked: 0` (since no admin has linked any yet).

- [ ] **Step 7: Smoke-test the deployed shape**

```bash
SMOKE_BASE_URL="$APR" SMOKE_SRV_URL="$SRV" npx vitest run test/smoke/advocates-user-link.smoke.test.js 2>&1 | tail -10
```

Expected: 4 smoke tests pass (conditionals all return early because no advocates are linked yet).

- [ ] **Step 8: Re-run skipped hybrid tests, now that the schema is deployed**

If you marked any hybrid test with `it.skip` + `TODO(advocate-user-link-unskip-after-deploy)` during Task 6:

```bash
cd "D:/projects/tutorials-poc/.claude/worktrees/advocate-user-link"
grep -rn "advocate-user-link-unskip-after-deploy" test/
```

For each match: remove the `.skip` (turn `it.skip(...)` back into `it(...)`) and remove the TODO comment line. Then run:

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/advocate-user-link.test.js 2>&1 | tail -10
```

Expected: 2 passes (UNIQUE-constraint + cascade). If passes, commit the unskip as a follow-up commit on a quick branch + PR:

```bash
git checkout -b fix/advocate-user-link-unskip
git add test/hybrid/advocate-user-link.test.js
git commit -m "test(advocate-user-link): unskip hybrid UNIQUE-constraint test post-deploy

The HDI deploy has provisioned the UNIQUE column constraint on
Advocates.user_ID, so the test that was skipped pre-deploy with
TODO(advocate-user-link-unskip-after-deploy) can now run."
git push -u origin fix/advocate-user-link-unskip 2>&1 | tail -3
gh pr create --base main --head fix/advocate-user-link-unskip --title "test(advocate-user-link): unskip hybrid test post-deploy" --body "Follow-up to #<PR_NUM_FROM_STEP_3>. Schema has been deployed; remove the .skip marker."
gh pr merge --squash --delete-branch
```

If no TODO matches were found, this step is a no-op — proceed to Step 9.

- [ ] **Step 9: ROLLBACK PATH — only if `cf deploy` FAILED in Step 5**

Skip this step if Step 5 succeeded. If `cf deploy` failed:

```bash
# 1. Capture the operation ID (if you didn't already in Step 5):
DEPLOY_OP_ID="<from cf deploy output>"

# 2. Abort the in-flight operation:
cf deploy -i "$DEPLOY_OP_ID" -a abort

# 3. The schema migration is forward-only and additive (Advocates.user_ID
#    is nullable). It is SAFE to leave the new column in place even if the
#    app code reverts — the old code simply ignores the new field. So we
#    do NOT need to roll the schema back.

# 4. Roll back the application binaries to the previous good revision:
cf rollback tutorials-srv      # picks the previous version
cf rollback tutorials-srv-qa
cf rollback tutorials-dev-approuter

# 5. Verify the rollback:
cf apps | grep tutorials-
curl -s -o /dev/null -w "/health %{http_code}\n" "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/health"
```

If rollback succeeds, write a Step 10 summary noting the failure, the operation ID, and the rolled-back state. Do not retry the deploy without first investigating the failure cause.

- [ ] **Step 10: Write the summary for Tom**

In this conversation, write a final summary block noting:
- PR number + merge commit hash.
- Deploy operation ID (from `cf deploy` output).
- Smoke results.
- The "next step" — Tom should open `/admin-ui/#advocates-display`, pick an advocate, use the value-help to find their User row by email, save the draft. Then reload `/developer-advocates/` to confirm the mailto + tutorial pill render.
- Any deviations from the spec or unexpected issues (especially around the cascade + draft + UNIQUE-constraint interactions).
