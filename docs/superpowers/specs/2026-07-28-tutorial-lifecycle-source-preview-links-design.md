# ACTIVE-only source & preview links on the Tutorials Lifecycle tab

**Date:** 2026-07-28
**Status:** Design approved, pending implementation plan
**Area:** Admin UI — Tutorials Object Page (`/admin-ui/#/tutorials`), Lifecycle facet

## Problem

When an admin views a tutorial's detail (Object Page) in the admin UI, the
Lifecycle group shows status/deletion/redirect/review fields but offers no
quick way to jump to the tutorial's source or its rendered previews. Admins
routinely need four destinations while triaging a tutorial:

1. The **source repo folder** on GitHub (where the canonical `.md` lives).
2. The **Contributions repo folder** on GitHub (the `-Contribution` fork used
   for author preview / QA content).
3. The **current QA preview** of the tutorial (author-preview channel).
4. The **live/main** rendered tutorial.

These links should appear **only when the tutorial is ACTIVE** — non-ACTIVE
(INACTIVE) tutorials have no meaningful live/QA rendering and their repo links
are noise.

## Goals

- Surface the four links inside the existing **Lifecycle** FieldGroup on the
  Tutorials Object Page.
- Render only for `status === 'ACTIVE'` rows.
- Human-friendly link text (not raw URLs).
- Environment-correct preview links (DEV admin → DEV tutorial, PROD → PROD).
- Zero new tables, no client-side fetch, no new custom controller — reuse the
  proven virtual-field + `after('READ')` pattern already in the codebase.

## Non-goals

- No validation that the GitHub folder / preview actually exists (links are
  best-effort; a 404 on click is acceptable and expected for edge cases).
- No changes to the List Report (links are Object-Page only).
- No new authorization surface — QA/main links are relative paths that inherit
  the existing approuter XSUAA scopes at click time.

## Existing patterns this builds on

The `#918 isolated` virtual field is the exact template:

- **Projection** (`srv/admin-service.cds:67`): `virtual isolated : Boolean` on
  the `AdminService.Tutorials` projection.
- **Population** (`srv/admin-service.js:463`): an `after('READ','Tutorials')`
  decorator batches a lookup and sets the field per row, **fail-quiet** — any
  throw leaves the field unset and Fiori renders nothing.
- **Annotation** (`app/admin-annotations.cds`): `@Common.Label` +
  `@Common.FieldControl: #ReadOnly` on the field, and a `UI.DataField*` entry
  in the FieldGroup/LineItem.

Authoritative repo mapping lives in **`RepoCatalog`**
(`db/schema.cds:561`, aspect `db/_content-shape.cds:88`): `slug → {owner, repo,
branch, visibility, ...}`, repopulated on every content publish by
`srv/lib/repo-catalog.js`. It is **not** currently projected onto
`AdminService`; this design reads it via raw SQL inside the decorator (no new
projection needed), matching the isolated handler's raw-SQL approach.

Status enum is `ACTIVE` / `INACTIVE` only (`db/schema.cds:16`).

## Design

### Data: 8 virtual fields on `AdminService.Tutorials`

Add to the projection at `srv/admin-service.cds` (next to `virtual isolated`):

```cds
virtual sourceRepoUrl    : String,
virtual sourceRepoLabel  : String,
virtual contribRepoUrl   : String,
virtual contribRepoLabel : String,
virtual qaPreviewUrl     : String,
virtual qaPreviewLabel   : String,
virtual mainPreviewUrl   : String,
virtual mainPreviewLabel : String
```

Each link needs both a URL and friendly display text (the label is what the
admin sees; the URL is where the link goes), hence 8 fields for 4 links.

### Population: `after('READ','Tutorials')` decorator

In `srv/admin-service.js`, add a **sibling** `after('READ','Tutorials')`
decorator (a second registration, kept separate from the isolated handler so
each stays single-purpose and independently fail-quiet). For each row:

1. Skip unless `row.status === 'ACTIVE'` — leave all 8 fields unset otherwise.
2. **QA + main links** depend only on the slug (no catalog needed):
   - `qaPreviewUrl   = '/tutorials-qa/' + slug`, `qaPreviewLabel = 'View QA Preview'`
   - `mainPreviewUrl = '/tutorials/' + slug`, `mainPreviewLabel = 'View Live Tutorial'`
