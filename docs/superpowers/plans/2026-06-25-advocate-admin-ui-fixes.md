# Advocate Object Page admin-UI fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three usability bugs on the Advocate Object Page — Topics column shows GUIDs instead of tag labels (plus a stray ID column); Linked User shows `-` in display mode; Authored / Contributed Tutorials facets allow Create/Delete (they're inverse Associations, not Compositions).

**Architecture:** Two annotation-only CDS changes + one data backfill script. (a) `@UI.Hidden` on `AdminService.AdvocateTopics.ID`. (b) `@Capabilities.{Insert,Update,Delete}Restrictions` on the navigation aliases `authoredTutorials` / `contributedTutorials` of `AdminService.Advocates`. (c) `scripts/backfill-users-displayname.cjs` — one-shot HANA UPDATE that fills null `Users.displayName` from `firstName`/`lastName`. Topic-column GUID is a data problem (Tags.label null); the existing `npm run seed-tag-labels` is the fix.

**Tech Stack:** CAP CDS, Fiori Elements V4 annotations, HANA Cloud, Vitest.

**Spec:** [docs/superpowers/specs/2026-06-25-advocate-admin-ui-fixes-design.md](../specs/2026-06-25-advocate-admin-ui-fixes-design.md)

**Worktree:** `.claude/worktrees/advocate-admin-ui-fixes/` (branch: `worktree-advocate-admin-ui-fixes`)

**Dependency:** Independent of the email-edit plan. The two plans can land in either order; if email-edit's `srv/admin-service.cds` projection change is in flight, this plan's `app/admin-annotations.cds` change does NOT touch the same lines. Merge conflicts are unlikely; rebase before push.

---

## File map

| Path | Action | Purpose |
|---|---|---|
| `app/admin-annotations.cds` | Modify (~12 lines added) | Add `@UI.Hidden` on `AdminService.AdvocateTopics.ID`; add `@Capabilities.*` on Advocates' `authoredTutorials`/`contributedTutorials` aliases |
| `test/admin-annotations.test.js` | Modify (~30 lines added) | Two new EDMX-shape regression tests under the existing "Advocates inline tables" describe block |
| `scripts/backfill-users-displayname.cjs` | **Create** (~90 lines) | One-shot HANA UPDATE for null `Users.displayName` rows; idempotent; dry-run by default |
| `docs/developers/architecture/advocates.md` | Modify (~10 lines added) | Document the operational steps (seed-tag-labels + backfill script) needed post-deploy |

---

## Task 1: Setup + baseline tests

**Goal:** Confirm the worktree is clean and the existing admin-annotations regression suite passes before any change.

**Files:** none modified.

- [ ] **Step 1.1: Verify worktree state**

```bash
pwd
# expect: .../tutorials-poc/.claude/worktrees/advocate-admin-ui-fixes
git status --short
# expect: empty
git log --oneline -3
# expect: most recent is "docs(spec): Advocate Object Page admin-UI fixes (issue #638)"
```

- [ ] **Step 1.2: Verify dependencies populated**

```bash
ls node_modules/.bin/cds 2>&1 | head -1
# if missing: npm install && npm run setup
```

- [ ] **Step 1.3: Capture baseline pass count for the regression suite**

```bash
npx vitest run test/admin-annotations.test.js --reporter=basic 2>&1 | tail -15
# expect: all passing. Note the count — this becomes the regression baseline.
```

- [ ] **Step 1.4: No commit (probe only)**

---

## Task 2: Fix C — Capabilities annotations on Tutorials nav aliases (TDD)

**Goal:** Disable Create/Update/Delete on the `authoredTutorials` and `contributedTutorials` navigation aliases of `AdminService.Advocates`. TDD: write the regression test first, watch it fail, add the annotation, watch it pass.

**Files:**
- Modify: `test/admin-annotations.test.js` (add 1 new `it` block under the "Advocates inline tables" describe)
- Modify: `app/admin-annotations.cds` (add annotation block on the existing `annotate AdminService.Advocates with { … }` block at line 1885-1933)

- [ ] **Step 2.1: Write failing test**

