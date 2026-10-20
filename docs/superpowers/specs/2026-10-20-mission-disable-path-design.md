# Mission "Temporarily Unavailable" toggle — design

**Issue:** [sap-tutorials/tutorials-ims#2864](https://github.com/sap-tutorials/tutorials-ims/issues/2864)
**Date:** 2026-10-20
**Author:** design captured by Claude with Tom

## Intent and why

When a mission (path) breaks or needs maintenance, there is currently no fast way
to pull it out of circulation short of unpublishing it. Unpublishing is a heavier,
SuperAdmin-guarded action with publish semantics; it also fully removes the mission.
Operators want a **reactive quick-disable**: flip one switch in the Mission Editor so
the mission stops being promoted, its card shows "Temporarily Unavailable", and its
links to child path items disappear — while the content itself stays reachable so
anyone mid-path (or with a direct link) can still read it.

The moment this serves: "a path is down or broken, and we need it out of the way in
seconds, then back just as fast once it's fixed."

## What it does (behavior)

A new per-mission boolean, **`temporarilyUnavailable`** (default `false`), with an
optional free-text **`unavailableReason`**. When `true`:

1. **Card badge** — the mission card shows a "Temporarily Unavailable" badge/label.
   Mission cards render on **`/browse/`** and **`/tutorial-navigator/`** only; the
   homepage `/` renders no mission cards, so it is out of scope. (Decided with Tom.)
2. **Links removed** — the mission's child path-item links (the tutorials/groups it
   points to) are suppressed from card/navigator navigation, so the path can't be
   entered through the normal links.
3. **Content stays visible** — the mission's own detail page still loads at its direct
   URL. Disabling is about promotion/linking, not deletion. (Decided with Tom.)

When `false`, everything behaves exactly as today.

Set **manually** via an on/off toggle in the Admin UI Mission Editor. **No scheduled
window** — this is a reactive maintenance switch, not a calendar feature. (Decided with
Tom; a scheduled window can be added later if ever needed.)

**Propagation is rebuild-gated** (decided with Tom). `Missions` is `@odata.draft.enabled`,
so disabling is edit-draft → activate, and the badge + link removal take effect on the
**next content rebuild** (the `gh workflow run rebuild-content.yml` path, ~2–10 min) —
the same way every other mission edit propagates to the baked site. This is NOT a
near-instant runtime toggle; near-instant was explicitly deferred as out of scope.

This is orthogonal to `published`: a mission must still be `published: true` to appear
at all; `temporarilyUnavailable` is an additional gate applied to already-published
missions.

## Goals

- One-switch disable/enable from the Mission Editor, takes effect on the next content
  rebuild/catalog refresh.
- Disabled mission's card is clearly badged "Temporarily Unavailable" (on `/browse/`
  and `/tutorial-navigator/`).
- Disabled mission's child path-item links are removed from navigation.
- Disabled mission's own content page still loads by direct URL.
- Optional operator-facing reason note stored alongside the flag.

## Non-goals

- No scheduled / timed auto-re-enable.
- No change to `published` semantics or its SuperAdmin guard.
- No disabling at the individual tutorial or group level (mission-path level only, per
  the issue title).
- No end-user notification/email, no analytics event for disable.

## Anti-goals (would make this a failure even if it "works")

- Making the disabled mission's content **inaccessible** by direct URL — the issue is
  explicit that content remains visible. A hard block is wrong.
- Coupling this to the publish workflow such that disabling unpublishes, or such that
  re-enabling requires SuperAdmin. Quick-disable must be quick.
- Letting a disabled mission still surface its child links anywhere (card meta,
  navigator, mission-detail feed) — that defeats the "pull it out of circulation" point.

## Constraints

- CAP Node.js + CDS; model change lands in `db/schema.cds` on `Missions`.
- Admin UI is Fiori Elements driven by annotations in `app/admin-annotations.cds`; a new
  editable field surfaces by adding a `@Common.Label` and a `FieldGroup`/`LineItem` entry
  — no manifest change needed for a plain field.
- Mission cards have **two parallel implementations kept in sync by a parity test**: the
  Hugo SSR partial `hugo/layouts/partials/browse/_partials/card-mission.html` and the Vue
  source `hugo-apps/src/shared/cards/MissionCard.vue`. The parity test compares *after*
  canonicalization (not literal byte-equivalence), and a regenerated fixture
  (`card-mission.expected.html`) backs it — both templates plus the fixture change
  together.
- The baked SSR cards and the hydrated Vue cards both read `hugo/data/browse.json`, built
  at fetch time by `scripts/fetch-tutorials.ts` (`buildAllCards`/`writeBrowseData`). The
  flag must flow through *that* build-time assembly — NOT `/build/catalog`, which feeds a
  different (navigator/hydration) path. The mission-detail feed
  (`srv/lib/branch/mission-detail.js`) and the two navigator link paths
  (`db/views.cds` `NavigatorCatalog` + `srv/lib/navigator-catalog.js` nested-group loop)
  are the link-suppression touch points.
- `temporarilyUnavailable` must be writable by a normal admin (not gated like
  `published`), so quick-disable stays quick.

## The "how" decided so far

- **Field name:** `temporarilyUnavailable : Boolean default false;` plus
  `unavailableReason : String(500);` on `Missions` in `db/schema.cds` (matching the
  `deletionReason : String(500)` sibling on `TaskBase`).
