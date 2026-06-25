# Advocate Object Page admin-UI fixes

**Status:** Draft · **Date:** 2026-06-25 · **Author:** Thomas Jung (decisions) + Claude (capture)
**Issue:** [#638](https://github.com/sap-tutorials/tutorials-ims/issues/638) (follow-up — sibling to `2026-06-25-advocate-email-edit-design.md`)

## 1 — Problem

Three usability bugs on the Advocate Object Page that Tom flagged during the 2026-06-25 brainstorm:

**Bug A.** Topics inline table shows two GUID columns: a "Topic" column (Tag's GUID) and an "ID" column (AdvocateTopics row's GUID). Should show the human-readable tag label, no row-ID column at all.

**Bug B.** "Linked User" field in the Identity tab shows `-` in display mode, even when a user is linked. Should show the user's display name (e.g. "Thomas Jung").

**Bug C.** Authored Tutorials and Contributed Tutorials inline-table facets show Create/Delete buttons. Those are inverse Associations, not Compositions — clicking Create would fail or create orphan rows. Should be display-only.

## 2 — Live diagnostics (run before designing)

Three probes against the actual codebase. **All three results are facts as of 2026-06-25**, run via `npx cds compile srv/admin-service.cds -s AdminService -2 edmx` + targeted grep against EDMX output.

### 2.1 — Probe: does `tag @Common.Text` propagate to the generated `tag_ID` property?

Compiled EDMX excerpt for `AdminService.AdvocateTopics`:

```xml
<Annotations Target="AdminService.AdvocateTopics/tag_ID">
  <Annotation Term="Common.Label" String="Topic"/>
  <Annotation Term="Common.Text" Path="tag/label">
    <Annotation Term="UI.TextArrangement" EnumMember="UI.TextArrangementType/TextOnly"/>
  </Annotation>
  <Annotation Term="Common.ValueList">…Tags value-help…</Annotation>
</Annotations>
```

**Finding:** Propagation works. `Common.Text` IS on `tag_ID`. The PR #586 comment block claiming "Element 'tag_ID' has not been found" is **out of date** — cds-compiler's auto-propagation from association to FK is fully functional today. The Topics-column-shows-GUID problem is NOT an annotation gap.

### 2.2 — Probe: does `user @Common.Text` propagate to `user_ID`?

```xml
<Annotations Target="AdminService.Advocates/user_ID">
  <Annotation Term="Common.Label" String="Linked User"/>
  <Annotation Term="Common.Text" Path="user/displayName">
    <Annotation Term="UI.TextArrangement" EnumMember="UI.TextArrangementType/TextOnly"/>
  </Annotation>
  <Annotation Term="Common.ValueList">…Users value-help…</Annotation>
</Annotations>
```

**Finding:** Propagation works. `Common.Text` IS on `user_ID`, pointing at `user/displayName`. The "-" symptom is NOT an annotation gap.

### 2.3 — Probe: does `authoredTutorials` carry `Capabilities` annotations?

```
no authoredTutorials Capabilities propagated
```

**Finding:** Nothing there. Confirmed gap. Need to add annotations explicitly.

### 2.4 — Probe: is `Users.displayName` computed or stored?

[db/schema.cds:117-123](../../../db/schema.cds#L117-L123):

```cds
entity Users : cuid, managed, LegacyKeyed {
  uuid                      : String(36) @mandatory;
  sapId                     : String(255);
  firstName                 : String(255);
  lastName                  : String(255);
  email                     : String(255);
  displayName               : String(255);    // plain stored column
  ...
}
```

**Finding:** Plain stored `String(255)`. NOT computed. NOT virtual. Tom's linked-User row has `displayName` either set or null; the bug is data-shape, not annotation.

### 2.5 — Probe: AdvocateTopics projection field list

[srv/admin-service.cds:420](../../../srv/admin-service.cds#L420):

```cds
entity AdvocateTopics  as projection on ims.AdvocateTopics;
```

No field list. So the projection includes everything from the base entity: `ID`, `advocate_ID`, `tag_ID`, plus draft scaffolding (`IsActiveEntity`, `HasActiveEntity`, `HasDraftEntity`, `DraftAdministrativeData`, `SiblingEntity`, `DraftMessages`).

**Finding:** The "ID" column showing in the screenshot is the row's own primary-key `ID`. It appears because FE V4's inline-table default rendering surfaces all projected scalars not explicitly hidden — and `@UI.LineItem` only restricts the SELECTED display, not which fields are *available* in the column-personalization dialog. The user may have personalized the table to add the `ID` column, OR FE V4 1.130's "table compact-mode default columns" added it. Either way: explicit `@UI.Hidden: true` on `ID` (or `@Common.FieldControl: #Hidden`) is the fix.

## 3 — Revised root-cause diagnosis

| Bug | Original guess (wrong) | Verified root cause |
|---|---|---|
| A1: Topic shows GUID | Annotation propagation broken | `Tags.label` is null for that tag row (FE V4 follows `Common.Text: tag/label`; null → fallback to FK GUID). Per CLAUDE.md memory `feedback_tag_labels_seed_required`, `Tags.label` is empty for 10,523 rows until `seed-tag-labels` runs. |
| A2: Stray "ID" column | LineItem doesn't restrict columns | The projection has no field list — `ID` is auto-included; needs `@UI.Hidden`. |
| B: Linked User "-" | Annotation propagation broken | `Users.displayName` is null for Tom's linked-User row (migrated rows commonly have null displayName until JIT-backfill fires on the next login). |
| C: Tutorials buttons | `@Capabilities` would propagate from inverse-Association | No annotation, no propagation; FE V4 defaults to insertable/deletable. Need explicit `@Capabilities` on the navigation property. |

## 4 — Architecture

### 4.1 — Fix A1 (Topic GUID): seed the tag labels

The Topic column already binds correctly. It will render the label once `Tags.label` is populated. **Run the existing `npm run seed-tag-labels` on DEV.** This is documented in CLAUDE.md "Gotchas":

> Run on DEV with `cds bind --exec`: `ADMIN_BEARER_TOKEN=... npm run seed-tag-labels`.

No code change for A1. One-time data operation.

**Diagnostic precondition:** before running the seeder, confirm the failure mode with a SQL probe:

```sql
SELECT id, name, label FROM "com.sap.developers.ims.Tags"
WHERE id = '546f2cba-e48c-5866-940d-facecf978f0e';
-- expected: label IS NULL
```

If `label` is non-null but the column still renders the GUID, the diagnosis is wrong and we re-open §3.

### 4.2 — Fix A2 (stray ID column): hide it

[app/admin-annotations.cds:2081-2093](../../../app/admin-annotations.cds#L2081-L2093) — add `@UI.Hidden` to the AdvocateTopics `ID` field:

```cds
annotate AdminService.AdvocateTopics with {
  ID  @UI.Hidden;
  tag @Common.Label: 'Topic'
      @Common.Text: tag.label
      @Common.TextArrangement: #TextOnly
      @Common.ValueList: { … unchanged … };
};
```

`@UI.Hidden` (vs `@UI.HiddenFilter`) hides the property from the LineItem render entirely. Already used on the parent entity for `slug`, `hasPhoto`, etc.

**Alternative considered + rejected:** narrow the projection field list (`entity AdvocateTopics as projection on ims.AdvocateTopics { tag, advocate, IsActiveEntity, HasActiveEntity }`). Rejected because (a) draft scaffolding fields like `DraftAdministrativeData` need to be in the projection for draft flows to work, and (b) `@UI.Hidden` is the FE-V4 canonical way to hide a single column without restructuring the OData metadata.

### 4.3 — Fix B (Linked User "-"): backfill displayName

The annotation works. The data is missing. Two paths:

**Path 1 (recommended): One-shot backfill script.** New file [scripts/backfill-users-displayname.cjs](../../../scripts/backfill-users-displayname.cjs):

```js
// One-shot: populate Users.displayName for rows where it's null but firstName/
// lastName are present. Idempotent: rows with non-null displayName are skipped.
// Dry-run by default; --commit to apply.
//
// Run on DEV: npx cds bind --exec -- node scripts/backfill-users-displayname.cjs --commit
//
// SQL (HANA):
//   UPDATE "com.sap.developers.ims.Users"
//   SET displayName = TRIM(COALESCE(firstName, '') || ' ' || COALESCE(lastName, ''))
//   WHERE displayName IS NULL
//     AND (
//       LENGTH(TRIM(COALESCE(firstName, ''))) > 0
//       OR LENGTH(TRIM(COALESCE(lastName, ''))) > 0
//     );
//
// The LENGTH-TRIM-COALESCE chain skips rows where firstName/lastName are
// NULL **or** empty-string — without it, a row with firstName='' and
// lastName='' would get displayName=' ' (single space) which is worse than NULL.
// Rows skipped here are typically not-yet-JIT-backfilled migrated users;
// their next login triggers backfillUserProfile() to populate everything
// from the JWT.
```

**Path 2 (rejected): make displayName a calculated element on the Users projection.**

```cds
// in srv/admin-service.cds — AdminService.Users projection
entity Users as projection on ims.Users {
  *,
  virtual concat(firstName, ' ', lastName) as displayNameFallback : String(255),
};
```

Rejected because: (a) it doesn't help the existing `Common.Text: user/displayName` path used by the Linked User binding — would need every annotation site updated; (b) it splits the truth between `displayName` (stored) and `displayNameFallback` (computed); (c) the stored column ALREADY exists, fill it.

**Diagnostic precondition:** before running, confirm with a SQL probe:

```sql
SELECT COUNT(*) AS null_display, SUM(CASE WHEN firstName IS NOT NULL OR lastName IS NOT NULL THEN 1 ELSE 0 END) AS fixable
FROM "com.sap.developers.ims.Users"
WHERE displayName IS NULL;
```

If `null_display` is small (e.g. <10), Tom can manually UPDATE his own linked-User row instead of running the script.

### 4.4 — Fix C (Tutorials buttons): add Capabilities annotations

[app/admin-annotations.cds:1885-1933](../../../app/admin-annotations.cds#L1885-L1933) — extend the existing `annotate AdminService.Advocates with { … };` block in-place (don't add a new annotate block — keeps the file shape consistent):

```cds
annotate AdminService.Advocates with {
  …existing label / value-help annotations…
  authoredTutorials    @Common.Label: 'Authored Tutorials'
                       @Capabilities.InsertRestrictions: { Insertable: false }
                       @Capabilities.DeleteRestrictions: { Deletable:  false }
                       @Capabilities.UpdateRestrictions: { Updatable:  false };
  contributedTutorials @Common.Label: 'Contributed Tutorials'
                       @Capabilities.InsertRestrictions: { Insertable: false }
                       @Capabilities.DeleteRestrictions: { Deletable:  false }
                       @Capabilities.UpdateRestrictions: { Updatable:  false };
};
```

**Uncertainty acknowledged:** FE V4 behavior on `@Capabilities` annotations attached to navigation properties (vs entity sets) is documented for OData V4 but not extensively tested in this codebase. The plan must include an EDMX verification step (§5.3 below) before manual UI testing, so we catch propagation failure cheaply.

**Fallback if FE V4 ignores the annotation on the navigation property:** apply the same annotations on the *target* entity sets (`@Capabilities.InsertRestrictions` on `AdminService.Tutorials` and `AdminService.TutorialContributors`). Rejected as primary path because it would also remove the Create button from the top-level Tutorials and TutorialContributors admin tiles — which we need. The navigation-property-level annotation is the right shape; if it doesn't work we add a UI5 controller extension to hide the toolbar buttons (out of scope for this spec; document as v2).

## 5 — Build, deploy, verify

### 5.1 — Order of operations

1. **Apply 4.2 + 4.4 (CDS annotation changes).** Local: `npx cds build --production` + `npm run build:all` + standard local-deploy.
2. **Apply 4.3 (backfill script).** Lands as a script file; runs only when Tom invokes it. Doesn't affect build.
3. **Run on DEV after deploy:**
   - `npm run seed-tag-labels` (fix A1)
   - `npx cds bind --exec -- node scripts/backfill-users-displayname.cjs --commit` (fix B)
4. **Reload admin UI; verify each bug visually.**

### 5.2 — Pre-deploy EDMX verification

Local check before pushing:

```bash
cd d:/projects/tutorials-poc
# On Windows + Git Bash use $TEMP not /tmp
EDMX_OUT="${TEMP:-/tmp}/edmx-check.xml"
npx cds compile srv/admin-service.cds -s AdminService -2 edmx 2>/dev/null > "$EDMX_OUT"
# Expect: Capabilities.InsertRestrictions appears on authoredTutorials + contributedTutorials
node -e "
const x = require('fs').readFileSync(process.env.EDMX_OUT,'utf8');
['authoredTutorials','contributedTutorials'].forEach(nav => {
  const m = x.match(new RegExp('<Annotations Target=\"AdminService\\.Advocates/' + nav + '\"[\\\\s\\\\S]*?</Annotations>'));
  console.log(nav, m && m[0].includes('Capabilities.InsertRestrictions') ? 'OK' : 'MISSING');
});
" EDMX_OUT="$EDMX_OUT"
# Expect: AdvocateTopics.ID carries UI.Hidden
node -e "
const x = require('fs').readFileSync(process.env.EDMX_OUT,'utf8');
const m = x.match(/<Annotations Target=\"AdminService\\.AdvocateTopics\\/ID\"[\\s\\S]*?<\\/Annotations>/);
console.log('AdvocateTopics.ID @UI.Hidden:', m && m[0].includes('UI.Hidden') ? 'OK' : 'MISSING');
" EDMX_OUT="$EDMX_OUT"
```

### 5.3 — Post-deploy smoke

```bash
TOKEN=...    # admin XSUAA token
curl -s -H "Authorization: Bearer $TOKEN" "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/admin/\$metadata" \
  | grep -E "Insertable=\"false\"|UI.Hidden" \
  | head -10
```

### 5.4 — Manual UI verification (Tom)

After post-deploy smoke passes:

1. Open `/admin-ui/#advocates-display`, click your row → Topics tab:
   - Topic column shows the tag label (e.g. "BTP"), no GUID
   - No "ID" column
2. Identity tab → Linked User row shows your displayName (e.g. "Thomas Jung"), not "-"
3. Authored Tutorials + Contributed Tutorials facets: no Create button, no row delete button

## 6 — Tests

Annotation changes are tested at the EDMX level (§5.2). No unit tests for FE V4 render behavior.

**One regression test** added to [test/regression/admin-annotations.test.js](../../../test/regression/admin-annotations.test.js) (if it exists; otherwise create using existing EDMX-string-match tests under `test/regression/` or `test/unit/` as the pattern reference — grep for `cds.compile.to.edmx` callers to find one).

Concrete assertion shape:

```js
it('authoredTutorials + contributedTutorials disallow Insert/Update/Delete', async () => {
  const edmx = await cds.compile.to.edmx(cds.load('srv/admin-service.cds'));
  for (const nav of ['authoredTutorials', 'contributedTutorials']) {
    const block = edmx.match(
      new RegExp(`<Annotations Target="AdminService.Advocates/${nav}"[\\s\\S]*?</Annotations>`)
    );
    expect(block).toBeTruthy();
    expect(block[0]).toContain('Capabilities.InsertRestrictions');
    expect(block[0]).toContain('Capabilities.UpdateRestrictions');
    expect(block[0]).toContain('Capabilities.DeleteRestrictions');
  }
});

it('AdvocateTopics.ID is hidden from the LineItem', async () => {
  const edmx = await cds.compile.to.edmx(cds.load('srv/admin-service.cds'));
  const block = edmx.match(/<Annotations Target="AdminService\.AdvocateTopics\/ID"[\s\S]*?<\/Annotations>/);
  expect(block).toBeTruthy();
  expect(block[0]).toContain('UI.Hidden');
});
```

If no `test/regression/admin-annotations.test.js` exists, the plan creates it with these two `it()` blocks scaffolded inside one `describe('Advocate admin annotations (regression)', ...)` block.

**No backfill-script tests.** It's a one-shot SQL-equivalent; testing it would require fixturing the same data conditions, which the existing hybrid-test scaffolding doesn't have a clean shape for. Tom runs it once; SQL is shown above for review.

## 7 — Out of scope

- **Bug A1 (Topic GUID) is a data fix, not a code fix.** No CSV, no migration. Just `npm run seed-tag-labels`. If new tags are added later without labels, the same fix re-applies — that's a separate ticket about authoring workflow, not this PR.
- **Row-link navigation on Tutorials facets.** `@Common.SemanticObject: 'Tutorial'` would let admins drill into a listed tutorial from the Advocate page. Nice-to-have; deferred.
- **Tag.label admin UX.** If Tag.label remains null for many rows, admins editing tags one-by-one in the Tags Fiori app is the standard flow today. Bulk-edit value help is a separate ticket.
- **UI5 controller extension fallback for Fix C.** Only relevant if §4.4 + EDMX verify fails. Spec-level fallback documented; implementation deferred to v2.

## 8 — Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| FE V4 ignores `@Capabilities` on navigation property of an inverse Association | Medium | Medium | §5.2 EDMX check + §5.4 manual verify catch it; documented fallback in §4.4 |
| `seed-tag-labels` fetches all 10,523 tags and partially fills them, leaving Tom's specific tag still null | Low | Low | Tom can verify the specific tag GUID from the screenshot is in the seed; if not, manual UPDATE of one row |
| Backfill script writes `' '` (single space) for users with both firstName AND lastName null but not-null sapId | Low | Low | TRIM + the WHERE clause `firstName IS NOT NULL OR lastName IS NOT NULL` already skips those rows |
| Backfill races with concurrent JIT `backfillUserProfile` writes from a login that fires during the script | Low | Low | `displayName` SET is idempotent; both paths produce the same value |

## 9 — References

- Sibling spec: [2026-06-25-advocate-email-edit-design.md](2026-06-25-advocate-email-edit-design.md)
- Existing tag-label seeder: `scripts/seed-tag-labels.ts` (CLAUDE.md "Gotchas" section)
- cds-compiler annotation propagation: Feb 2025 release notes, "Annotating Managed Associations"
- PR #586's comment block at [app/admin-annotations.cds:2056-2077](../../../app/admin-annotations.cds#L2056-L2077) — historical context, no longer applies post-compiler-update
- Issue #638