Find the existing `describe('Advocates inline tables (PR #604 regression)', () => { ... })` block in `test/admin-annotations.test.js` (around line 63). Insert a new `it` block at the end of that describe, before its closing brace:

```js
    it('Advocates/authoredTutorials + contributedTutorials disallow Insert/Update/Delete', () => {
      // Inverse Associations (not Compositions) — Create/Delete on the inline
      // table would error or create orphans. Capabilities annotation hides
      // the FE V4 toolbar buttons cleanly. Spec §4.4.
      for (const nav of ['authoredTutorials', 'contributedTutorials']) {
        const region = metadata.match(
          new RegExp(`<Annotations Target="AdminService\\.Advocates/${nav}"[\\s\\S]*?</Annotations>`)
        );
        expect(region, `Advocates/${nav} annotations region not found`).toBeTruthy();
        expect(region[0]).toContain('Term="Capabilities.InsertRestrictions"');
        expect(region[0]).toContain('Term="Capabilities.UpdateRestrictions"');
        expect(region[0]).toContain('Term="Capabilities.DeleteRestrictions"');
        // The Insertable/Updatable/Deletable values should be literal false.
        expect(region[0]).toMatch(/Insertable" Bool="false"/);
        expect(region[0]).toMatch(/Updatable" Bool="false"/);
        expect(region[0]).toMatch(/Deletable" Bool="false"/);
      }
    });
```

- [ ] **Step 2.2: Run — expect FAIL (annotation not yet added)**

```bash
npx vitest run test/admin-annotations.test.js --reporter=basic 2>&1 | tail -15
# expect: 1 new failure — "Advocates/authoredTutorials + contributedTutorials disallow Insert/Update/Delete".
# Reason: region region not found, OR region found but missing Capabilities.* terms.
```

- [ ] **Step 2.3: Add the annotations to `app/admin-annotations.cds`**

Find the `annotate AdminService.Advocates with { … };` block at line 1885. The block ends at line 1933 with `};`. Insert the new annotations INSIDE this block, just before the closing `};`, using `Edit` with an anchor on the unique closing of the existing user-value-help block.

`old_string`:

```cds
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

`new_string` (adds two new property annotation entries before the closing `};`):

```cds
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

  // Spec: docs/superpowers/specs/2026-06-25-advocate-admin-ui-fixes-design.md §4.4.
  // Inverse-Association nav properties on the Advocates projection. Hide
  // Create/Delete/edit affordances so admins don't accidentally try to
  // mutate tutorials from the Advocate OP (these are read-through views,
  // not Compositions). FE V4 honors @Capabilities.* on navigation aliases.
  authoredTutorials    @Capabilities.InsertRestrictions: { Insertable: false }
                       @Capabilities.UpdateRestrictions: { Updatable:  false }
                       @Capabilities.DeleteRestrictions: { Deletable:  false };
  contributedTutorials @Capabilities.InsertRestrictions: { Insertable: false }
                       @Capabilities.UpdateRestrictions: { Updatable:  false }
                       @Capabilities.DeleteRestrictions: { Deletable:  false };
};
```

- [ ] **Step 2.4: Run — expect PASS for new case + no regressions**

```bash
npx vitest run test/admin-annotations.test.js --reporter=basic 2>&1 | tail -15
# expect: baseline count + 1 new = all passing
```

- [ ] **Step 2.5: Optionally probe the deployed EDMX shape directly to be sure FE V4 sees it**

```bash
EDMX_TMP="${TEMP:-/tmp}/ui-fix-edmx.xml"
npx cds compile srv/admin-service.cds -s AdminService -2 edmx 2>/dev/null > "$EDMX_TMP"
node -e "
const x = require('fs').readFileSync(process.env.EDMX_TMP, 'utf8');
for (const nav of ['authoredTutorials', 'contributedTutorials']) {
  const re = new RegExp('<Annotations Target=\"AdminService\\.Advocates/' + nav + '\"[\\\\s\\\\S]*?</Annotations>');
  const m = x.match(re);
  console.log(nav, m && m[0].includes('Capabilities.InsertRestrictions') ? 'OK' : 'MISSING');
}
" EDMX_TMP="$EDMX_TMP"
# expect: both OK
```

- [ ] **Step 2.6: Commit**

```bash
git add app/admin-annotations.cds test/admin-annotations.test.js
git commit -m "feat(advocates): disable Insert/Update/Delete on Tutorials facets (issue #638)