- **Card source — the correct file.** The baked SSR mission cards are NOT built from
  `/build/catalog`. They are assembled at build time by `buildAllCards()` in
  `scripts/fetch-tutorials.ts` (mission cards at ~`:2204–2230`) → `writeBrowseData()`
  (~`:2276–2316`) → `hugo/data/browse.json`, which is what **both** card templates read
  (SSR partial inlines it; Vue hydrates from it). `build-catalog.js` feeds the
  `/build/navigator` + hydration path, not the card payload. **So the flag must be
  carried into the mission source that `fetch-tutorials.ts` reads and added to the
  mission-card object it pushes** — this is a build-time fetch-pipeline change, not a
  `build-catalog.js` change.
- **Badge WITHOUT stripping display fields.** A mission card's `primaryTag`, `level`,
  `time`, and `tutorialCount` are derived from its child tutorials
  (`fetch-tutorials.ts:2220–2223`). Link suppression must NOT empty the child set used to
  compute those, or the card loses its tag/level/count. Suppress the *navigation links*,
  keep the derived display fields, and add the badge flag as a separate card property.
- **Link suppression — two navigator paths.** `db/views.cds` `NavigatorCatalog`
  (`:76–95`) gates only on `mission.published = true`; AND `srv/lib/navigator-catalog.js`
  has a second link-producing path — the nested-group loop (~`:196–288`, re-queries
  `CompletionPathItems where taskType='GROUP'`, filters only by `published:true` ~`:223`).
  **Both** must also filter out `temporarilyUnavailable` missions, or a disabled
  mission's nested-group child links still leak (violates the anti-goal).
- **Mission detail feed:** `srv/lib/branch/mission-detail.js` loads the mission by slug
  and does NOT gate on published — it emits the child `items[]`. For a disabled mission it
  should emit `items: []` (or an `unavailable` marker) so the page shell stays reachable
  but offers no onward links. This is the correct "content visible, links suppressed"
  point.
- **Badge:** net-new label element added to **both** card templates, shown when
  `temporarilyUnavailable` is truthy. Copy: "Temporarily Unavailable". Reuse an existing
  chip/tag pattern (`card-category-chip` / `nav-card__tag`) where it fits.
- **Card parity is NOT byte-equivalent.** The parity test
  (`hugo-apps/src/browse/__tests__/card-template-parity.test.ts`) compares *after*
  canonicalization (strips `data-v-*`, HTML comments, normalizes `&middot;`, collapses
  whitespace). There is also a fixture (`fixtures/card-mission.expected.html`) regenerated
  via `tools/regen-card-parity-fixtures.sh` — the builder must **regen the fixture**, not
  just edit the test.
- **Admin UI:** add the toggle + reason to the Mission Editor via `app/admin-annotations.cds`
  (`@Common.Label`, `FieldGroup#General`, and a `LineItem` column). Field flows
  automatically through the `*` projection at `srv/admin-service.cds:152`. A normal Admin
  can write it — the publish guard `_guardPublished` (`srv/admin-service.js:2473–2501`) is
  field-specific to `published` and does not touch the new field, so quick-disable stays
  quick with no extra work.

## Relationship to automated link-health (not a conflict)

`Missions` already composes a `LinkHealth` aspect (`db/schema.cds:29–33`) with
job-written `linkStatus` (OK/SLOW/BROKEN) and an admin-pinned `linkStatusOverride` from
the url-health-check job (#2787). That is the *automated* "is this path's content
reachable" signal. `temporarilyUnavailable` is deliberately a separate *manual, reactive*
operator switch — it does not read or write link-health, and a broken `linkStatus` does
not auto-set it. Kept distinct on purpose.

## Left to the builder

- Whether the badge also appears on the mission's own detail-page header (issue only
  requires the card badge; builder's call, lean minimal).
- Precise CSS/markup for the badge within existing `nav-card` styling.
- The exact field the flag rides on into `fetch-tutorials.ts` (the mission source /
  `Mission` type it reads) — builder traces it and adds the property at the minimal layer.
- Test coverage: unit test for the suppressed-links + badge-flag card output, navigator
  nested-group suppression, mission-detail empty-items, and the regen'd parity fixture;
  follow existing patterns.

## Key file touch points (from codebase recon)

| Concern | File:line |
|---|---|
| `Missions` entity / new field | `db/schema.cds:69–95` (next to `published` at `:88`) |
| Admin projection (auto `*`) | `srv/admin-service.cds:152` |
| Admin UI field/column annotations | `app/admin-annotations.cds` (Missions block ~`:117–212`) |
| Publish guard (field-specific, untouched) | `srv/admin-service.js:2473–2501` |
| **Card source (SSR + Vue read this)** | `scripts/fetch-tutorials.ts` (mission cards ~`:2204–2230`, `writeBrowseData` ~`:2276–2316`) → `hugo/data/browse.json` |
| Mission-detail feed (child links) | `srv/lib/branch/mission-detail.js` |
| Navigator links — view | `db/views.cds:76–95` (`NavigatorCatalog`, gates `published` only) |
| Navigator links — nested-group path | `srv/lib/navigator-catalog.js` ~`:196–288` (filters `published` only) |
| Mission card (SSR) | `hugo/layouts/partials/browse/_partials/card-mission.html` |
| Mission card (Vue, parity source) | `hugo-apps/src/shared/cards/MissionCard.vue` |
| Card parity test + fixture | `hugo-apps/src/browse/__tests__/card-template-parity.test.ts`, `fixtures/card-mission.expected.html` (regen via `tools/regen-card-parity-fixtures.sh`) |
| Card surfaces (badge shows here) | `/browse/` (`hugo/layouts/browse/list.html:95`), `/tutorial-navigator/` (`TutorialNavigator.vue`) |
