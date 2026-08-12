# Context-aware group/mission tutorial navigation — design

**Date:** 2026-08-12
**Status:** Approved (design); pending implementation plan
**Related:** recurring "Group / Mission Ordering Issues" reports

## Problem

A tutorial's **Next/Previous** buttons can jump *out* of the group the reader is
in. Reported case (verified on PROD):

- Group `set-up-your-sap-hana-cloud-sap-hana-database-and-understand-the-basics`
  (mission `15069`) contains, in correct order,
  `[hana-cloud-mission-trial-1, -2, -3, -4]`. So `hana-cloud-mission-trial-3`
  is the 3rd of 4, and **Next should go to `hana-cloud-mission-trial-4`**.
- The served page instead bakes **Next → `hana-trial-advanced-analytics`** and
  **Prev → `sac-guidedexperiences-getstarted`** — neighbours from a *different*
  mission's group (`data-and-analytics-937-1`, mission `24491`).

### Root cause (confirmed)

`next`/`prev` (and `missionSlug`/`groupSlug`/`missionId`) are **single values
baked into each tutorial's Hugo frontmatter at build time** by
`scripts/fetch-tutorials.ts`. The button markup
(`hugo/layouts/partials/tutorial-nav-bottom.html`, `next-steps.html`) only reads
those baked params — there is no runtime override for it.

In `fetch-tutorials.ts` (Phase 4), every mission-group loop
(`~lines 1152-1178`) and standalone-group loop (`~lines 1209-1226`) mutates a
**single shared `nav` object per slug** (`navBySlug`) with no ownership guard:

```ts
const prevSlug = i > 0 ? group.tutorialSlugs[i - 1] : null
const nextSlug = i < group.tutorialSlugs.length - 1 ? group.tutorialSlugs[i + 1] : null
if (prevSlug && navBySlug.has(prevSlug)) nav.prev = prevSlug
if (nextSlug && navBySlug.has(nextSlug)) nav.next = nextSlug
```

`hana-cloud-mission-trial-3` is a member of **four** groups (missions `15069`,
`24491`, `24596`, `24609`). Whichever mission is processed **last** wins —
here mission `24491`'s `data-and-analytics-937-1` group. This is why per-symptom
fixes keep recurring: **a single baked `next`/`prev` cannot represent a tutorial
that legitimately belongs to multiple groups.**

`/build/navigator`'s `tutorialMappings[]` already emits **one row per
(tutorial, group)** with that group's own correct `prev`/`next` +
`groupSlug`/`missionSlug`/`missionTitle`/`groupTitle`. Verified on PROD, the
`set-up-...` row for trial-3 correctly reads `prev: -2, next: -4`. So the
correct data already exists at serve time; the fix is to *select the right row*
based on the group the reader entered from.

## Approach

**Context-aware runtime navigation, keyed on a `?from=<groupSlug>` query param**,
backed by a stable build-time default.

Rejected alternatives: `document.referrer` (fragile behind Akamai, dead on
external/bookmarked entry), `sessionStorage` (stateful, breaks across tabs).
`?from=` is explicit, survives sharing/bookmarking, and degrades cleanly to the
baked default.

The tutorial page HTML is identical regardless of entry group (served from a
HANA BLOB), so the group context must travel in the URL and be applied by a
small client island — mirroring the existing `tutorial-breadcrumbs` island,
which already fetches a `/build/*` feed and rewrites nav anchors in place with a
silent no-op failure mode.

## Phases

Each phase is independently testable and shippable. A–D are the core fix;
E is the heaviest and may be deferred.

### Phase A — Build-time deterministic owner
**File:** `scripts/fetch-tutorials.ts` (Phase 4 loops).

Replace last-writer-wins with a **canonical owner** per slug. Pre-compute, for
each tutorial slug, the single container (mission-group or standalone group) that
owns its baked default = the container with the **lowest `(missionLegacyId,
groupLegacyId)`** rank (the original authoring home). Only that container writes
the tutorial's baked `next`/`prev`/`missionId`/`missionSlug`/`missionTitle`/
`groupSlug`/`groupTitle`/`missionAltGroups`.