authoredTutorials + contributedTutorials are inverse Associations
projected from Users — they are NOT Compositions. FE V4 was rendering
Create/Delete buttons on these inline-table facets, which would either
silently fail or create orphan rows.

Capabilities.{Insert,Update,Delete}Restrictions on the navigation
aliases hides the toolbar affordances cleanly. New regression test
under test/admin-annotations.test.js pins the EDMX shape.

Refs: docs/superpowers/specs/2026-06-25-advocate-admin-ui-fixes-design.md §4.4"
```

---

## Task 3: Fix A2 — hide AdvocateTopics row-ID column (TDD)

**Goal:** Add `@UI.Hidden` to `AdminService.AdvocateTopics.ID` so the inline Topics table doesn't render a column showing the row's own GUID.

**Files:**
- Modify: `test/admin-annotations.test.js` (add 1 new `it`)
- Modify: `app/admin-annotations.cds` (extend existing `annotate AdminService.AdvocateTopics with { … }` block at line 2081-2093)

- [ ] **Step 3.1: Write failing test**

In the same `describe('Advocates inline tables (PR #604 regression)', …)` block, add:

```js
    it('AdvocateTopics.ID is hidden from the Topics inline table', () => {
      // The projection has no explicit field list, so ID is auto-projected.
      // FE V4's column-personalization dialog (or a default column set)
      // surfaces the row's own GUID alongside the Topic FK — confusing for
      // admins. @UI.Hidden suppresses the column entirely. Spec §4.2.
      const region = metadata.match(
        /<Annotations Target="AdminService\.AdvocateTopics\/ID"[\s\S]*?<\/Annotations>/
      );
      expect(region, 'AdvocateTopics/ID annotations region not found').toBeTruthy();
      // @UI.Hidden serializes to Term="UI.Hidden" Bool="true" (default truth).
      expect(region[0]).toMatch(/Term="UI\.Hidden"/);
    });
