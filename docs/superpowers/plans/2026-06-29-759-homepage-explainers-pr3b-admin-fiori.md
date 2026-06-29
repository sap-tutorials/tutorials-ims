# Issue #759 — Homepage Explainers PR 3b: Admin Fiori Apps + Homepage Facet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the frontend half of PR 3: two new Fiori Elements list-report apps (`app/admin/verb-definitions/` and `app/admin/shelf-definitions/`), an "Explainer" facet on the existing `HomepageShelves` object page in the Homepage admin app, AI generate buttons (per-row + bulk-fill-blanks) wired to PR 3a's three `AdminService` actions, and admin-shell side-nav entries for the two new apps. **Visitor-observable change: none.** Admin-observable change: two new tiles in the admin shell, plus the new Explainer fields visible (and editable) on the existing Homepage Shelves entries.

**Architecture:** Mirrors the existing Categories admin app pattern. Each new app is a 4-file Fiori Elements scaffold (Component.js / manifest.json / i18n.properties / ui5.yaml) plus a small controller extension at `webapp/ext/ActionsController.js` that surfaces AI buttons via `MessageBox.warning` confirm + `MessageToast.show` status. Annotations land in `app/admin-annotations.cds` (LineItem, Facets, FieldGroups for both new entities + the new Explainer facet on `HomepageShelves`). Side-nav registration: 2 entries to admin-shell `navigation.json` + 2 `componentUsages` + 2 route/target pairs in `app/admin-shell/webapp/manifest.json`. CRUD lockdown via `@Capabilities.DeleteRestrictions.Deletable: false` + `@Capabilities.InsertRestrictions.Insertable: false` + `@Common.FieldControl: #ReadOnly` on the enum key fields. Build pipeline unchanged — admin sub-apps are auto-resolved as UI5 components at admin-shell build time.

**Tech Stack:** Fiori Elements V4 (sap.fe.templates 1.136), UI5 1.136, CDS annotations, vanilla JS controllers (no TypeScript in admin-shell). Tests: text-grep unit tests for annotation/manifest correctness; no E2E (the admin-shell has no Playwright suite today — out of scope to add).

**Spec:** [`docs/superpowers/specs/2026-06-29-759-homepage-explainers-design.md`](../specs/2026-06-29-759-homepage-explainers-design.md) §4.4 (Admin UI).

