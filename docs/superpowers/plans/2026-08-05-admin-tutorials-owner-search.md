# Admin Tutorials Owner Search & Filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Admin UI Tutorials List Report find tutorials by owner/author — both via the toolbar search box and via a wildcard-capable Owner column filter.

**Architecture:** Flatten the free-text `meta.owner` (already a to-one association in the AdminService projection) into a scalar `owner` column, exactly like the existing `author.email as authorEmail` pattern. Add `owner` + the four flattened author name/email columns to `@cds.search` so `$search` (→ HANA `CONTAINS`) matches them. Re-point the Owner SelectionField / LineItem / FieldGroup and its value-list from the association path `meta.owner` to the scalar `owner`, which gives Fiori Elements a stock string filter with contains + `*` wildcard.

**Tech Stack:** SAP CAP (CDS annotations), Fiori Elements List Report (`sap.fe.templates.ListReport`), vitest unit tests with `cds.test('serve', ...)`, HANA Cloud (prod) / in-memory SQLite (unit).

## Global Constraints

- Owner is free-text `TutorialMeta.owner : String(255)`; reached from `Tutorials` via the `meta` association, redefined to-one in the AdminService projection (`srv/admin-service.cds:45`).
- Do NOT add a custom `valueHelpRequest` handler — FE's stock string filter provides contains + wildcard once the filter field is a scalar (avoids the #1371 dead-code trap).
- Keep the Owner value-list a **plain** `@Common.ValueList` (NOT `@Common.ValueListWithFixedValues`) so free-text `*` wildcard entry stays available alongside the dropdown.
- Flattened derived columns are `@Common.FieldControl: #ReadOnly`; writes silently no-op (same semantics as the author flatten).
- Unit test bootstrap MUST be `cds.test('serve', '--project', '.', '--in-memory')` — `cds.deploy(cds.model)` is broken in this repo.
- Reuse the existing `TutorialOwnerPickList` (`srv/admin-service.cds:98`) unchanged.
- Run `npx cds compile srv --to json >/dev/null` (model must compile) before committing any `.cds` change.
- Bump `app/admin/tutorials/webapp/manifest.json` `sap.app.applicationVersion` `0.0.2 → 0.0.3` so the FE `ui5-cachemanager-db` IndexedDB metadata cache doesn't serve stale SelectionFields.

---

### Task 1: Flatten `owner` scalar + widen `@cds.search` (server model)

**Files:**
- Modify: `srv/admin-service.cds:41` (the `@cds.search` line) and `srv/admin-service.cds:67-71` (add `owner` alongside the flattened author columns)
- Test: `test/unit/admin-tutorials-owner-search.test.js` (create)

**Interfaces:**
- Produces: `AdminService.Tutorials.owner : String` — read-only scalar derived from `meta.owner`. Later tasks (annotations) bind SelectionField/LineItem/value-list to this element name `owner`.
- Produces: `@cds.search` on `AdminService.Tutorials` now includes `owner, authorDisplayName, authorEmail, authorFirstName, authorLastName` in addition to `title, slug, primaryTag, description`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/admin-tutorials-owner-search.test.js`:

```js
// test/unit/admin-tutorials-owner-search.test.js
//
// Spec: docs/superpowers/specs/2026-08-05-admin-tutorials-owner-search-filter-design.md
// Verifies the AdminService.Tutorials projection exposes a scalar `owner`
// column flattened from meta.owner, and that $search matches owner text.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const ADMIN = { id: 'admin@test', roles: ['Admin'] };