```

- [ ] **Step 3.2: Run — expect FAIL**

```bash
npx vitest run test/admin-annotations.test.js --reporter=basic 2>&1 | tail -15
# expect: 1 new failure — "AdvocateTopics.ID is hidden from the Topics inline table"
```

- [ ] **Step 3.3: Add `@UI.Hidden` to `AdvocateTopics.ID`**

In `app/admin-annotations.cds`, find the `annotate AdminService.AdvocateTopics with { ... };` block at line 2081. The block currently has one entry (`tag @...`). Extend it:

`old_string`:

```cds
annotate AdminService.AdvocateTopics with {
  tag @Common.Label: 'Topic'
      @Common.Text: tag.label
      @Common.TextArrangement: #TextOnly
      @Common.ValueList: {
        CollectionPath: 'Tags',
        Parameters: [
          { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: tag_ID, ValueListProperty: 'ID' },
          { $Type: 'Common.ValueListParameterDisplayOnly',                            ValueListProperty: 'label' },
          { $Type: 'Common.ValueListParameterDisplayOnly',                            ValueListProperty: 'name' }
        ]
      };
};
```

`new_string`:

```cds
annotate AdminService.AdvocateTopics with {
  // Spec: 2026-06-25-advocate-admin-ui-fixes-design.md §4.2.
  // Projection has no explicit field list, so the row's own ID is auto-
  // projected and FE V4 may surface it in the inline Topics table or the
  // column-personalization dialog. @UI.Hidden suppresses it cleanly.
  ID  @UI.Hidden;
  tag @Common.Label: 'Topic'
      @Common.Text: tag.label
      @Common.TextArrangement: #TextOnly
      @Common.ValueList: {
        CollectionPath: 'Tags',
        Parameters: [
          { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: tag_ID, ValueListProperty: 'ID' },
          { $Type: 'Common.ValueListParameterDisplayOnly',                            ValueListProperty: 'label' },
          { $Type: 'Common.ValueListParameterDisplayOnly',                            ValueListProperty: 'name' }
        ]
      };
};
```

- [ ] **Step 3.4: Run — expect PASS for new case + no regressions**

```bash
npx vitest run test/admin-annotations.test.js --reporter=basic 2>&1 | tail -15
# expect: baseline count + 1 (Task 2) + 1 (Task 3) = all passing
```

- [ ] **Step 3.5: Verify with EDMX inspector**

```bash
EDMX_TMP="${TEMP:-/tmp}/ui-fix-edmx.xml"
npx cds compile srv/admin-service.cds -s AdminService -2 edmx 2>/dev/null > "$EDMX_TMP"
node -e "
const x = require('fs').readFileSync(process.env.EDMX_TMP, 'utf8');
const m = x.match(/<Annotations Target=\"AdminService\\.AdvocateTopics\\/ID\"[\\s\\S]*?<\\/Annotations>/);
console.log('AdvocateTopics.ID @UI.Hidden:', m && m[0].includes('UI.Hidden') ? 'OK' : 'MISSING');
" EDMX_TMP="$EDMX_TMP"
# expect: OK
```

- [ ] **Step 3.6: Commit**

```bash
git add app/admin-annotations.cds test/admin-annotations.test.js
git commit -m "feat(advocates): hide AdvocateTopics.ID column from inline Topics table

The projection 'entity AdvocateTopics as projection on ims.AdvocateTopics'
has no explicit field list, so the row's own primary-key ID auto-projects.
FE V4 surfaces it alongside the Topic FK in the Topics inline table /
column-personalization dialog — confusing for admins. @UI.Hidden on ID
suppresses it cleanly without restructuring the projection.

New regression test pins the EDMX shape.

Refs: docs/superpowers/specs/2026-06-25-advocate-admin-ui-fixes-design.md §4.2"
```

---

## Task 4: Fix B — backfill-users-displayname script (TDD)

**Goal:** One-shot script that fills null `Users.displayName` from `firstName`/`lastName` so the `@Common.Text: user/displayName` resolution on the Linked User field renders text instead of `-`. The annotation propagation works (verified in spec §2.2); the failure mode is data-shape (null `displayName` on migrated rows).

**Files:**
- Create: `scripts/backfill-users-displayname.cjs`

The script is a CAP `cds bind --exec` wrapper around a HANA UPDATE — not a unit-testable module. We exercise it with a dry-run probe and one HANA round-trip when Tom runs `--commit`. No unit test file.

- [ ] **Step 4.1: Read the sibling script pattern**

```bash
head -90 scripts/cleanup-advocate-link-test-rows.cjs
```

This is the canonical CommonJS + `@sap/cds` + COMMIT-flag pattern. The new script follows the same shape.

- [ ] **Step 4.2: Implement `scripts/backfill-users-displayname.cjs`**

```js
#!/usr/bin/env node
/**
 * One-shot backfill for COM_SAP_DEVELOPERS_IMS_USERS.DISPLAYNAME.
 *
 * Issue #638: migrated users often have firstName + lastName populated by
 * the JWT but displayName=null (the IMS migrator copied SAP_ID + totals
 * but never displayName). Empty displayName makes the Advocate OP's
 * "Linked User" field render '-' because @Common.Text: user/displayName
 * resolves to null.
 *
 * Fix: compute displayName = TRIM(firstName + ' ' + lastName) for any row
 * where displayName IS NULL AND at least one name part is non-empty. Rows
 * with no firstName AND no lastName get skipped — those are typically not-
 * yet-JIT-backfilled migrated users whose next login triggers
 * srv/lib/resolve-db-user.js#backfillUserProfile to populate everything.
 *
 * Usage:
 *   # Dry-run (default) — shows count + a sample, no writes.
 *   npx cds bind --exec -- node scripts/backfill-users-displayname.cjs
 *
 *   # Live run — actually updates.
 *   npx cds bind --exec -- node scripts/backfill-users-displayname.cjs --commit
 *
 * Idempotent — second run finds 0 rows. Safe to retire after one clean
 * run on DEV, but harmless to keep around for future migrated batches.
 */
'use strict';

const cds = require('@sap/cds');

const COMMIT = process.argv.includes('--commit');

async function main() {
  console.log('backfill-users-displayname');
  console.log(COMMIT ? '  Mode: --commit (will UPDATE matching rows)\n' : '  Mode: dry-run (no writes; use --commit to apply)\n');

  const db = await cds.connect.to('db');

  // Find candidate rows. HANA stores unquoted CDS identifiers as
  // UPPERCASE; mixed-case identifiers must be quoted.
  const rows = await db.run(
    `SELECT "ID", "firstName", "lastName", "displayName", EMAIL
       FROM COM_SAP_DEVELOPERS_IMS_USERS
      WHERE "displayName" IS NULL
        AND (
          LENGTH(TRIM(COALESCE("firstName", ''))) > 0
          OR LENGTH(TRIM(COALESCE("lastName", ''))) > 0
        )`
  );

  console.log(`Found ${rows.length} candidate row(s) with NULL displayName but non-empty name:`);
  for (const r of rows.slice(0, 10)) {
    const newName = `${r.firstName || ''} ${r.lastName || ''}`.trim();
    console.log(`  ${r.ID}  '${r.firstName ?? ''}' + '${r.lastName ?? ''}' → '${newName}'  (${r.EMAIL ?? '<no email>'})`);
  }
  if (rows.length > 10) {
    console.log(`  ...and ${rows.length - 10} more`);
  }

  if (rows.length === 0) {
    console.log('\nNothing to backfill. Done.');
    return;
  }

  if (!COMMIT) {
    console.log('\nDry-run complete. Re-run with --commit to apply.');
    return;
  }

  // Run the UPDATE. The same WHERE clause is reapplied so the operation
  // remains idempotent — re-running after partial failure finds the
  // still-NULL rows. TRIM is double-applied (inner + the outer wrapping)
  // to defend against rows where firstName is '   ' (whitespace-only).
  const result = await db.run(
    `UPDATE COM_SAP_DEVELOPERS_IMS_USERS
        SET "displayName" = TRIM(
              COALESCE("firstName", '') || ' ' || COALESCE("lastName", '')
            )
      WHERE "displayName" IS NULL
        AND (
          LENGTH(TRIM(COALESCE("firstName", ''))) > 0
          OR LENGTH(TRIM(COALESCE("lastName", ''))) > 0
        )`
  );
  // hdb driver returns either a numeric affected-row count or an object
  // with affectedRows. Normalize for the log line.
  const affected = typeof result === 'number' ? result : (result?.affectedRows ?? rows.length);
  console.log(`\nUpdated row count reported by HANA: ${affected}`);
  console.log(`(Expected: ${rows.length}. Drift indicates concurrent writes during the run — re-run to converge.)`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
```

- [ ] **Step 4.3: Syntax-check the script**

```bash
node -c scripts/backfill-users-displayname.cjs && echo "syntax OK"
# expect: syntax OK
```

- [ ] **Step 4.4: Commit**

```bash
git add scripts/backfill-users-displayname.cjs
git commit -m "scripts(advocates): backfill Users.displayName for migrated users (#638)

One-shot HANA UPDATE that fills NULL displayName from firstName+lastName
for rows where at least one part is non-empty. Idempotent; dry-run by
default. Sibling pattern to scripts/cleanup-advocate-link-test-rows.cjs.

Empty displayName was making the Linked User field on the Advocate OP
render '-' for migrated users. The @Common.Text propagation chain works
(verified in spec §2.2); this script fixes the underlying data.

Tom runs once on DEV:
  npx cds bind --exec -- node scripts/backfill-users-displayname.cjs
  # confirm dry-run output, then:
  npx cds bind --exec -- node scripts/backfill-users-displayname.cjs --commit"
```

---

## Task 5: Documentation — operational steps for Fix A1 + B

**Goal:** Document the seed-tag-labels + backfill-users-displayname runs in the developer docs so Tom (or future maintainers) don't have to re-derive them.

**Files:**
- Modify: `docs/developers/architecture/advocates.md`

- [ ] **Step 5.1: Read current doc**

```bash
grep -n "## " docs/developers/architecture/advocates.md | head -20
```

- [ ] **Step 5.2: Add an "Admin OP data dependencies" section near the end**

Use `Edit` to append (find a unique anchor — likely the last `## ` header in the file, and add the new section after it).

```markdown
## Admin OP data dependencies

The Advocate Object Page has two data dependencies that, if violated, cause
visible rendering issues. The bugs are documented in issue #638; the
operational fixes are scripts that have already been run on DEV but may
need re-running after future migrations or schema reseeding.

### Topics column shows the tag GUID

**Symptom:** The Topics inline table renders the tag's primary key (UUID)
instead of the human label.

**Root cause:** `Tags.label` is NULL for the referenced tag row.
`@Common.Text: tag.label` on `AdvocateTopics.tag_ID` resolves to null, and
FE V4 falls back to the FK GUID.

**Fix (re-run as needed):**

```bash
ADMIN_BEARER_TOKEN=<admin-XSUAA-token> npm run seed-tag-labels
```

The seeder harvests labels from the legacy AEM Solr endpoint and writes
them to `Tags.label`. See `scripts/seed-tag-labels.ts` for details.

### Linked User field shows '-'

**Symptom:** The Linked User field on the Identity tab shows a dash even
when a user IS linked.

**Root cause:** `Users.displayName` is NULL for the linked user. Migrated
rows often have firstName + lastName populated but displayName=null
(the IMS migrator never copied displayName). The OP's
`@Common.Text: user/displayName` resolves to null and FE V4 renders the
empty placeholder.

**Fix (re-run as needed):**

```bash
# Dry-run preview
npx cds bind --exec -- node scripts/backfill-users-displayname.cjs

# After confirming output:
npx cds bind --exec -- node scripts/backfill-users-displayname.cjs --commit
```

Script is idempotent. Safe to run any time displayName drift recurs (e.g.
after a fresh migration batch where IDP backfill hasn't yet fired).
```

- [ ] **Step 5.3: Commit**

```bash
git add docs/developers/architecture/advocates.md
git commit -m "docs(advocates): document Admin OP data dependencies (issue #638)

The Topics-shows-GUID and Linked-User-shows-dash bugs are data problems
not code problems; document the operational fixes (seed-tag-labels and
backfill-users-displayname) so maintainers don't re-derive them when
similar drift recurs after future migrations.

Refs: docs/superpowers/specs/2026-06-25-advocate-admin-ui-fixes-design.md §1, §3"
```

---

## Task 6: Final regression run + cds build verification

**Goal:** Belt-and-suspenders check that the annotation changes compile cleanly and don't break existing tests.

- [ ] **Step 6.1: Run admin-annotations.test.js — expect green**

```bash
npx vitest run test/admin-annotations.test.js --reporter=basic 2>&1 | tail -15
# expect: baseline + 2 new = all passing
```

- [ ] **Step 6.2: Run the advocate unit-test suite — expect green (no regressions)**

```bash
npx vitest run test/unit/advocates --reporter=basic 2>&1 | tail -15
# expect: all passing (annotation changes don't touch advocate behavior tests)
```

- [ ] **Step 6.3: cds build for production**

```bash
npx cds build --production 2>&1 | tail -20
# expect: BUILD SUCCESS or equivalent; no errors. The CSN drift will be
# picked up by check-cds-build-staging when the PR is pushed
# (CLAUDE.md: "check-cds-build-staging fires on ANY srv/ change").
```

- [ ] **Step 6.4: Commit any gen/ artifacts if `git status` shows changes**

```bash
git status --short
# If gen/ has changes:
git add gen/ srv-gen/ 2>/dev/null || true
git commit -m "build(advocates): regenerate CSN for UI-fix annotations" --allow-empty
```

- [ ] **Step 6.5: No further commit — Task 6 is verification only**

---

## Task 7: Manual verification post-deploy (Tom's responsibility)

**Goal:** After deploy, Tom verifies each bug visually in the admin UI. This task is documented for completeness; the agent does NOT perform it.

The plan executor outputs the checklist for Tom:

```text
Post-deploy on DEV:

1. Run npm run seed-tag-labels (one-shot data fix for Topics labels):
   ADMIN_BEARER_TOKEN=... npm run seed-tag-labels

2. Run the displayName backfill:
   npx cds bind --exec -- node scripts/backfill-users-displayname.cjs
   # confirm the dry-run output, then:
   npx cds bind --exec -- node scripts/backfill-users-displayname.cjs --commit

3. Open https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/admin-ui/#advocates-display

4. Click into your Advocate row:
   - Topics tab: Topic column shows tag labels (e.g. 'BTP'), no GUIDs, no ID column.
   - Identity tab: Linked User shows your display name (e.g. 'Thomas Jung'), not '-'.
   - Authored / Contributed Tutorials: no Create button visible in the table toolbar.

5. If any check fails, the FE V4 client may not honor @Capabilities on the navigation
   property. Spec §4.4 documents the controller-extension fallback as v2.
```

- [ ] **Step 7.1: No commit — this is operator documentation, not code**

---

## Task 8: Push branch + open PR

**Goal:** Land the fixes.

- [ ] **Step 8.1: Push the worktree branch to origin**

```bash
git push -u origin worktree-advocate-admin-ui-fixes
```

- [ ] **Step 8.2: Open PR using gh**

```bash
gh pr create \
  --title "fix(advocates): Object Page UI bugs (refs #638)" \
  --body "$(cat <<'PRBODY'
Implements docs/superpowers/specs/2026-06-25-advocate-admin-ui-fixes-design.md.

## Changes

- **Fix C — Tutorials buttons:** Capabilities.{Insert,Update,Delete}Restrictions
  on the navigation aliases authoredTutorials and contributedTutorials of
  AdminService.Advocates. FE V4 hides Create/Delete affordances.
- **Fix A2 — stray ID column:** @UI.Hidden on AdminService.AdvocateTopics.ID
  so the row's own GUID doesn't render alongside the Topic FK.
- **Fix B — backfill script:** scripts/backfill-users-displayname.cjs is a
  one-shot HANA UPDATE that fills NULL Users.displayName from firstName+lastName.
  Run on DEV post-deploy.
- **Fix A1 (data):** No code change. Existing npm run seed-tag-labels
  populates Tags.label; documented in docs/developers/architecture/advocates.md.

## Tests

- Two new EDMX-shape regression tests under test/admin-annotations.test.js
  (existing "Advocates inline tables" describe block).
- Existing 68 advocate tests + the admin-annotations baseline still pass.

## Post-deploy (Tom)

\`\`\`bash
ADMIN_BEARER_TOKEN=... npm run seed-tag-labels
npx cds bind --exec -- node scripts/backfill-users-displayname.cjs
# confirm output, then:
npx cds bind --exec -- node scripts/backfill-users-displayname.cjs --commit
\`\`\`

Then visual check per docs/developers/architecture/advocates.md "Admin OP
data dependencies" section.

## Sibling PR

The editable email field + test fixture lockdown half of issue #638 lives
in a separate worktree + PR (\`.claude/worktrees/advocate-email-edit/\`).
Both PRs together close issue #638.

Closes #638.
PRBODY
)"
```

- [ ] **Step 8.3: No commit — push + PR creation only**

---

## Rollback

All changes are annotation-only + a script:

1. `git revert <merge-commit>` on `main` reverts the annotations.
2. The backfilled `Users.displayName` values stay in HANA. Not destructive; not reversed by the code revert. If a rollback specifically requires emptying displayName, write a follow-up script — none currently needed.
3. The seed-tag-labels populated rows stay in HANA. Same as above.

## Related

- Spec: [docs/superpowers/specs/2026-06-25-advocate-admin-ui-fixes-design.md](../specs/2026-06-25-advocate-admin-ui-fixes-design.md)
- Sibling plan: [docs/superpowers/plans/2026-06-25-advocate-email-edit.md](2026-06-25-advocate-email-edit.md) (in the parallel worktree)
- Issue: #638