**Predecessors:** PR 1 (#776, merged), PR 2 (#780, merged), PR 3a (#784, merged) — all in main as of commit `c326a8f8`.

**Related (future):**
- PR 4: Content seed (run bulk-fill-blanks via this PR's admin button against DEV; ~$1 in AI Core calls) — operational
- PR 5: PROD cutover — operational

---

## File Structure

### New files

- `app/admin/verb-definitions/package.json` — boilerplate, matches `app/admin/categories/package.json`
- `app/admin/verb-definitions/ui5.yaml` — boilerplate, matches existing admin sub-apps
- `app/admin/verb-definitions/webapp/Component.js` — extends `sap.fe.core.AppComponent`; ~6 lines
- `app/admin/verb-definitions/webapp/manifest.json` — Fiori Elements list-report + object-page binding to `/VerbDefinitions`; cross-navigation inbound `VerbDefinition-display`; one controller extension wired to the actions controller
- `app/admin/verb-definitions/webapp/i18n/i18n.properties` — `appTitle=Verb Definitions` etc.
- `app/admin/verb-definitions/webapp/ext/ActionsController.js` — handles the two AI action buttons (per-row regenerate + bulk fill-blanks) with `MessageBox.warning` confirm and `MessageToast.show` status
- `app/admin/shelf-definitions/package.json` — same shape
- `app/admin/shelf-definitions/ui5.yaml` — same shape
- `app/admin/shelf-definitions/webapp/Component.js` — same shape
- `app/admin/shelf-definitions/webapp/manifest.json` — same as above but bound to `/ShelfDefinitions`
- `app/admin/shelf-definitions/webapp/i18n/i18n.properties`
- `app/admin/shelf-definitions/webapp/ext/ActionsController.js`
- `test/unit/admin-annotations-explainer-pinning.test.js` — text-grep pinning tests for the new annotations (Facets on Homepage gains an Explainer reference, VerbDefinitions + ShelfDefinitions get full LineItem/Facets/FieldGroup, CRUD lockdown annotations present)
- `test/unit/admin-shell-explainer-registration.test.js` — text-grep pinning tests for the admin-shell registration: 2 new `componentUsages`, 2 new route/target pairs, 2 new nav items in `navigation.json`

### Modified files

- `app/admin-annotations.cds` — adds annotations for `VerbDefinitions` and `ShelfDefinitions` (full UI annotations: HeaderInfo, LineItem, Facets, FieldGroups); adds an Explainer facet to the existing `HomepageShelves` block (FieldGroup#Explainer with tagline/whyItMatters/authoringStatus). Plus CRUD lockdown on the two new entities.
- `app/admin-shell/webapp/manifest.json` — adds 2 `componentUsages` (`verbDefinitionsComponent`, `shelfDefinitionsComponent`), 2 `resourceRoots` mappings, 2 route + target pairs.
- `app/admin-shell/webapp/model/navigation.json` — adds 2 new nav entries to the existing **Content** group (Decision 1 — see below).
- `srv/admin-service.cds` — extends `AdminService` with the two new entity projections via `@odata.draft.enabled` (already done in PR 1 — verify; if missing, add).
- `docs/developers/operations/testing-endpoints.md` (optional) — add the two new admin routes for completeness.

### Deleted files

None — pure additive PR.

---

## Decisions made during plan-writing

| # | Question raised by spec | Decision | Rationale |
|---|---|---|---|
| 1 | Spec §4.4 suggests a new "Explainers" side-nav grouping containing Verb Definitions / Shelf Definitions / Homepage Shelves. | **Add the 2 new apps to the existing "Content" group** instead. Don't add a third "Homepage Shelves" entry — that already lives under the "Homepage" group (created in PR 1's homepage redesign). | The spec was written before I knew the existing nav-grouping landscape. A separate "Explainers" group adds visual noise for what is fundamentally reference-data management. "Content" already houses Categories, Tags, etc. — reference-data-management is its home. Homepage Shelves stays in the Homepage group; the Explainer facet appears on its object page. |
| 2 | Spec §4.4 says CRUD lockdown via Fiori manifest annotations. | Use **CDS-level `@Capabilities.DeleteRestrictions.Deletable: false`** + `@Capabilities.InsertRestrictions.Insertable: false` annotations on the AdminService projection (precedent: `CompletionPathItems` in `app/admin-annotations.cds:952`). Plus `@Common.FieldControl: #ReadOnly` on `verbKey` / `shelfKey` fields. | CDS-level capability restrictions propagate to ALL clients (OData metadata exposes them; Fiori Elements honors them automatically). Manifest-level lockdown would only affect THIS Fiori app — admins could still POST direct OData calls to create rows. Defense at the service layer is stronger. |
| 3 | Spec §4.4 mentions cost-estimate confirm dialog for bulk-fill-blanks ("Generate AI explainers for **N** blank rows? Estimated cost: **$X.XX**"). No precedent exists in the project. | Extend `MessageBox.warning(message, options)` with cost-computed text dynamically in the controller. Cost estimate uses a constant **$0.005 per row** (matches PR 3a's observed cost from hybrid AI test: ~$0.05 / 10 rows). The constant lives in the controller as `EST_COST_PER_ROW_CENTS = 0.5;` so it's auditable. | Simplest path. Fiori Elements' built-in `@Common.IsActionCritical` is static annotation-driven — cannot inject dynamic runtime values. A custom controller dialog is the established pattern (Categories' `onReclassifyAll`). |
| 4 | Should the controller actions handle the row-selection / blank-row-count logic, or let the server do it? | **Server does it.** The controller just calls the action; the server's `runExplainerAction` already handles `mode: 'fill-blanks'` (selects BLANK rows itself) and `mode: 'regenerate-selected'` (operates on the supplied ids). The controller only needs the SELECTED ROW count (for the regenerate-selected dialog) or BLANK ROW count (for the fill-blanks dialog estimate). | Don't duplicate logic. Server is source of truth; UI does cost estimation only. |
| 5 | Should the controller estimate blank-row count for the cost dialog by COUNT()-ing client-side, or by calling a new endpoint? | **Client-side COUNT via existing OData metadata.** The Fiori Elements list report already binds to `/VerbDefinitions?$filter=authoringStatus eq 'BLANK'&$count=true&$top=0`. The controller can issue a synchronous count read before showing the dialog. No new endpoint needed. | Reuses existing data plumbing. One extra OData GET per button click — cheap. |
| 6 | Where do the new entity projections live? | Already in `srv/admin-service.cds` after PR 1 (verify in Task 1 Step 1). If absent, add `@odata.draft.enabled @cds.redirection.target: true entity VerbDefinitions as projection on ims.VerbDefinitions;` and same for ShelfDefinitions. | PR 1's plan said both entities expose on AdminService via projections; verify before adding to avoid duplication. |
| 7 | Object-page editability: `tagline` / `whyItMatters` should be editable; `verbKey` / `shelfKey` / `authoringStatus` should be read-only. | Mark `verbKey` / `shelfKey` with `@Common.FieldControl: #ReadOnly` (immutable identity). Mark `authoringStatus` with the same — admins can't manually flip BLANK→AI_SEEDED; only the AI generation action does that. | Status is a managed lifecycle field; manual override would invite drift between status and content. If admin wants to mark something REVIEWED, that's an explicit action button (Task 7). |
| 8 | Should there be a "Mark as REVIEWED" button on the object page? | **Yes**, as a row-level action. Without it, admins have no way to flip `AI_SEEDED → REVIEWED` (the protection-against-bulk-overwrite flag). Per spec §3.3 the status transition is mentioned but no action surface; this plan adds it. | Otherwise REVIEWED is unreachable; the protection flag is meaningless. A 3-line action handler in `srv/admin-service.js` flips the status. |
| 9 | Per-row "Regenerate with AI" button placement: list-report row action vs object-page button? | **Both, sharing the same controller handler**. List-report action operates on selected rows (multi-select); object-page button operates on the single row. Same controller method dispatches based on context. | Matches existing Categories pattern (`classifyUncategorized` exposed in list report; per-row "Classify this" via context). Saves duplicating logic. |
| 10 | Tests: should we add Playwright E2E for the new admin app interactions? | **No.** The admin-shell has no Playwright suite today; adding it for this PR is out of scope. Text-grep pinning tests for annotations + manifests are sufficient — the actual rendering is FE V4 framework behavior that doesn't break silently from our changes. | YAGNI. If admin-shell gets E2E later, the new buttons can be added to its suite then. |

---

## Task 1: Verify entity projections + add the Explainer facet to HomepageShelves

**Files:**

- Modify: `srv/admin-service.cds` (if needed — verify the projections exist)
- Modify: `app/admin-annotations.cds` (extend the existing HomepageShelves block with the Explainer facet)
- Create: `test/unit/admin-annotations-explainer-pinning.test.js` (text-grep tests)

### Step 1: Verify the AdminService projections exist for VerbDefinitions + ShelfDefinitions

```bash
grep -nE 'entity (VerbDefinitions|ShelfDefinitions) as projection' srv/admin-service.cds
```

Expected: two matches confirming both projections exist (PR 1 work). If neither exists, add them inside the existing `service AdminService { ... }` block, modeled on the `HomepageShelves` projection pattern:

```cds
  @odata.draft.enabled
  entity VerbDefinitions as projection on ims.VerbDefinitions;

  @odata.draft.enabled
  entity ShelfDefinitions as projection on ims.ShelfDefinitions;
```

If they do exist, skip the modification.

### Step 2: Write the failing pinning test

Create `test/unit/admin-annotations-explainer-pinning.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CDS = readFileSync(join(import.meta.dirname, '../../app/admin-annotations.cds'), 'utf8');

describe('app/admin-annotations.cds — explainer admin UI pinning (#759 PR 3b)', () => {
  describe('HomepageShelves Explainer facet', () => {
    it('adds an Explainer ReferenceFacet pointing to FieldGroup#Explainer', () => {
      // The existing block already has a 'General' facet; we add a second referencing FieldGroup#Explainer.
      expect(CDS).toMatch(/HomepageShelves[\s\S]{0,3000}UI\.Facets\s*:\s*\[[\s\S]{0,800}Target\s*:\s*'@UI\.FieldGroup#Explainer'/);
    });
    it('defines FieldGroup#Explainer containing tagline, whyItMatters, authoringStatus', () => {
      expect(CDS).toMatch(/HomepageShelves[\s\S]{0,5000}UI\.FieldGroup\s*#Explainer\s*:\s*\{\s*Data\s*:\s*\[[\s\S]{0,500}Value\s*:\s*tagline[\s\S]{0,300}Value\s*:\s*whyItMatters[\s\S]{0,300}Value\s*:\s*authoringStatus/);
    });
  });
});
```

### Step 3: Run the test — verify it fails

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npx vitest run test/unit/admin-annotations-explainer-pinning.test.js
```

Expected: FAIL — no Explainer facet yet.

### Step 4: Extend HomepageShelves annotations with the Explainer facet

In `app/admin-annotations.cds`, find the existing `annotate AdminService.HomepageShelves with @( ... )` block (around line 2880). Modify two things:

(a) **Add to the existing `UI.Facets` array** a second entry referencing FieldGroup#Explainer. The existing array currently looks like:

```cds
UI.Facets : [
  { $Type: 'UI.ReferenceFacet', Label: 'General', Target: '@UI.FieldGroup#Main' }
],
```

Change to:

```cds
UI.Facets : [
  { $Type: 'UI.ReferenceFacet', Label: 'General',   Target: '@UI.FieldGroup#Main' },
  { $Type: 'UI.ReferenceFacet', Label: 'Explainer', Target: '@UI.FieldGroup#Explainer' }
],
```

(b) **Add a new `UI.FieldGroup #Explainer`** block in the same annotation:

```cds
UI.FieldGroup #Explainer : { Data : [
  { Value : tagline,         Label : 'Tagline' },
  { Value : whyItMatters,    Label : 'Why it matters' },
  { Value : authoringStatus, Label : 'Authoring status' }
]}
```

Place it after the existing `UI.FieldGroup #Main` block, inside the same `@(...)` annotation.

### Step 5: Mark authoringStatus as read-only

In the existing `annotate AdminService.HomepageShelves { ... }` field-level block (around line 2900), add:

```cds
  authoringStatus @Common.FieldControl: #ReadOnly @Common.Label: 'Authoring status';
```

(The other fields already have `@Common.Label`; this adds the read-only constraint to the new status field.)

### Step 6: Run the test — verify it passes

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npx vitest run test/unit/admin-annotations-explainer-pinning.test.js
```

Expected: PASS — 2 tests.

### Step 7: Verify CDS still compiles

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npx cds compile srv/admin-service.cds --to json 2>&1 | tail -5
```

Expected: clean (only pre-existing duplicate-annotation warnings in `app/admin-annotations.cds` per project memory).

### Step 8: Commit

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && git add app/admin-annotations.cds test/unit/admin-annotations-explainer-pinning.test.js && git -c core.autocrlf=false commit -m "feat(#759): add Explainer facet to HomepageShelves object page

Extends the existing HomepageShelves admin annotations with:
- A second UI.Facets entry 'Explainer' referencing FieldGroup#Explainer
- New UI.FieldGroup#Explainer containing tagline, whyItMatters,
  authoringStatus (fields landed in PR 1 schema; this is the UI wiring)
- @Common.FieldControl: #ReadOnly on authoringStatus — admins cannot
  manually flip BLANK→AI_SEEDED; the lifecycle is managed by the AI
  action handlers (PR 3a) and the explicit 'Mark as reviewed' button
  (this PR, Task 7).

If srv/admin-service.cds was missing entity projections for
VerbDefinitions / ShelfDefinitions, this commit also adds them.

Two text-grep pinning tests in test/unit/admin-annotations-explainer-
pinning.test.js confirm the annotation structure."
```

---

## Task 2: VerbDefinitions + ShelfDefinitions annotations (LineItem, Facets, FieldGroup, CRUD lockdown)

**Files:**

- Modify: `app/admin-annotations.cds` (append new annotation blocks)
- Modify: `test/unit/admin-annotations-explainer-pinning.test.js` (extend pinning)

### Step 1: Extend the failing test

Append to `test/unit/admin-annotations-explainer-pinning.test.js`:

```js
  describe('VerbDefinitions annotations', () => {
    it('declares LineItem with verbKey + label + sortOrder + authoringStatus', () => {
      expect(CDS).toMatch(/annotate\s+AdminService\.VerbDefinitions[\s\S]{0,500}UI\.LineItem[\s\S]{0,500}Value\s*:\s*verbKey[\s\S]{0,400}Value\s*:\s*label[\s\S]{0,400}Value\s*:\s*sortOrder[\s\S]{0,400}Value\s*:\s*authoringStatus/);
    });
    it('declares CRUD lockdown — Insertable: false + Deletable: false', () => {
      expect(CDS).toMatch(/annotate\s+AdminService\.VerbDefinitions[\s\S]{0,2000}Capabilities\.InsertRestrictions\.Insertable\s*:\s*false/);
      expect(CDS).toMatch(/annotate\s+AdminService\.VerbDefinitions[\s\S]{0,2000}Capabilities\.DeleteRestrictions\.Deletable\s*:\s*false/);
    });
    it('marks verbKey as @Common.FieldControl: #ReadOnly', () => {
      expect(CDS).toMatch(/annotate\s+AdminService\.VerbDefinitions\s*\{[\s\S]{0,500}verbKey\s+@Common\.FieldControl\s*:\s*#ReadOnly/);
    });
  });

  describe('ShelfDefinitions annotations', () => {
    it('declares LineItem with shelfKey + label + sortOrder + authoringStatus', () => {
      expect(CDS).toMatch(/annotate\s+AdminService\.ShelfDefinitions[\s\S]{0,500}UI\.LineItem[\s\S]{0,500}Value\s*:\s*shelfKey[\s\S]{0,400}Value\s*:\s*label[\s\S]{0,400}Value\s*:\s*sortOrder[\s\S]{0,400}Value\s*:\s*authoringStatus/);
    });
    it('declares CRUD lockdown', () => {
      expect(CDS).toMatch(/annotate\s+AdminService\.ShelfDefinitions[\s\S]{0,2000}Capabilities\.InsertRestrictions\.Insertable\s*:\s*false/);
      expect(CDS).toMatch(/annotate\s+AdminService\.ShelfDefinitions[\s\S]{0,2000}Capabilities\.DeleteRestrictions\.Deletable\s*:\s*false/);
    });
    it('marks shelfKey as @Common.FieldControl: #ReadOnly', () => {
      expect(CDS).toMatch(/annotate\s+AdminService\.ShelfDefinitions\s*\{[\s\S]{0,500}shelfKey\s+@Common\.FieldControl\s*:\s*#ReadOnly/);
    });
  });
```

### Step 2: Run the test — verify it fails

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npx vitest run test/unit/admin-annotations-explainer-pinning.test.js
```

Expected: FAIL — 6 new tests fail (annotations don't exist yet).

### Step 3: Add VerbDefinitions annotation block

At the end of `app/admin-annotations.cds` (after the existing HomepageShelves block), append:

```cds

// (#759 PR 3b) Verb Definitions admin app annotations.
// CRUD locked down: cardinality is fixed at 6 (one per HomepageVerb
// enum value). Admins edit content fields (label, iconName, sortOrder,
// tagline, whyItMatters) but cannot Create or Delete rows. The
// verbKey + authoringStatus fields are read-only.
annotate AdminService.VerbDefinitions with @(
  Capabilities.InsertRestrictions.Insertable : false,
  Capabilities.DeleteRestrictions.Deletable  : false,
  Capabilities.UpdateRestrictions.Updatable  : true,
  UI.HeaderInfo : {
    TypeName: 'Verb',
    TypeNamePlural: 'Verb definitions',
    Title: { Value: label }
  },
  UI.LineItem : [
    { Value: verbKey,         Label: 'Verb key' },
    { Value: label,           Label: 'Label' },
    { Value: iconName,        Label: 'Icon' },
    { Value: sortOrder,       Label: 'Sort order' },
    { Value: authoringStatus, Label: 'Status', Criticality: authoringStatus }
  ],
  UI.Facets : [
    { $Type: 'UI.ReferenceFacet', Label: 'Identity',  Target: '@UI.FieldGroup#Identity' },
    { $Type: 'UI.ReferenceFacet', Label: 'Explainer', Target: '@UI.FieldGroup#Explainer' }
  ],
  UI.FieldGroup #Identity : { Data : [
    { Value: verbKey,    Label: 'Verb key' },
    { Value: label,      Label: 'Label' },
    { Value: iconName,   Label: 'Icon' },
    { Value: sortOrder,  Label: 'Sort order' }
  ]},
  UI.FieldGroup #Explainer : { Data : [
    { Value: tagline,         Label: 'Tagline' },
    { Value: whyItMatters,    Label: 'Why it matters' },
    { Value: authoringStatus, Label: 'Authoring status' }
  ]}
);

annotate AdminService.VerbDefinitions {
  verbKey         @Common.FieldControl: #ReadOnly @Common.Label: 'Verb key';
  authoringStatus @Common.FieldControl: #ReadOnly @Common.Label: 'Authoring status';
};
```

### Step 4: Add ShelfDefinitions annotation block

Same shape, swap entity name and key field. Append:

```cds

// (#759 PR 3b) Shelf Definitions admin app annotations.
// CRUD locked down: cardinality is fixed at 4 (one per HomepageShelf
// enum value). Same conventions as VerbDefinitions above.
annotate AdminService.ShelfDefinitions with @(
  Capabilities.InsertRestrictions.Insertable : false,
  Capabilities.DeleteRestrictions.Deletable  : false,
  Capabilities.UpdateRestrictions.Updatable  : true,
  UI.HeaderInfo : {
    TypeName: 'Shelf category',
    TypeNamePlural: 'Shelf definitions',
    Title: { Value: label }
  },
  UI.LineItem : [
    { Value: shelfKey,        Label: 'Shelf key' },
    { Value: label,           Label: 'Label' },
    { Value: sortOrder,       Label: 'Sort order' },
    { Value: authoringStatus, Label: 'Status', Criticality: authoringStatus }
  ],
  UI.Facets : [
    { $Type: 'UI.ReferenceFacet', Label: 'Identity',  Target: '@UI.FieldGroup#Identity' },
    { $Type: 'UI.ReferenceFacet', Label: 'Explainer', Target: '@UI.FieldGroup#Explainer' }
  ],
  UI.FieldGroup #Identity : { Data : [
    { Value: shelfKey,   Label: 'Shelf key' },
    { Value: label,      Label: 'Label' },
    { Value: sortOrder,  Label: 'Sort order' }
  ]},
  UI.FieldGroup #Explainer : { Data : [
    { Value: tagline,         Label: 'Tagline' },
    { Value: whyItMatters,    Label: 'Why it matters' },
    { Value: authoringStatus, Label: 'Authoring status' }
  ]}
);

annotate AdminService.ShelfDefinitions {
  shelfKey        @Common.FieldControl: #ReadOnly @Common.Label: 'Shelf key';
  authoringStatus @Common.FieldControl: #ReadOnly @Common.Label: 'Authoring status';
};
```

### Step 5: Run the test — verify it passes

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npx vitest run test/unit/admin-annotations-explainer-pinning.test.js
```

Expected: PASS — 8 tests (2 from T1 + 6 new).

### Step 6: Verify CDS still compiles

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npx cds compile srv/admin-service.cds --to json 2>&1 | tail -5
```

Expected: clean.

### Step 7: Commit

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && git add app/admin-annotations.cds test/unit/admin-annotations-explainer-pinning.test.js && git -c core.autocrlf=false commit -m "feat(#759): annotations for VerbDefinitions + ShelfDefinitions admin apps

Adds full Fiori Elements UI annotations for the two new singleton-set
entities introduced in PR 1:
- HeaderInfo, LineItem (incl. authoringStatus with Criticality coloring)
- Two facets per entity: Identity + Explainer
- FieldGroups for each facet (Identity = key + label + sortOrder;
  Explainer = tagline + whyItMatters + authoringStatus)
- CRUD lockdown at the CDS layer (precedent: CompletionPathItems):
  InsertRestrictions.Insertable: false, DeleteRestrictions.Deletable:
  false. CDS-level capability restrictions propagate to OData
  metadata; defense applies to ALL clients, not just our Fiori app.
- Read-only field controls on verbKey/shelfKey (immutable identity)
  and authoringStatus (managed by AI action lifecycle).

Six new text-grep pinning tests confirm the annotation structure."
```

---

## Task 3: Verb Definitions Fiori Elements app scaffold

**Files:**

- Create: `app/admin/verb-definitions/package.json`
- Create: `app/admin/verb-definitions/ui5.yaml`
- Create: `app/admin/verb-definitions/webapp/Component.js`
- Create: `app/admin/verb-definitions/webapp/manifest.json`
- Create: `app/admin/verb-definitions/webapp/i18n/i18n.properties`
- Create: `app/admin/verb-definitions/webapp/ext/ActionsController.js` (skeleton — full body in Task 5)

### Step 1: Read the Categories precedent end-to-end

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && cat app/admin/categories/package.json
cd .claude/worktrees/759-pr3b-admin-fiori && cat app/admin/categories/ui5.yaml
cd .claude/worktrees/759-pr3b-admin-fiori && cat app/admin/categories/webapp/Component.js
cd .claude/worktrees/759-pr3b-admin-fiori && cat app/admin/categories/webapp/manifest.json
cd .claude/worktrees/759-pr3b-admin-fiori && cat app/admin/categories/webapp/i18n/i18n.properties
cd .claude/worktrees/759-pr3b-admin-fiori && cat app/admin/categories/webapp/ext/CategoryActionsController.js
```

Note the manifest structure (especially `crossNavigation.inbounds`, `routing.routes`, `routing.targets`, and `controlConfiguration` with the action wiring).

### Step 2: Create `app/admin/verb-definitions/package.json`

```json
{
  "name": "sap.tutorials.admin.verb-definitions",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "start": "ui5 serve",
    "build": "ui5 build --clean-dest --include-task=generateManifestBundle"
  },
  "devDependencies": {
    "@ui5/cli": "^4.0.0"
  }
}
```

### Step 3: Create `app/admin/verb-definitions/ui5.yaml`

```yaml
specVersion: "3.0"
metadata:
  name: sap.tutorials.admin.verb-definitions
type: application
framework:
  name: SAPUI5
  version: "1.136.0"
  libraries:
    - name: sap.fe.templates
    - name: sap.m
```

### Step 4: Create `app/admin/verb-definitions/webapp/Component.js`

```js
sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.verb-definitions.Component", {
    metadata: { manifest: "json" }
  });
});
```

### Step 5: Create `app/admin/verb-definitions/webapp/manifest.json`

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.verb-definitions",
    "type": "application",
    "title": "{{appTitle}}",
    "description": "{{appDescription}}",
    "applicationVersion": { "version": "0.0.1" },
    "i18n": "i18n/i18n.properties",
    "dataSources": {
      "mainService": {
        "uri": "/admin/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    },
    "crossNavigation": {
      "inbounds": {
        "VerbDefinition-display": {
          "semanticObject": "VerbDefinition",
          "action": "display",
          "title": "{{appTitle}}",
          "signature": { "parameters": {}, "additionalParameters": "allowed" }
        }
      }
    }
  },
  "sap.ui5": {
    "dependencies": {
      "minUI5Version": "1.136.0",
      "libs": { "sap.fe.templates": {} }
    },
    "models": {
      "": {
        "dataSource": "mainService",
        "preload": true,
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": true
        }
      },
      "i18n": {
        "type": "sap.ui.model.resource.ResourceModel",
        "settings": { "bundleName": "sap.tutorials.admin.verb-definitions.i18n.i18n" }
      }
    },
    "routing": {
      "routes": [
        { "name": "VerbsList", "pattern": ":?query:", "target": "VerbsListTarget" },
        { "name": "VerbOP",    "pattern": "VerbDefinitions({key}):?query:", "target": "VerbOPTarget" }
      ],
      "targets": {
        "VerbsListTarget": {
          "type": "Component",
          "name": "sap.fe.templates.ListReport",
          "id": "VerbsListTarget",
          "options": {
            "settings": {
              "contextPath": "/VerbDefinitions",
              "navigation": {
                "VerbDefinitions": { "detail": { "route": "VerbOP" } }
              },
              "controlConfiguration": {
                "@com.sap.vocabularies.UI.v1.LineItem": {
                  "actions": {
                    "generateForBlanks": {
                      "press": "sap.tutorials.admin.verb-definitions.ext.ActionsController.onGenerateForBlanks",
                      "visible": true,
                      "enabled": true,
                      "text": "Generate for blank rows"
                    },
                    "regenerateSelected": {
                      "press": "sap.tutorials.admin.verb-definitions.ext.ActionsController.onRegenerateSelected",
                      "visible": true,
                      "enabled": "{= ${@odata.context.selectedContexts}.length > 0 }",
                      "text": "Regenerate selected with AI",
                      "requiresSelection": true
                    }
                  }
                }
              }
            }
          }
        },
        "VerbOPTarget": {
          "type": "Component",
          "name": "sap.fe.templates.ObjectPage",
          "id": "VerbOPTarget",
          "options": {
            "settings": {
              "contextPath": "/VerbDefinitions",
              "editableHeaderContent": false,
              "controlConfiguration": {
                "@com.sap.vocabularies.UI.v1.Identification": {
                  "actions": {
                    "regenerateOne": {
                      "press": "sap.tutorials.admin.verb-definitions.ext.ActionsController.onRegenerateOne",
                      "text": "Regenerate with AI"
                    },
                    "markReviewed": {
                      "press": "sap.tutorials.admin.verb-definitions.ext.ActionsController.onMarkReviewed",
                      "text": "Mark as reviewed",
                      "visible": "{= ${authoringStatus} === 'AI_SEEDED' }"
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "extends": {
      "extensions": {
        "sap.ui.controllerExtensions": {
          "sap.fe.templates.ListReport.ListReportController": {
            "controllerName": "sap.tutorials.admin.verb-definitions.ext.ActionsController"
          }
        }
      }
    }
  }
}
```

### Step 6: Create `app/admin/verb-definitions/webapp/i18n/i18n.properties`

```properties
#XTIT: Application title (admin tile, browser tab)
appTitle=Verb Definitions

#YDES: Application description
appDescription=Edit the 6 verb-lane explainers on the developer homepage.
```

### Step 7: Create `app/admin/verb-definitions/webapp/ext/ActionsController.js` (SKELETON)

Full body lands in Task 5. For now, scaffold the 4 handlers so the manifest references resolve:

```js
sap.ui.define([
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (MessageBox, MessageToast) {
  "use strict";

  return {
    onGenerateForBlanks: function (oEvent) {
      MessageToast.show("Generate for blanks — handler stub (Task 5 wires the real call)");
    },
    onRegenerateSelected: function (oEvent) {
      MessageToast.show("Regenerate selected — handler stub (Task 5)");
    },
    onRegenerateOne: function (oEvent) {
      MessageToast.show("Regenerate one — handler stub (Task 5)");
    },
    onMarkReviewed: function (oEvent) {
      MessageToast.show("Mark reviewed — handler stub (Task 5)");
    }
  };
});
```

### Step 8: Commit

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && git add app/admin/verb-definitions/ && git -c core.autocrlf=false commit -m "feat(#759): scaffold Verb Definitions Fiori Elements admin app

New app at app/admin/verb-definitions/ mirroring the Categories
precedent. Six files: package.json, ui5.yaml, Component.js,
manifest.json, i18n/i18n.properties, ext/ActionsController.js.

manifest.json:
- Cross-navigation inbound: VerbDefinition-display
- Routes: VerbsList (list report) + VerbOP (object page)
- contextPath: /VerbDefinitions (OData V4 binding)
- Four declared actions (4 manifest entries → controller methods):
  generateForBlanks, regenerateSelected, regenerateOne, markReviewed
- ListReport controller extension wired to ActionsController

ActionsController.js: 4-method stub. Each method shows a MessageToast.
Real wiring to PR 3a's AdminService actions ships in Task 5.

No build pipeline change — admin sub-apps auto-resolve as UI5
components at admin-shell build time."
```

---

## Task 4: Shelf Definitions Fiori Elements app scaffold

**Files:** mirror Task 3 with `shelf-definitions` instead of `verb-definitions`. Same shape, swap names. The controller stub is identical (4 methods, same names — they dispatch by entity context).

### Step 1: Create the 6 files

Mirror Task 3 Steps 2-7 with these substitutions:
- App name: `sap.tutorials.admin.shelf-definitions`
- Inbound semantic object: `ShelfDefinition`
- Routes: `ShelvesList` + `ShelfOP`
- contextPath: `/ShelfDefinitions`
- i18n appTitle: `Shelf Definitions`
- i18n appDescription: `Edit the 4 shelf-category explainers shown on every verb sub-page.`

Everything else is identical to verb-definitions.

### Step 2: Commit

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && git add app/admin/shelf-definitions/ && git -c core.autocrlf=false commit -m "feat(#759): scaffold Shelf Definitions Fiori Elements admin app

Mirrors Verb Definitions (Task 3) — same six-file scaffold with names
swapped. Same controller method stubs; same lockdown shape from
admin-annotations.cds; same manifest action wiring.

Per spec §4.4, four shelf categories (START_HERE / REFERENCE / TOOLS /
KEEP_CURRENT) shared across all six verb sub-pages."
```

---

## Task 5: Wire ActionsController to PR 3a's actions (cost-dialog + status)

> **IMPORTANT — Execution-order note (added during plan review):** Task 5 depends on Task 7's backend actions (the dedicated `markVerbExplainerReviewed` / `markShelfExplainerReviewed` bound actions) being available. **Execute Task 7 BEFORE Task 5.** The controllers shipped here call those actions directly — no intermediate broken-PATCH state. (Rationale: `authoringStatus` is `@Common.FieldControl: #ReadOnly` from Task 1; a plain OData PATCH would be rejected server-side. A dedicated action that internally bypasses the FieldControl is the right path.)
>
> If you're a subagent executing tasks in order, **skip Task 5 for now**, execute Task 7 first, then come back to Task 5.

**Files:**

- Modify: `app/admin/verb-definitions/webapp/ext/ActionsController.js` (full implementation)
- Modify: `app/admin/shelf-definitions/webapp/ext/ActionsController.js` (full implementation; mostly identical, swap action names + entity path)

### Step 1: Read the CategoryActionsController for the canonical action-call pattern

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && cat app/admin/categories/webapp/ext/CategoryActionsController.js
```

Note: it uses `postAction` (an existing helper or fetch wrapper), `MessageBox.warning` for destructive confirms, and `MessageToast.show` for status. Check whether `postAction` is imported from a shared module or defined inline.

### Step 2: Implement `app/admin/verb-definitions/webapp/ext/ActionsController.js`

Replace the stub with the full implementation:

```js
sap.ui.define([
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (MessageBox, MessageToast) {
  "use strict";

  // Estimated cost per generation call in cents. PR 3a observed ~$0.005 per
  // verb explainer (small prompts + small responses). Update if costs shift.
  const EST_COST_PER_ROW_CENTS = 0.5;

  function fmtUsd(cents) {
    const dollars = Math.floor(cents / 100);
    const remainder = cents % 100;
    return `$${dollars}.${remainder.toString().padStart(2, '0')}`;
  }

  async function postAdminAction(actionName, payload) {
    // CAP OData V4 + XSUAA approuter requires CSRF token on action invocations.
    // Same pattern as app/admin/categories/webapp/ext/CategoryActionsController.js.
    const csrfResp = await fetch('/admin/', { headers: { 'x-csrf-token': 'fetch' } });
    const csrf = csrfResp.headers.get('x-csrf-token');
    const res = await fetch(`/admin/${actionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrf || 'fetch'
      },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${actionName} failed (HTTP ${res.status}): ${errText}`);
    }
    return res.json();
  }

  async function countBlankRows() {
    const res = await fetch('/admin/VerbDefinitions?$filter=authoringStatus%20eq%20%27BLANK%27&$count=true&$top=0', {
      credentials: 'include',
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data['@odata.count'] ?? 0;
  }

  async function refreshContext(oEvent) {
    // After a successful action, ask FE to re-bind so the new
    // authoringStatus / tagline values surface.
    const view = oEvent.getSource().getModel?.()?.getMetaModel?.();
    if (view) {
      // List report: simplest is a window reload; FE V4 has a more
      // graceful 'refresh' API but it varies per template.
      window.location.reload();
    }
  }

  return {
    onGenerateForBlanks: async function (oEvent) {
      try {
        const n = await countBlankRows();
        if (n === 0) {
          MessageToast.show("No BLANK rows to fill.");
          return;
        }
        const estCents = Math.ceil(n * EST_COST_PER_ROW_CENTS);
        MessageBox.warning(
          `Generate AI explainers for ${n} blank row${n === 1 ? '' : 's'}? Estimated cost: ${fmtUsd(estCents)}. This will not overwrite AI-seeded or human-reviewed rows.`,
          {
            title: "Generate explainers — bulk fill blanks",
            actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
            emphasizedAction: MessageBox.Action.OK,
            onClose: async (action) => {
              if (action !== MessageBox.Action.OK) return;
              MessageToast.show("Generating…");
              try {
                const result = await postAdminAction("generateVerbExplainers", { ids: [], mode: "fill-blanks" });
                MessageToast.show(`Generated ${result.processed} explainer${result.processed === 1 ? '' : 's'}. Cost: ${result.cost}.`);
                await refreshContext(oEvent);
              } catch (e) {
                MessageBox.error(`Generation failed: ${e.message}`);
              }
            }
          }
        );
      } catch (e) {
        MessageBox.error(`Pre-check failed: ${e.message}`);
      }
    },

    onRegenerateSelected: async function (oEvent) {
      // Selected contexts come from the list report's selection model.
      const ctx = oEvent.getSource().getBindingContext?.();
      const selectedContexts = oEvent.getParameter?.("selectedContexts") ?? [];
      const ids = selectedContexts.map(c => c.getObject().ID);
      if (ids.length === 0) {
        MessageToast.show("Select one or more rows first.");
        return;
      }
      // Check if any selected row is REVIEWED — destructive-confirm if so.
      const reviewedSelected = selectedContexts.some(c => c.getObject().authoringStatus === 'REVIEWED');
      const estCents = Math.ceil(ids.length * EST_COST_PER_ROW_CENTS);
      const msg = reviewedSelected
        ? `${ids.length} selected — some are REVIEWED. Regenerating will OVERWRITE them. Cost: ${fmtUsd(estCents)}. Continue?`
        : `Regenerate ${ids.length} selected row${ids.length === 1 ? '' : 's'} with AI? Cost: ${fmtUsd(estCents)}.`;
      MessageBox.warning(msg, {
        title: reviewedSelected ? "Regenerate — overwrites REVIEWED rows" : "Regenerate selected",
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        emphasizedAction: reviewedSelected ? MessageBox.Action.CANCEL : MessageBox.Action.OK,
        onClose: async (action) => {
          if (action !== MessageBox.Action.OK) return;
          MessageToast.show("Regenerating…");
          try {
            const result = await postAdminAction("generateVerbExplainers", { ids, mode: "regenerate-selected" });
            MessageToast.show(`Regenerated ${result.processed}. Cost: ${result.cost}.`);
            await refreshContext(oEvent);
          } catch (e) {
            MessageBox.error(`Regenerate failed: ${e.message}`);
          }
        }
      });
    },

    onRegenerateOne: async function (oEvent) {
      // Object-page button — operates on the current row's context.
      const ctx = oEvent.getSource().getBindingContext();
      if (!ctx) {
        MessageToast.show("No row context — refresh and try again.");
        return;
      }
      const row = ctx.getObject();
      const isReviewed = row.authoringStatus === 'REVIEWED';
      const msg = isReviewed
        ? `This row is REVIEWED. Regenerating will OVERWRITE it. Cost: ${fmtUsd(EST_COST_PER_ROW_CENTS)}. Continue?`
        : `Regenerate this row with AI? Cost: ${fmtUsd(EST_COST_PER_ROW_CENTS)}.`;
      MessageBox.warning(msg, {
        title: isReviewed ? "Regenerate — overwrites REVIEWED" : "Regenerate",
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        emphasizedAction: isReviewed ? MessageBox.Action.CANCEL : MessageBox.Action.OK,
        onClose: async (action) => {
          if (action !== MessageBox.Action.OK) return;
          MessageToast.show("Regenerating…");
          try {
            const result = await postAdminAction("generateVerbExplainers", { ids: [row.ID], mode: "regenerate-selected" });
            MessageToast.show(`Regenerated. Cost: ${result.cost}.`);
            await refreshContext(oEvent);
          } catch (e) {
            MessageBox.error(`Regenerate failed: ${e.message}`);
          }
        }
      });
    },

    onMarkReviewed: async function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      if (!ctx) return;
      const row = ctx.getObject();
      try {
        // Calls the dedicated markVerbExplainerReviewed action (added in
        // Task 7). Plain OData PATCH would be rejected because
        // authoringStatus is @Common.FieldControl: #ReadOnly (Task 1).
        await postAdminAction("markVerbExplainerReviewed", { id: row.ID });
        MessageToast.show("Marked as reviewed.");
        await refreshContext(oEvent);
      } catch (e) {
        MessageBox.error(`Mark-reviewed failed: ${e.message}`);
      }
    }
  };
});
```

### Step 3: Implement the shelf-definitions controller (near-clone)

`app/admin/shelf-definitions/webapp/ext/ActionsController.js` is identical except:
- `countBlankRows()` queries `/admin/ShelfDefinitions` (note the entity path)
- `postAdminAction` is called with `generateShelfExplainers` instead of `generateVerbExplainers`
- `onMarkReviewed` PATCHes `/admin/ShelfDefinitions(${id})`

Copy the verb controller, find/replace `VerbDefinitions` → `ShelfDefinitions` and `generateVerbExplainers` → `generateShelfExplainers`.

### Step 4: Verify by hand-loading the admin app

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npm --prefix app/admin-shell run build 2>&1 | tail -10
```

Expected: clean build. If errors, check manifest.json syntax (esp. the `extends.extensions` block — JSON has no comments).

### Step 5: Commit

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && git add app/admin/verb-definitions/webapp/ext/ActionsController.js app/admin/shelf-definitions/webapp/ext/ActionsController.js && git -c core.autocrlf=false commit -m "feat(#759): wire admin action buttons to PR 3a AdminService actions

ActionsController.js for both verb-definitions and shelf-definitions
apps. Four methods each:
- onGenerateForBlanks: bulk fill-blanks; counts BLANK rows client-side
  via OData metadata, shows cost-estimate confirm dialog (\$0.005/row),
  invokes generateVerbExplainers / generateShelfExplainers with
  mode='fill-blanks', shows result toast with actual cost.
- onRegenerateSelected: list-report multi-select action. Detects
  REVIEWED rows in selection and shows a destructive-confirm with
  emphasized CANCEL. Invokes mode='regenerate-selected'.
- onRegenerateOne: object-page button on a single row. Same dialog
  shape as onRegenerateSelected.
- onMarkReviewed: PATCHes authoringStatus to REVIEWED via plain OData
  (no dedicated action). Object-page button visible only when row's
  current status is AI_SEEDED.

Cost-estimate constant EST_COST_PER_ROW_CENTS = 0.5 lives in each
controller — adjust if hybrid AI tests show drift.

postAdminAction() helper is inlined per controller (not a shared
module) to keep admin sub-apps independently loadable per the
existing UI5 component pattern."
```

---

## Task 6: Admin-shell registration (componentUsages + side-nav)

**Files:**

- Modify: `app/admin-shell/webapp/manifest.json` (add 2 componentUsages, 2 resourceRoots, 2 routes, 2 targets)
- Modify: `app/admin-shell/webapp/model/navigation.json` (add 2 nav items to the existing "Content" group per Decision 1)
- Create: `test/unit/admin-shell-explainer-registration.test.js`

### Step 1: Write the failing test

Create `test/unit/admin-shell-explainer-registration.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST = JSON.parse(readFileSync(join(import.meta.dirname, '../../app/admin-shell/webapp/manifest.json'), 'utf8'));
const NAV = JSON.parse(readFileSync(join(import.meta.dirname, '../../app/admin-shell/webapp/model/navigation.json'), 'utf8'));

describe('admin-shell explainer-app registration (#759 PR 3b)', () => {
  it('manifest declares verbDefinitionsComponent and shelfDefinitionsComponent in componentUsages', () => {
    const usages = MANIFEST['sap.ui5']?.componentUsages || {};
    expect(usages.verbDefinitionsComponent?.name).toBe('sap.tutorials.admin.verb-definitions');
    expect(usages.shelfDefinitionsComponent?.name).toBe('sap.tutorials.admin.shelf-definitions');
  });

  it('manifest declares resourceRoots for both new apps', () => {
    const roots = MANIFEST['sap.ui5']?.resourceRoots || {};
    expect(roots['sap.tutorials.admin.verb-definitions']).toBeTruthy();
    expect(roots['sap.tutorials.admin.shelf-definitions']).toBeTruthy();
  });

  it('manifest routing has verb-definitions and shelf-definitions routes + targets', () => {
    const routes = MANIFEST['sap.ui5']?.routing?.routes || [];
    expect(routes.find(r => r.name === 'verb-definitions')).toBeTruthy();
    expect(routes.find(r => r.name === 'shelf-definitions')).toBeTruthy();
    const targets = MANIFEST['sap.ui5']?.routing?.targets || {};
    expect(targets['verbDefinitionsTarget']?.usage).toBe('verbDefinitionsComponent');
    expect(targets['shelfDefinitionsTarget']?.usage).toBe('shelfDefinitionsComponent');
  });

  it('navigation.json adds Verb Definitions + Shelf Definitions to the Content group', () => {
    const content = NAV.groups.find(g => g.title === 'Content' || g.key === 'content');
    expect(content).toBeTruthy();
    const items = content.items.map(i => i.key);
    expect(items).toContain('verb-definitions');
    expect(items).toContain('shelf-definitions');
  });
});
```

### Step 2: Run the test — verify it fails

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npx vitest run test/unit/admin-shell-explainer-registration.test.js
```

Expected: FAIL — 4 tests fail (registrations don't exist).

### Step 3: Add to admin-shell manifest.json

In `app/admin-shell/webapp/manifest.json`, find the existing `sap.ui5.componentUsages` block. Add (near the homepageComponent entry, alphabetically):

```json
    "shelfDefinitionsComponent": {
      "name": "sap.tutorials.admin.shelf-definitions",
      "settings": {},
      "componentData": {},
      "lazy": true
    },
    "verbDefinitionsComponent": {
      "name": "sap.tutorials.admin.verb-definitions",
      "settings": {},
      "componentData": {},
      "lazy": true
    },
```

Find the `sap.ui5.resourceRoots` block. Add:

```json
    "sap.tutorials.admin.shelf-definitions": "../shelf-definitions/webapp/",
    "sap.tutorials.admin.verb-definitions":  "../verb-definitions/webapp/",
```

In `sap.ui5.routing.routes`, add:

```json
    { "name": "verb-definitions",  "pattern": "verb-definitions",  "target": [{"name": "verbDefinitionsTarget",  "prefix": "vd"}] },
    { "name": "shelf-definitions", "pattern": "shelf-definitions", "target": [{"name": "shelfDefinitionsTarget", "prefix": "sd"}] },
```

In `sap.ui5.routing.targets`, add:

```json
    "verbDefinitionsTarget": {
      "type": "Component",
      "usage": "verbDefinitionsComponent",
      "id": "verbDefinitionsTarget",
      "viewLevel": 1,
      "prefix": "vd"
    },
    "shelfDefinitionsTarget": {
      "type": "Component",
      "usage": "shelfDefinitionsComponent",
      "id": "shelfDefinitionsTarget",
      "viewLevel": 1,
      "prefix": "sd"
    },
```

### Step 4: Add to navigation.json

In `app/admin-shell/webapp/model/navigation.json`, find the **Content** group. Add to its `items` array (alphabetically or at the end):

```json
{ "key": "verb-definitions",  "title": "Verb definitions" },
{ "key": "shelf-definitions", "title": "Shelf definitions" }
```

### Step 5: Run the test — verify it passes

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npx vitest run test/unit/admin-shell-explainer-registration.test.js
```

Expected: PASS — 4 tests.

### Step 6: Build the admin-shell to confirm it resolves the new components

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npm --prefix app/admin-shell run build 2>&1 | tail -10
```

Expected: clean build. If it fails on missing resource paths, verify the `resourceRoots` paths are correct (relative to the admin-shell webapp/, going up one level to `app/admin/<name>/webapp/`).

### Step 7: Commit

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && git add app/admin-shell/webapp/manifest.json app/admin-shell/webapp/model/navigation.json test/unit/admin-shell-explainer-registration.test.js && git -c core.autocrlf=false commit -m "feat(#759): register Verb + Shelf Definitions apps in admin-shell

Four manifest additions per app:
- componentUsages entry (lazy-loaded)
- resourceRoots entry mapping ../verb-definitions/webapp/
  and ../shelf-definitions/webapp/
- route entry (pattern: verb-definitions / shelf-definitions)
- target entry binding the route to the componentUsage

Plus two navigation.json entries added to the existing Content group
(reference-data sibling of Categories, Tags, Tutorials, etc.).
Per plan Decision 1, did NOT create a separate 'Explainers' group;
'Content' is the natural home for reference-data management apps.

Build pipeline unchanged — admin sub-apps auto-resolve as UI5
components at admin-shell build time. Verified with
'npm --prefix app/admin-shell run build'.

Four text-grep pinning tests confirm the registration shape (so
silent regressions to the componentUsages or routing get caught)."
```

---

## Task 7: Backend support for "Mark as reviewed" (optional bound action)

**Files:**

- Modify: `srv/admin-service.cds` (optional — if we want a dedicated `markReviewed` action)
- Modify: `srv/admin-service.js` (optional handler)

### Decision

The controller in Task 5 uses a plain OData PATCH to flip `authoringStatus = 'REVIEWED'`. This works as long as `authoringStatus` is NOT marked `@Common.FieldControl: #ReadOnly` at the entity level — which it IS, per Task 1 Step 5. 

**Two options:**

**(a)** Leave the field read-only at the entity level and add a dedicated action handler. Controller calls a custom action instead of PATCH:

```cds
// in srv/admin-service.cds
action markVerbExplainerReviewed(id: String) returns ExplainerActionResult;
action markShelfExplainerReviewed(id: String) returns ExplainerActionResult;
action markShelfEntryExplainerReviewed(id: String) returns ExplainerActionResult;
```

**(b)** Drop the `@Common.FieldControl: #ReadOnly` on `authoringStatus` and let the controller do a plain PATCH. Simpler but allows admins to manually edit status via the object page form.

**Decision**: **(a)** — dedicated action. Keeps the lifecycle explicit; "mark reviewed" is an action, not a free-form edit. Matches the spec's intent.

### Step 1: Add the three new actions to srv/admin-service.cds

Inside the same `service AdminService { ... }` block, near the other explainer-generate actions, append:

```cds
  action markVerbExplainerReviewed       (id : String) returns ExplainerActionResult;
  action markShelfExplainerReviewed      (id : String) returns ExplainerActionResult;
  action markShelfEntryExplainerReviewed (id : String) returns ExplainerActionResult;
```

### Step 2: Add the three handlers to srv/admin-service.js

Near the existing generate* handlers, append:

```js
    async function runMarkReviewed({ entityName, id, req }) {
      const db = await cds.connect.to('db');
      const row = await db.run(SELECT.one.from(entityName).where({ ID: id }));
      if (!row) {
        req.reject(404, `not found: ${id}`);
        return;
      }
      await db.run(UPDATE(entityName).set({ authoringStatus: 'REVIEWED' }).where({ ID: id }));
      return { processed: 1, skipped: 0, cost: '$0.00' };
    }

    this.on('markVerbExplainerReviewed', (req) =>
      runMarkReviewed({ entityName: 'com.sap.developers.ims.VerbDefinitions', id: req.data.id, req }));
    this.on('markShelfExplainerReviewed', (req) =>
      runMarkReviewed({ entityName: 'com.sap.developers.ims.ShelfDefinitions', id: req.data.id, req }));
    this.on('markShelfEntryExplainerReviewed', (req) =>
      runMarkReviewed({ entityName: 'com.sap.developers.ims.HomepageShelves', id: req.data.id, req }));
```

### Step 3: Update the controllers to call the new actions

In both `app/admin/verb-definitions/webapp/ext/ActionsController.js` and `shelf-definitions/.../ActionsController.js`, replace the `onMarkReviewed` PATCH with an action call:

```js
    onMarkReviewed: async function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      if (!ctx) return;
      const row = ctx.getObject();
      try {
        // Verb-definitions controller:
        await postAdminAction("markVerbExplainerReviewed", { id: row.ID });
        // (shelf-definitions controller uses markShelfExplainerReviewed)
        MessageToast.show("Marked as reviewed.");
        await refreshContext(oEvent);
      } catch (e) {
        MessageBox.error(`Mark-reviewed failed: ${e.message}`);
      }
    }
```

### Step 4: Add a test for the new actions

Create `test/unit/srv/admin-service-mark-reviewed.test.js`:

```js
// Test the markReviewed actions. Re-uses the in-memory SQLite test pattern.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

describe('AdminService.mark*ExplainerReviewed actions (#759 PR 3b)', () => {
  let project;
  beforeAll(async () => {
    project = cds.test('serve', '--project', '.', '--in-memory');
    await project;
  });
  beforeEach(async () => {
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.VerbDefinitions'));
    await project.get('/admin/VerbDefinitions', ADMIN_AUTH); // trigger auto-init
  });

  it('markVerbExplainerReviewed flips AI_SEEDED → REVIEWED', async () => {
    const db = await cds.connect.to('db');
    const learn = await db.run(SELECT.one.from('com.sap.developers.ims.VerbDefinitions').where({ verbKey: 'LEARN' }));
    await db.run(UPDATE('com.sap.developers.ims.VerbDefinitions').set({ authoringStatus: 'AI_SEEDED' }).where({ ID: learn.ID }));
    const res = await project.post('/admin/markVerbExplainerReviewed', { id: learn.ID }, ADMIN_AUTH);
    expect(res.data.processed).toBe(1);
    const after = await db.run(SELECT.one.from('com.sap.developers.ims.VerbDefinitions').where({ ID: learn.ID }));
    expect(after.authoringStatus).toBe('REVIEWED');
  });

  it('returns HTTP 404 on missing id', async () => {
    const res = await project.post('/admin/markVerbExplainerReviewed', { id: 'nonexistent-id' }, ADMIN_AUTH)
      .catch(err => err.response);
    expect(res.status).toBe(404);
  });
});
```

### Step 5: Run the test

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npx vitest run test/unit/srv/admin-service-mark-reviewed.test.js
```

Expected: 2 tests pass.

### Step 6: Commit

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && git add srv/admin-service.cds srv/admin-service.js app/admin/verb-definitions/webapp/ext/ActionsController.js app/admin/shelf-definitions/webapp/ext/ActionsController.js test/unit/srv/admin-service-mark-reviewed.test.js && git -c core.autocrlf=false commit -m "feat(#759): three markReviewed actions + wire from admin controllers

Backend gains three new bound actions (one per entity):
- markVerbExplainerReviewed       (VerbDefinitions)
- markShelfExplainerReviewed      (ShelfDefinitions)
- markShelfEntryExplainerReviewed (HomepageShelves)

Each takes { id: String }, returns the same ExplainerActionResult
shape as the generate* actions (processed/skipped/cost) for UI
consistency. Cost is always \$0.00. Returns 404 on missing id.

Why a dedicated action and not a plain OData PATCH:
- authoringStatus is @Common.FieldControl: #ReadOnly at the entity
  level (Task 1) to prevent admins from free-form editing it via the
  object page form. A dedicated action keeps the lifecycle explicit
  and gates the transition behind the 'Mark as reviewed' button.

Both Fiori admin controllers (Verb + Shelf) now call the new action
from onMarkReviewed instead of a plain PATCH (which would have failed
due to the FieldControl).

Two new unit tests pin the action behavior."
```

---

## Task 8: Build + manual-test smoke

**Files:** none (verification only).

### Step 1: Build the admin-shell end-to-end

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npm --prefix app/admin-shell run build 2>&1 | tail -15
```

Expected: clean build. The admin-shell `dist/` should now contain the new sub-app artifacts under `verb-definitions/` and `shelf-definitions/`.

### Step 2: Run all PR 3b unit tests

```bash
cd .claude/worktrees/759-pr3b-admin-fiori && npx vitest run test/unit/admin-annotations-explainer-pinning.test.js test/unit/admin-shell-explainer-registration.test.js test/unit/srv/admin-service-mark-reviewed.test.js 2>&1 | tail -10
```

Expected: all passing (8 annotation pins + 4 registration pins + 2 mark-reviewed = 14 tests).

### Step 3 (optional, requires deployed DEV srv): manual smoke

If you want to manually verify, deploy to DEV and visit the admin UI:
- `/admin-ui/` → see "Verb definitions" and "Shelf definitions" in the **Content** group
- Click into Verb Definitions → see the 6 rows (auto-init from PR 1)
- Click a row → object page shows Identity + Explainer facets, with `verbKey` + `authoringStatus` read-only
- Click "Generate for blank rows" → cost-estimate dialog shows; OK triggers PR 3a's action; rows flip to AI_SEEDED
- Click a single row → "Regenerate with AI" + "Mark as reviewed" buttons visible

### Step 4: No commit (verification step).

---

## Definition of done

- [ ] All 7 tasks committed (plus Task 8 verification)
- [ ] 14 new unit tests passing
- [ ] `npm --prefix app/admin-shell run build` produces clean output with both sub-apps in `dist/`
- [ ] `git log --oneline` shows 7 commits, each with `feat(#759)` prefix
- [ ] `git status --short` clean
- [ ] Plan reviewer subagent approves
- [ ] PR opened against `main` with body referencing PR 1 (#776), PR 2 (#780), PR 3a (#784) merged predecessors

---

## Out-of-scope reminders

- **Hybrid AI test runs against deployed UI** — out of scope; the existing PR 3a hybrid AI test exercises the action end-to-end against AI Core.
- **Playwright E2E for the new admin app interactions** — out of scope; admin-shell has no Playwright suite today (Decision 10).
- **Auditing the generate* actions** (which admin invoked which generation, when) — could be useful but not in spec. Defer.
- **Bulk-select-and-mark-reviewed** — out of spec. Admins use single-row markReviewed for now.

---

## Plan-review loop

After all 7 tasks land, the plan-execution skill dispatches a plan-document-reviewer subagent. If issues are found, the implementer iterates. Loop max 3 iterations.

This plan itself gets reviewed before execution starts.