- Ordering key: rank each candidate container by the tuple
  `[missionLegacyId ?? Number.MAX_SAFE_INTEGER, groupLegacyId]`, ascending;
  lowest wins. This keys off the **mission** first, not the group — group
  legacyIds are NOT chronologically ordered relative to the home mission. Worked
  example: `hana-cloud-mission-trial-3` lives in group `15066` (mission `15069`
  "Jump Start") and groups `937/969/979` (TechEd missions `24491/24596/24609`).
  Ranking by group id alone would wrongly pick `937`; ranking by mission id picks
  mission `15069` → the `set-up-...` group, whose baked Next is correctly
  `hana-cloud-mission-trial-4`. Standalone groups (no parent mission) rank with
  `missionLegacyId = Number.MAX_SAFE_INTEGER` (mission-nested homes preferred),
  tiebroken by `groupLegacyId` then slug. `legacyId` is unique per entity, so a
  given tutorial's candidate set has a single unambiguous minimum.
- Container metadata built for `missionsMeta` / `allGroupRefs` / `_nav.json`
  stays unchanged (every container still contributes its full tutorial list) —
  only the per-tutorial **frontmatter** nav stamping is owner-scoped. Implement
  as: flatten all containers into a list, sort by the rank tuple, then a single
  stamping pass with a `stamped` Set (first-writer-wins in ranked order); remove
  the inline nav-stamping from the existing metadata loops.
- Do **not** rely on `if (!nav.next)` guards — `null` is a legitimate "no next"
  (last item in group). The `stamped` Set is the authority.
- Result: baked defaults become stable and sensible for direct visits, search,
  bookmarks, breadcrumb, and side-nav, regardless of mission array order.

### Phase B — Emit entry context
**File:** `srv/lib/catalog-renderer.js`.

- `renderGroupBody`: append `?from=<group.slug>` to both per-tutorial links
  (title link `~:80`, "Start Tutorial" button `~:92`). `group.slug` is available
  as `ctx.group.slug`.
- `renderMissionBody`: append `?from=<containerSlug>` to each per-tutorial link
  (`~:131`), where `<containerSlug>` is that tutorial's group/path slug **as it
  appears in `/build/navigator`'s `tutorialMappings.groupSlug`** (including
  synthetic path groups — the path slug). Group-page links emitted by the mission
  page (`/tutorials/group-<slug>`) are unchanged.
- Use the existing `escapeHtml` helper on the appended value.

**Invariant:** the `from` value emitted here MUST equal the `groupSlug` the
navigator feed uses for the same container, or the island lookup misses and
falls back. This is verified by a test that cross-checks SSR-emitted `from`
values against `/build/navigator` `groupSlug`s.

### Phase C — Runtime nav-rewrite island
**New:** `hugo-apps/src/tutorial-group-nav/` (Vite island; register in Vite build
+ `hugo/data/island_manifest.json`; load via `partial "island-src.html"`).
Model on `hugo-apps/src/tutorial-breadcrumbs/main.ts`.

Behaviour:
1. Guard: only run when `document.documentElement.dataset.pageKind === 'tutorial'`.
2. Read `from` from `location.search`. If absent → **no-op** (baked Phase-A
   defaults stand).
3. Fetch `/build/navigator` (public, `max-age=60`). On error → no-op.
4. Find the row where `slug === pageSlug && groupSlug === from`. If none → no-op.
5. Rewrite:
   - `.tutorial-nav-bottom a.nav-pill` (Prev) → `/tutorials/<prev>?from=<from>`;
     if `prev === null`, **remove** the Prev pill.
   - `.tutorial-nav-bottom a.nav-pill--primary` (Next) →
     `/tutorials/<next>?from=<from>`; if `next === null`, **remove** the Next
     pill (end of group).
   - The next-steps card (`a.next-steps-card` in
     `hugo/layouts/partials/next-steps.html`) → same Next target; hide the card
     when `next === null`.
   - Preserving `?from=` on the rewritten targets keeps the chain in-group.