3. **GitHub links** require a `RepoCatalog` row for the slug. Batch a single
   IN-clause raw SQL query over the ACTIVE slugs in the page (same shape as the
   isolated lookup) to fetch `SLUG, OWNER, REPO, BRANCH`. For each matched slug:
   - `owner  = row.OWNER || 'sap-tutorials'` (RepoCatalog owner may be null)
   - `repo   = row.REPO` (skip the two GitHub links entirely if repo is null/empty)
   - `branch = row.BRANCH || 'main'`
   - `sourceRepoUrl    = https://github.com/{owner}/{repo}/tree/{branch}/tutorials/{slug}`
   - `sourceRepoLabel  = {owner}/{repo}`
   - `contribRepoUrl   = https://github.com/{owner}/{repo}-Contribution/tree/{branch}/tutorials/{slug}`
   - `contribRepoLabel = {owner}/{repo}-Contribution`
4. **Fail-quiet**: wrap the RepoCatalog SELECT in try/catch; on any throw, log a
   warning and leave the GitHub fields unset. QA/main links are set before the
   catalog query so a catalog failure never suppresses them.

URL construction constants (base `https://github.com/`, path
`tutorials/{slug}`, `-Contribution` suffix) derive from the existing raw-URL in
`scripts/fetch-tutorials.ts:270` and the `-Contribution` convention in
`scripts/install-notify-workflows.ts`.

### Rendering: annotations in `app/admin-annotations.cds`

1. In the `annotate AdminService.Tutorials with { ... }` block, add
   `@Common.Label` + `@Common.FieldControl: #ReadOnly` for each of the 8 fields.

2. Append four `UI.DataFieldWithUrl` entries to the **final** (last-wins)
   `FieldGroup#Lifecycle` at `app/admin-annotations.cds:720-729`:

```cds
{ $Type: 'UI.DataFieldWithUrl', Value: sourceRepoLabel,  Url: sourceRepoUrl,  Label: 'Source Repo (GitHub)' },
{ $Type: 'UI.DataFieldWithUrl', Value: contribRepoLabel, Url: contribRepoUrl, Label: 'Contributions Repo (GitHub)' },
{ $Type: 'UI.DataFieldWithUrl', Value: qaPreviewLabel,   Url: qaPreviewUrl,   Label: 'QA Preview' },
{ $Type: 'UI.DataFieldWithUrl', Value: mainPreviewLabel, Url: mainPreviewUrl, Label: 'Live Tutorial' }
```

ACTIVE-only gating is achieved purely by the server leaving fields unset for
non-ACTIVE rows: `UI.DataFieldWithUrl` with a null `Url`/`Value` renders as an
empty cell (same degrade-to-nothing behavior the isolated flag relies on). No
`@UI.Hidden` expression required.

## Edge cases & testing

| Case | Expected |
|---|---|
| ACTIVE row, RepoCatalog entry present | all 8 fields set |
| INACTIVE row | all 8 fields unset (empty cells) |
| ACTIVE row, no RepoCatalog entry | GitHub links unset; QA + main still set (slug-only) |
| RepoCatalog owner null | owner falls back to `sap-tutorials` |
| RepoCatalog repo null/empty | both GitHub links unset; QA + main still set |
| RepoCatalog branch null | branch falls back to `main` |
| RepoCatalog SELECT throws | GitHub links unset, warning logged; QA + main still set; no request-time throw |

Tests:

- **Unit** (`test/unit/` or `srv/lib/__tests__/`): drive the decorator (or a
  small extracted pure URL-builder helper) over the cases above. Prefer
  extracting a pure `buildTutorialLinks({ status, slug, owner, repo, branch })`
  helper so the URL logic is unit-testable without a DB round-trip; the
  decorator calls it per row.
- **Admin-annotations regression**: the existing `$metadata` pin test must gain
  the 8 new fields.
- Run `npx cds deploy --to sqlite::memory:` before commit (runtime-only
  `@assert.unique` guard per global rules) and `npm test`.

## Deploy considerations

- Touches admin annotations + the admin projection → per `CLAUDE.md`, deploy
  with a **full** `npm run deploy -- --env <env>` (NO `--skip-build`, NO `-m`
  scoping) so the approuter admin bundle + `$metadata` are rebuilt.
- Bump `applicationVersion` in
  `app/admin/tutorials/webapp/manifest.json` so the UI5
  `ui5-cachemanager-db` IndexedDB fragment cache is busted and the new fields
  actually appear post-deploy (a hard reload alone does not clear it).

## Files touched

- `srv/admin-service.cds` — 8 virtual fields on the Tutorials projection.
- `srv/admin-service.js` — populate the 8 fields in `after('READ','Tutorials')`.
- `srv/lib/tutorial-links.js` (new) — pure URL-builder helper (testable).
- `app/admin-annotations.cds` — labels/field-control + 4 DataFieldWithUrl rows.
- `app/admin/tutorials/webapp/manifest.json` — applicationVersion bump.
- Tests: new unit test for the helper; update admin-annotations `$metadata` pin.