describe('AdminService.Tutorials owner search', () => {
  let Tutorials, TutorialMeta;

  beforeAll(async () => {
    ({ Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(TutorialMeta);
    await DELETE.from(Tutorials);
  });

  it('exposes a scalar owner column flattened from meta.owner', async () => {
    const tut = { ID: cds.utils.uuid(), slug: 'hana-basics', title: 'HANA Basics', legacyId: 9001 };
    await INSERT.into(Tutorials).entries(tut);
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(), tutorial_ID: tut.ID, owner: 'Jane Developer'
    });

    const rows = await cds.tx({ user: new cds.User(ADMIN) }, tx =>
      tx.run(SELECT.from('AdminService.Tutorials').columns('slug', 'owner').where({ slug: 'hana-basics' }))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBe('Jane Developer');
  });

  it('$search matches owner text', async () => {
    const tut = { ID: cds.utils.uuid(), slug: 'abap-cloud', title: 'ABAP Cloud', legacyId: 9002 };
    await INSERT.into(Tutorials).entries(tut);
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(), tutorial_ID: tut.ID, owner: 'Rui Nogueira'
    });

    const rows = await cds.tx({ user: new cds.User(ADMIN) }, tx =>
      tx.run(SELECT.from('AdminService.Tutorials').columns('slug', 'owner').search('Nogueira'))
    );
    expect(rows.map(r => r.slug)).toContain('abap-cloud');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/admin-tutorials-owner-search.test.js`
Expected: FAIL — `owner` column not found on `AdminService.Tutorials` (and/or `$search` returns no rows).

- [ ] **Step 3: Add the flattened `owner` column**

In `srv/admin-service.cds`, immediately after the `author.lastName as authorLastName ...` line (currently line 71), add:

```cds
    // Flattened free-text owner from the (to-one, in this projection) meta
    // association — same derived/read-only pattern as the author.* columns
    // above. Makes owner a scalar so it is $search-able and filterable with
    // contains/wildcard. Spec 2026-08-05-admin-tutorials-owner-search-filter.
    meta.owner as owner : String @Common.FieldControl: #ReadOnly,
```

- [ ] **Step 4: Widen `@cds.search`**

In `srv/admin-service.cds`, replace line 41:

```cds
  @cds.search: { title, slug, primaryTag, description }
```

with:

```cds
  @cds.search: { title, slug, primaryTag, description,
                 owner, authorDisplayName, authorEmail, authorFirstName, authorLastName }
```

- [ ] **Step 5: Verify the model compiles**

Run: `npx cds compile srv --to json >/dev/null && echo COMPILE_OK`
Expected: prints `COMPILE_OK` with no compiler errors.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/admin-tutorials-owner-search.test.js`
Expected: PASS (both cases).

- [ ] **Step 7: Commit**

```bash
git add srv/admin-service.cds test/unit/admin-tutorials-owner-search.test.js
git commit -m "feat(admin): flatten owner scalar + add owner/author to Tutorials @cds.search"
```

---

### Task 2: Re-point Owner filter, column, and value-list to the scalar (annotations + manifest)

**Files:**
- Modify: `app/admin-annotations.cds:616-624` (move value-list from `TutorialMeta.owner` to `Tutorials.owner`), `:632` (SelectionFields), `:641` and `:672` (LineItem + FieldGroup#General)
- Modify: `app/admin/tutorials/webapp/manifest.json` (applicationVersion bump)

**Interfaces:**
- Consumes: `AdminService.Tutorials.owner : String` scalar from Task 1.
- Produces: Owner SelectionField/LineItem/FieldGroup all bound to scalar `owner`; the `@Common.ValueList` → `TutorialOwnerPickList` now hangs off `Tutorials.owner`.

- [ ] **Step 1: Add the Owner annotation block on Tutorials.owner**

In `app/admin-annotations.cds`, inside the existing `annotate AdminService.Tutorials with { ... }` block that starts at line 560 (add just before its closing `};` at line 614, after the `mainPreviewLabel` line):

```cds
  owner            @Common.Label: 'Owner'                       @Common.FieldControl: #ReadOnly
                   @Common.ValueList: {
                     CollectionPath: 'TutorialOwnerPickList',
                     Parameters: [
                       { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: owner, ValueListProperty: 'owner' }
                     ]
                   };
```

- [ ] **Step 2: Remove the now-superseded TutorialMeta.owner value-list**

In `app/admin-annotations.cds`, replace the block at lines 616-624:

```cds
annotate AdminService.TutorialMeta with {
  owner @Common.Label: 'Owner' @Common.FieldControl: #ReadOnly
        @Common.ValueList: {
          CollectionPath: 'TutorialOwnerPickList',
          Parameters: [
            { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: owner, ValueListProperty: 'owner' }
          ]
        };
};
```

with the label-only form (the value-list now lives on `Tutorials.owner`; keep the label so any direct `TutorialMeta` view still shows "Owner"):

```cds
annotate AdminService.TutorialMeta with {
  owner @Common.Label: 'Owner' @Common.FieldControl: #ReadOnly;
};
```

- [ ] **Step 3: Point the SelectionField at the scalar**

In `app/admin-annotations.cds`, replace line 632:

```cds
  SelectionFields: [ title, primaryTag, experienceTag, status, meta.owner, isolated ],
```

with:

```cds
  SelectionFields: [ title, primaryTag, experienceTag, status, owner, isolated ],
```

- [ ] **Step 4: Point the LineItem column and FieldGroup at the scalar**

In `app/admin-annotations.cds`, replace line 641:

```cds
    { Value: meta.owner, Label: 'Owner' },
```

with:

```cds
    { Value: owner, Label: 'Owner' },
```

And replace line 672 (inside `FieldGroup#General`):

```cds
    { Value: meta.owner, Label: 'Owner' }
```

with:

```cds
    { Value: owner, Label: 'Owner' }
```

- [ ] **Step 5: Bump the admin app version**

In `app/admin/tutorials/webapp/manifest.json`, change:

```json
    "applicationVersion": { "version": "0.0.2" },
```

to:

```json
    "applicationVersion": { "version": "0.0.3" },
```

- [ ] **Step 6: Verify the model still compiles**

Run: `npx cds compile srv --to json >/dev/null && echo COMPILE_OK`
Expected: prints `COMPILE_OK`. (Annotations reference the scalar `owner` element added in Task 1; a typo/missing element would fail here.)

- [ ] **Step 7: Confirm no stray `meta.owner` UI reference remains**

Run: `grep -n "meta.owner" app/admin-annotations.cds`
Expected: no output (all UI references now use the scalar `owner`).

- [ ] **Step 8: Run the owner search test again (guard against regression)**

Run: `npx vitest run test/unit/admin-tutorials-owner-search.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add app/admin-annotations.cds app/admin/tutorials/webapp/manifest.json
git commit -m "feat(admin): wildcard-capable Owner filter + column via scalar owner; bump app version"
```

---

### Task 3: Full unit suite + model-deploy smoke

**Files:** none (verification only)

**Interfaces:** none.

- [ ] **Step 1: Deploy model to in-memory SQLite (schema/annotation sanity)**

Run: `npx cds deploy --to sqlite::memory: >/dev/null && echo DEPLOY_OK`
Expected: prints `DEPLOY_OK` (catches `@assert.unique` / projection breakage).

- [ ] **Step 2: Run the admin-related unit tests**

Run: `npx vitest run test/unit/admin-tutorials-owner-search.test.js test/unit/admin-manifests-no-controller-extension.test.js`
Expected: PASS.

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`
Expected: PASS (no regressions). If any pre-existing failures appear that are unrelated to owner (e.g., duplicate SearchService in a dirty worktree), note them; they must not be caused by this change — confirm by comparing against `origin/main`.

- [ ] **Step 4: Commit (only if any test-support files changed; otherwise skip)**

No commit expected — this task is verification. If Step 3 surfaced a needed fixture tweak, commit it with message `test(admin): stabilize owner search suite`.

---

## Post-implementation (NOT plan tasks — do with Tom)

- **Live verification (Tom's #1 rule):** after DEV deploy, drive the real List Report at `https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/admin-ui/#Tutorial-display` (or DEV equivalent) via Playwright with Tom's session: (a) toolbar search for an owner name returns their tutorials; (b) Owner column filter with `*partial*` returns contains-matches. Clear `ui5-cachemanager-db` IndexedDB if stale SelectionFields appear.
- **e2e spec:** add/adjust a `test/e2e/` spec for owner search (advisory e2e-coverage nudge will fire on the `app/admin/**` change).
- **Deploy:** merge to main via `gh pr create`; deploy from FRESH `origin/main` with full `mbt build` (NO `--skip-build`, NO `-m` scoping — admin-UI + srv both change), MTA patch bump. Confirm scope with Tom before `cf deploy`.

## Self-Review

- **Spec coverage:** flatten owner (Task 1 Step 3) ✓; widen `@cds.search` (Task 1 Step 4) ✓; move value-list to scalar as plain ValueList (Task 2 Steps 1-2) ✓; SelectionField swap (Task 2 Step 3) ✓; LineItem + FieldGroup swap (Task 2 Step 4) ✓; app version bump (Task 2 Step 5) ✓; no custom VH handler (Global Constraints) ✓; unit + deploy smoke (Tasks 1,3) ✓; live/e2e/deploy (post-impl) ✓.
- **Placeholder scan:** no TBD/TODO; all code blocks concrete.
- **Type consistency:** element name `owner` used identically across Task 1 (definition) and Task 2 (SelectionFields/LineItem/FieldGroup/ValueList); `TutorialOwnerPickList` and `ValueListProperty: 'owner'` match the existing entity at `srv/admin-service.cds:98`.