6. `pageSlug` comes from `document.documentElement.dataset.pageSlug`.

The approuter `/tutorials/*` route accepts `?from=` (verified: 200 with and
without the query on PROD). No approuter route change required, but a regression
check is included (guards against the known "route source without a query group
404s any query" gotcha).

### Phase D — Context-aware breadcrumb
**File:** `hugo-apps/src/tutorial-breadcrumbs/main.ts` (existing island).

When `?from=` is present, resolve mission/group title+slug from the matching
`/build/navigator` row (same lookup as Phase C) instead of the first-group-only
`/build/breadcrumb-context`. When absent → current behaviour unchanged.

To avoid two navigator fetches per page, Phases C and D share a tiny lookup
module (e.g. `hugo-apps/src/lib/group-nav-context.ts`) that fetches
`/build/navigator` once and resolves the `(slug, from)` row.

### Phase E — Context-aware side-nav (heaviest; deferrable)
**Files:** `hugo/layouts/partials/mission-side-nav.html`,
`hugo/assets/js/mission-side-nav.ts`.

Make the right-rail "In this mission" nav reflect the `?from=` group's mission
rather than the baked `missionId`. Because Phase A already makes the baked
default the canonical/original mission, this only changes behaviour when the
reader entered from a **non-canonical** mission (e.g. a TechEd app-space reuse).

Scope for E: at minimum, the mission header link + which mission's group tree is
shown match the from-group's mission (resolved via the shared navigator lookup).
Full runtime re-render of the group/sub-item tree is the expensive part; if it
balloons, ship A–D and track E separately. Progress painting
(`/api/missions/<id>/navigation`) must use the resolved mission id.

## Failure modes & non-goals

- **Every island path fails silent** — a fetch error, missing `?from=`, or
  unmatched row leaves the baked (Phase-A) links intact. The page never breaks.
- **Direct/external/search entry** has no `?from=` → gets the Phase-A canonical
  default. This is the correct, stable behaviour (not "wrong").
- **Canonical `<link rel=canonical>`** stays query-free; `?from=` is a client
  hint only (no duplicate-content / SEO impact).
- **Non-goal:** changing `GroupPathItems.itemOrder` data or the admin UI. The
  ordering data is already correct; this is purely a build/serve logic fix.
- **Non-goal (this change):** the separate report that `/admin-ui/#/groups...`
  does not display groups — tracked independently.

## Testing

- **Phase A:** unit test in `scripts/__tests__/` — a fixture tutorial in
  multiple groups gets `next`/`prev`/`groupSlug` from the lowest-`legacyId`
  container, deterministically, regardless of input mission order.
- **Phase B:** test that SSR-emitted `?from=` values match `/build/navigator`
  `groupSlug`s for the same containers (incl. a synthetic path group).
- **Phase C/D:** hugo-apps island unit tests via
  `vitest run --project unit <path>` from repo root (dual-Vue caveat). Cover:
  no `from` → no-op; matched row → correct rewrite + `?from=` propagation;
  `next===null` → Next removed; fetch error → no-op.
- **E2E:** add a `test/e2e/` spec (per the e2e-coverage nudge for user-facing UI
  changes) exercising: enter group → click into 3rd tutorial → Next lands on the
  4th tutorial in the *same* group, not out of it.
- Baseline any pre-existing failures before attributing to this change.

## Rollout

Frontend + build change. Ships via full local deploy (`npm run build:all` →
`mbt build` → `cf deploy -e ...`) — island bundle + Hugo re-bake required; a
content-only rebuild is insufficient because the island manifest and SSR
renderer change. Open as a PR to `main`; do not direct-merge.
