# Admin Tutorials — Owner Search & Filter Fix

**Date:** 2026-08-05
**Status:** Design — awaiting review
**Scope:** `srv/admin-service.cds`, `app/admin-annotations.cds` (+ manifest version bump)

## Problem

On the Admin UI **Tutorials** List Report
(`/admin-ui/#Tutorial-display`, a Fiori Elements List Report), finding all
tutorials for a given author/owner — one of the most common admin searches — does
not work:

1. **The toolbar search box never matches Owner.** `@cds.search` on
   `AdminService.Tutorials` (`srv/admin-service.cds:41`) is
   `{ title, slug, primaryTag, description }`. Owner is absent, so `$search`
   (→ HANA `CONTAINS`) structurally cannot match owner text.

2. **The Owner column filter rejects wildcard / contains.** The `Owner`
   SelectionField is the *association path* `meta.owner`
   (`app/admin-annotations.cds:632`) carrying a `@Common.ValueList` picklist
   (`TutorialOwnerPickList`). It renders as a pick-from-list equals control, not a
   free-text contains field, so wildcard typing does nothing useful.

### Root cause

"Owner" is free-text stored on a **separate** entity —
`TutorialMeta.owner : String(255)` — reached from `Tutorials` only via the `meta`
association. It was never wired for full-text search, and its filter goes through
an association path (fragile: association-path filters commonly only honor `eq`).

Ownership also increasingly lives on the modern **FK author** (`Tutorials.author →
Users`), surfaced as flattened scalar columns `authorDisplayName`, `authorEmail`,
`authorFirstName`, `authorLastName`, `authorSapId` (`srv/admin-service.cds:67–71`).
Those aren't searchable either.

## Decision (confirmed with Tom)

- **Full scope:** fix both the toolbar search box **and** the Owner column filter.
- **Cover both owner sources:** legacy free-text `TutorialMeta.owner` **and** the FK
  author name/email — so a search for a person reliably finds their tutorials
  whether ownership is recorded the old way or the new way.

## Approach

Reuse the **existing, proven flatten pattern**. In the AdminService projection
`meta` is already redefined as a **to-one Association** (`srv/admin-service.cds:45`),
so `meta.owner` flattens to a scalar exactly like `author.email as authorEmail`.

### 1. Flatten owner to a scalar column (`srv/admin-service.cds`)

Add to the `Tutorials` projection, alongside the flattened author columns:

```cds
meta.owner as owner : String @Common.FieldControl: #ReadOnly,
```

Derived, read-only, writes silently no-op (same semantics as the author flatten;
owner is source-content data, never edited here).

### 2. Widen `@cds.search` (`srv/admin-service.cds:41`)

```cds
@cds.search: { title, slug, primaryTag, description,
               owner, authorDisplayName, authorEmail, authorFirstName, authorLastName }
```

All are scalar string elements on the projection → each becomes a HANA `CONTAINS`
term. The toolbar search box now matches owner and author by name/email.

### 3. Make the Owner column filter contains-capable (`app/admin-annotations.cds`)

- Move the `@Common.ValueList` (→ `TutorialOwnerPickList`) from
  `AdminService.TutorialMeta.owner` onto the new flattened `Tutorials.owner`
  element, and label it `'Owner'`. Keep it a **plain** ValueList (NOT
  `@Common.ValueListWithFixedValues`) so free-text entry and `*` wildcards remain
  available while the dropdown still offers existing owners.
- In `@UI.SelectionFields`, replace `meta.owner` with the flattened scalar `owner`.
  A scalar String filter field supports the `contains` operator and `*` wildcards;
  this escapes the association-path filter limitation that blocked wildcards.
- In `@UI.LineItem` and `@UI.FieldGroup#General`, switch `{ Value: meta.owner }` to
  `{ Value: owner }` for consistency (same displayed value, no association hop).

The existing `TutorialOwnerPickList` (`srv/admin-service.cds:98`, distinct non-null
owners) is reused unchanged.

## What this deliberately does NOT do (YAGNI)

- No new entity, view, job, or CSV. Owner already exists; we only re-wire it.
- No change to the OP author facets or the `MyTutorialsByUserId` 4-source view.
- No custom `valueHelpRequest` handler — FE's stock string filter gives contains +
  wildcard once the field is a scalar. (Guards against the #1371 "custom VH ignores
  annotation" trap — we are NOT introducing a custom handler.)

## Testing

- **Unit** (`test/unit/`): assert `AdminService.Tutorials` metadata exposes `owner`
  and that `@cds.search` includes owner + author fields; a `$search=<ownername>`
  query over seeded data returns the expected tutorials.
- **Live verification (Tom's #1 rule):** exercise the real List Report in the
  browser via Playwright with Tom's session against DEV — (a) toolbar search for an
  owner's name returns their tutorials; (b) Owner column filter with `*partial*`
  returns contains-matches. Add/adjust a `test/e2e/` spec (advisory e2e nudge).

## Deploy notes

- Model change (`@cds.search` + projection) ⇒ **srv** rebuild. Annotations compile
  into `AdminService` `$metadata`, served by `tutorials-srv`.
- Bump admin Tutorials `sap.app.applicationVersion` (`app/admin/tutorials/webapp/manifest.json`,
  `0.0.2 → 0.0.3`) so FE's `ui5-cachemanager-db` IndexedDB metadata cache doesn't
  serve stale SelectionFields.
- Full `mbt build` + deploy from fresh `origin/main` (never `--skip-build`/`-m`),
  MTA patch bump. Confirm scope with Tom before `cf deploy`.

## Risk

Low. Additive: one derived column + a search-list widening + a filter field swap to
an equivalent scalar. No writes, no schema/table change, no migration. Fail modes
are cosmetic (blank owner cell if `meta` null — already the case).
