# Issue #739 — Curate Homepage Featured Missions via existing `FeaturedTasks`

- **Status:** Approved (2026-06-29), spec-reviewer pass complete
- **Issue:** [#739](https://github.com/sap-tutorials/tutorials-ims/issues/739)
- **Predecessor PR:** [#738](https://github.com/sap-tutorials/tutorials-ims/pull/738) — added the `EVENT_MISSION_RE` regex sieve that this spec promotes from "primary picker" to "fallback only."
- **Related issue:** [#734](https://github.com/sap-tutorials/tutorials-ims/issues/734) — same architectural family (admin curation infrastructure exists but the surfacing/wiring is incomplete).

## Summary

Today's homepage `hp-teaser` "Featured missions" row picks the first 10 mission cards in catalog-iteration order — minus a regex sieve that drops Devtoberfest/AppSpace/TechEd-titled missions (PR #738). Admins have no way to promote a specific mission to the homepage without editing source.

The issue body proposed adding a new `featuredOrder` field to `Missions` plus admin UI plus catalog wiring. Investigation surfaced that the equivalent infrastructure **already exists**:

| Piece | Status today |
|---|---|
| `FeaturedTasks` polymorphic table (TUTORIAL / MISSION / GROUP) with `featuredOrder` | Exists at `db/schema.cds:471` |
| `AdminService.FeaturedTasks` projection + `setFeaturedOrder` action | Exists at `srv/admin-service.cds:143,329` |
| Admin UI (Fiori Elements list-report-object-page over `FeaturedTasks`) | Exists at `/admin-ui/#operations` |
| `@UI.LineItem` + `@UI.HeaderInfo` + `@Common.Label` annotations | Exists at `app/admin-annotations.cds:958-984` |
| `/build/catalog` returns a `featured` array (top 6 by `featuredOrder`) | Exists at `srv/lib/build-catalog.js:26,189` |
| Rebuild classifier triggers on `FeaturedTasks` writes | Exists in `srv/lib/_classify-rebuild-mode.js` |

The actual gap is one function: **`scripts/fetch-tutorials.ts → writeBrowseData()` does not consume `catalog.featured`.** It rolls its own picker using catalog-iteration order and the regex sieve. So all the curation plumbing exists but the homepage build silently bypasses it.

This spec wires `writeBrowseData()` to prefer the curated set when admins have curated anything, with the existing regex-sieved catalog-order picker as the fallback. It also moves the "Featured Tasks" side-nav entry from the System group to the Content group, where it semantically belongs (editorial curation, not operations).

## Scope

### In scope

- Modify `scripts/fetch-tutorials.ts → writeBrowseData()` to consume `catalog.featured` as the primary picker for `browseData.featured`, with the existing regex-sieved catalog-order picker as the fallback.
- Extend `scripts/parsers/cap.ts` to surface the `featured` array that `/build/catalog` already returns.
- Move `{ "key": "operations", "title": "Featured Tasks" }` from the System group to the Content group in `app/admin-shell/webapp/model/navigation.json`.
- Add a unit test for the new picker function.

### Out of scope

- **A new `Missions.featuredOrder` field.** The existing polymorphic `FeaturedTasks` is strictly more general; adding a parallel field on `Missions` would create two sources of truth for "what's featured." If a future need surfaces for mission-only curation (e.g. UI shortcut for "feature this mission" inline on the Missions admin page), it can layer on top of `FeaturedTasks`.
- **Renaming the "Featured Tasks" entity in the title map** to make the homepage connection clearer. Decision: keep the existing name; the parent "Content" group already provides editorial context.
- **Time-window curation** (`startsAt` / `endsAt` on featured rows). v2 if needed.
- **Per-verb featured rows** ("Featured for Build", "Featured for Learn"). The current spec is single-row only — same scope as today's `hp-teaser`.
- **A "promote inline" button on the Missions admin page.** UX shortcut for a single edit case; the standalone Featured Tasks admin already covers the workflow.
- **Cache-bust button on save.** Existing rebuild classifier (~1 min wall-clock) covers the propagation requirement in the acceptance criteria.

## Approach

The decisive observation: this is fundamentally a *bug*, not a feature. The infrastructure for explicit homepage curation already exists end-to-end except for the build-pipeline consumer. The right fix is to wire the existing pipeline rather than build a parallel one.

The `writeBrowseData()` change keeps the regex-sieved catalog-order picker as the fallback (preserves the #738 behavior for fresh deploys and pre-curation states). The two paths are mutually exclusive within a single build — admins curating "explicit empty slots" (e.g. only 3 missions in the curated set) get exactly what they asked for, not a regex-padded set of 10.

## 1. Architecture

### 1.1 Build-time data flow

```text
CAP backend
  └─ GET /build/catalog (existing, unchanged)
       └─ srv/lib/build-catalog.js:26-30
            ├─ SELECT * FROM FeaturedTasks ORDER BY featuredOrder LIMIT 6
            └─ resolveFeatured() → {type, slug, title, description}[]
       └─ res.json({ missions, hierarchies, featured, ... })

scripts/parsers/cap.ts (extended)
  └─ fetchCatalog() now surfaces `featured: BrowseFeaturedEntry[]`
       on the parsed Catalog object.

scripts/fetch-tutorials.ts → writeBrowseData() (changed)
  └─ NEW picker (Section 1.2)
       └─ writes hugo/data/browse.json with featured: string[]
```

### 1.2 The picker (pseudocode)

```ts
// catalog.featured shape: { type: 'mission'|'group'|'tutorial', slug, ... }[]
const curatedMissionSlugs = (catalog.featured ?? [])
  .filter(f => f.type === 'mission')
  .map(f => f.slug)

let featured: string[]
if (curatedMissionSlugs.length > 0) {
  // Explicit curation wins. Trim to FEATURED_MAX but do NOT pad with fallback.
  featured = curatedMissionSlugs.slice(0, FEATURED_MAX)
} else {
  // No curation. Use the regex-sieved catalog-order picker from #738.
  featured = all
    .filter(c => c.type === 'mission' && isFeaturedMissionCandidate(c.title))
    .slice(0, FEATURED_MAX)
    .map(c => c.id)
}

// Defensive: drop any featured slug that didn't resolve to an entry in all[].
const allMissionSlugs = new Set(all.filter(c => c.type === 'mission').map(c => c.id))
featured = featured.filter(slug => allMissionSlugs.has(slug))
```

### 1.3 Request time

```text
User → /
  └─ hugo/layouts/partials/homepage/tutorials-teaser.html
       └─ reads .Site.Data.browse.featured (unchanged)
```

No Hugo template change. The template already reads `browse.featured` as `string[]` and looks them up against `browse.all[]`.

### 1.4 Admin curation flow (already works end-to-end)

```text
Admin → /admin-ui/#operations  (now under Content group, was System)
  └─ Fiori Elements list-report over FeaturedTasks
       └─ Create / edit a row (taskType=MISSION, taskLegacyId=<id>, featuredOrder=N)
       └─ PATCH /admin/FeaturedTasks → CAP persists
       └─ Change-tracking fires rebuild classifier
            └─ classifier returns 'catalog-only' (~1 min wall-clock)
            └─ gh workflow run rebuild-content.yml fires
            └─ fetch-tutorials re-runs → /build/catalog re-fetched → browse.json regenerated
            └─ Hugo rebuilds → publish-content uploads (only browse.json changes)
            └─ Homepage shows curated set on next page load
```

### 1.5 Two `FEATURED_*` constants exist; reconcile in implementation

The codebase has two limits with similar names:

- `srv/lib/build-catalog.js:5` — `const FEATURED_LIMIT = 6` (server-side cap applied to the `SELECT ... LIMIT 6` query against `FeaturedTasks`).
- `scripts/fetch-tutorials.ts:1262` — `const FEATURED_MAX = 10` (client-side cap applied by the picker's `.slice(0, FEATURED_MAX)`).

Today's homepage `hp-teaser` renders whatever `browse.featured` contains. Because `FEATURED_LIMIT < FEATURED_MAX`, the picker can never receive more than 6 curated mission slugs — the `.slice(0, FEATURED_MAX)` line is unreachable on the curated branch.

**Implementation guidance:** keep both constants as-is. The unreachable slice is a cheap safety net (server-side cap could change without breaking the client), and the picker unit test mocks the helper input directly so it can still cover the "15 missions → returns 10" case with synthetic inputs even though that exact shape can't reach the helper at runtime today. Do not reconcile the constants to one value — they have different purposes (server-side query cap vs. client-side defensive trim).

## 2. Components

### 2.1 Modified

| File | Change |
|---|---|
| `scripts/fetch-tutorials.ts` | Around lines 1465-1478 (the existing featured-picker in `writeBrowseData()`): replace the single-path regex-sieved picker with the two-path picker from §1.2. Extract the picker into a pure helper function (`pickFeaturedMissions(catalogFeatured, allCards)`) so it can be unit-tested directly without invoking the rest of `writeBrowseData()`. The existing `EVENT_MISSION_RE` + `isFeaturedMissionCandidate()` + `FEATURED_MAX` stay exactly as they are — they power the fallback branch. |
| `scripts/parsers/cap.ts` | Extend the `Catalog` interface and `fetchCatalog()` to surface `featured: BrowseFeaturedEntry[]` from the catalog response. `BrowseFeaturedEntry = { type: 'mission'\|'group'\|'tutorial', slug: string, title: string, description: string }` matching `srv/lib/build-catalog.js:resolveFeatured()` output. Default to `[]` if absent (older srv version / partial deploy). |
| `app/admin-shell/webapp/model/navigation.json` | Remove `{ "key": "operations", "title": "Featured Tasks" }` from the System group's items array. Insert it into the Content group's items array immediately after `"alerts"` so editorial-curation entries cluster together. |

### 2.2 Added

| File | Purpose |
|---|---|
| `test/unit/scripts/featured-mission-picker.test.ts` | Seven-case unit test for the extracted picker (see §5.1). Mocks `BrowseCardItem[]` and `BrowseFeaturedEntry[]` inputs; asserts the returned `string[]` against expectations. |

### 2.3 NOT modified

| File | Why |
|---|---|
| `db/schema.cds` | `FeaturedTasks.featuredOrder` already exists. |
| `srv/admin-service.cds` | `FeaturedTasks` projection + `setFeaturedOrder` action already wired. |
| `app/admin-annotations.cds` | `FeaturedTasks` UI annotations already in place (line 958-984). |
| `app/admin/operations/webapp/manifest.json` | `FeaturedTasksList` Fiori Elements route already exists. |
| `srv/lib/_classify-rebuild-mode.js` | `FeaturedTasks` already triggers a rebuild on write. |
| `srv/lib/build-catalog.js` | `featured` array already correctly resolved. |
| `hugo/layouts/partials/homepage/tutorials-teaser.html` | Already reads `.Site.Data.browse.featured`. |
| `app/admin-shell/webapp/manifest.json` | The `operations` shell route stays; only the side-nav group membership changes. |
| `app/admin-shell/webapp/controller/Shell.controller.js` | `NAV_KEY_TO_ROUTE`/`NAV_KEY_TO_TITLE` for `operations` stay exactly as they are. Title remains "Featured Tasks." |

## 3. Data flow

See §1.1 and §1.4 above. No request-time CAP changes. No HANA changes. The build pipeline picks up the new picker on the next rebuild; the side-nav move propagates on the next admin-shell static asset push.

## 4. Error handling

### 4.1 Missing `featured` array in catalog response

`/build/catalog` might omit `featured` on an older srv version. `scripts/parsers/cap.ts` defaults `catalog.featured` to `[]` via `data.featured ?? []`. The picker's `if (curatedMissionSlugs.length > 0)` branch falls through to the regex-sieved fallback. Behavior matches today.

### 4.2 Unknown `type` in `featured` array

`resolveFeatured()` in srv only emits `mission`/`group`/`tutorial`. If a future taskType (e.g. `CHECKPOINT`) reaches the catalog response before the fetch script knows about it, `.filter(f => f.type === 'mission')` silently drops it — desired.

### 4.3 Featured slug not in `all[]`

The defensive `featured.filter(slug => allMissionSlugs.has(slug))` line catches the rare case where `resolveFeatured()` emitted a slug that didn't survive `buildAllCards()`'s downstream filtering (e.g. unpublished mission). The Hugo template would silently skip orphans anyway, but cleaning the JSON keeps the output well-formed and easier to debug.

### 4.4 Curated set has fewer than `FEATURED_MAX`

Returned as-is. No fallback fill. This is a deliberate admin choice: setting `featuredOrder` on exactly 3 rows means "feature these 3 missions, period." The hp-teaser band renders fewer cards.

### 4.5 Curated set has more than `FEATURED_MAX`

`.slice(0, FEATURED_MAX)` trims. Order preserved from `featuredOrder` (catalog handler already sorted by it).

### 4.6 Curated set has only non-mission types

`curatedMissionSlugs` is `[]`. Falls back to regex-sieved catalog-order picker. Matches the principle "mission-row absence ≠ deliberately-empty mission slot."

## 5. Testing

### 5.1 Unit tests (new)

`test/unit/scripts/featured-mission-picker.test.ts` — covers six cases:

1. **Curated set has mission entries** → returns curated slugs in order (no re-sort; catalog already returned them by `featuredOrder`).
2. **Curated set is empty (`[]`)** → falls back to regex-sieved catalog-order top 10.
3. **Curated set has only TUTORIAL/GROUP entries (no MISSION)** → falls back to regex-sieved catalog-order.
4. **Curated set has mixed types including missions** → returns only `type==='mission'` slugs in catalog order; TUTORIAL/GROUP filtered out.
5. **Curated set has 3 missions** → returns exactly those 3 slugs; no fallback fill to 10.
6. **Curated set has 15 missions** → returns first 10 (slice trims).

Plus one defensive case:

7. **Curated set references a slug not in `all[]`** → that slug is filtered out (orphan defense from §4.3).

### 5.2 Unit tests (existing — kept)

`test/unit/scripts/featured-mission-filter.test.ts` — keeps testing `isFeaturedMissionCandidate()` / `EVENT_MISSION_RE`. The sieve is still used in the fallback path.

### 5.3 Hybrid tests

None. `/build/catalog` already has hybrid coverage; this PR doesn't change the catalog handler.

### 5.4 Smoke tests

None. Behavior change is build-time, not runtime. The existing smoke test that asserts the homepage `hp-teaser` band renders covers the rendered-output contract.

### 5.5 Manual smoke after deploy

1. Hit `/admin-ui/` — observe "Featured Tasks" now in the Content group, no longer in System.
2. Click "Featured Tasks" — Fiori Elements list-report renders against `FeaturedTasks`.
3. Create a row: `taskType = MISSION`, `taskLegacyId = <a known mission's legacyId>`, `featuredOrder = 1`. Save.
4. Watch the pipeline log (`/admin-ui/#pipelinelog`) for the `catalog-only` rebuild to fire (~1 min).
5. Reload `/` — featured row's first card is the curated mission.
6. Set `featuredOrder = NULL` on that row (or delete it) — wait ~1 min, reload `/`, observe fallback to regex-sieved catalog-order.
7. Create three rows with `taskType` set to MISSION, TUTORIAL, GROUP at orders 1, 2, 3 — verify only the MISSION appears in the homepage band (TUTORIAL/GROUP are filtered out by the picker because the homepage `hp-teaser` is mission-only).

## 6. Migration / rollout

Single PR. No data migration. No feature flag. No schema change. Worst-case rollback is `git revert` + redeploy.

The existing `FeaturedTasks` table is empty in PROD (no admin has curated anything yet because the UI was buried in System and the build pipeline ignored it anyway). On first deploy of this PR:

- Empty `FeaturedTasks` + admin hasn't found the moved nav entry yet → fallback path fires, homepage unchanged.
- Admin discovers the moved nav entry under Content, curates a few missions → next rebuild surfaces them.

The transition is monotonic — there's no state where the new code can produce a worse result than today.

## 7. References

- Issue [#739](https://github.com/sap-tutorials/tutorials-ims/issues/739)
- PR [#738](https://github.com/sap-tutorials/tutorials-ims/pull/738) — `EVENT_MISSION_RE` sieve (this PR promotes it to fallback-only)
- PR [#766](https://github.com/sap-tutorials/tutorials-ims/pull/766) — recent precedent for "infrastructure exists but admin can't reach it" pattern
- Related: [#734](https://github.com/sap-tutorials/tutorials-ims/issues/734) — same architectural family
- Memory: [[feedback_handcurated_registration_lists_are_a_bug_pattern]] — the deeper bug pattern of "admin UI doesn't cover what was specified" that this PR is yet another instance of
