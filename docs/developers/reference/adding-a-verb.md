---
title: Adding, Renaming, or Removing a Homepage Verb
description: Every callsite that must change together when the homepage verb list evolves. Read this before touching db/homepage.cds's HomepageVerb enum.
---

# Adding, Renaming, or Removing a Homepage Verb

The homepage verb list (LEARN, BUILD, INTEGRATE, MODEL, OPERATE, AI, CONNECT) is not a single enum — the string keys and their metadata (label, icon, sortOrder, sub-page path) are duplicated across ~20 runtime files, admin apps, and tests. When you add, rename, remove, or reorder a verb, **all of them must change together** or the site develops the specific class of half-broken behavior seen with #1029 (verb present in some surfaces, invisible in others).

This workbook is the checklist. Follow it top to bottom for any verb change and the resulting PR will hit every callsite.

**Also read:** [Homepage explainer popovers](../architecture/homepage-explainers.md) for the data model.

---

## Provenance

This file was authored 2026-07-07 after #1029 (add MODEL verb) shipped with three callsites missed — the top-nav dropdown, MODEL's `HomepageShelves` seed rows, and this workbook itself. Contents grep-verified against the actual #1029 diff plus the callsites still needing rework post-merge.

---

## The canonical enum

**Source of truth:** `db/homepage.cds`, enum `HomepageVerb` inside `db/homepage.cds`. Every string key elsewhere is a duplicate of a value here.

```cds
type HomepageVerb : String enum {
  LEARN; BUILD; INTEGRATE; MODEL; OPERATE; AI; CONNECT;
}
```

**Deploy-time trap you MUST know about:** Every deploy where `db/data/com.sap.developers.ims-VerbDefinitions.csv` or `db/data/com.sap.developers.ims-ShelfDefinitions.csv` has changed **wipes all admin-authored `tagline` / `whyItMatters` / `authoringStatus` content on the entire table**. HDI `.hdbtabledata` treats CSV imports as replace-on-deploy for every column in `import_columns`, and those three editable columns are currently in the CSV headers. See [CAP-CDS gotchas → HDI CSV overwrite semantics](./cap-cds-gotchas.md) (this doc will exist when the fix ships) for the mechanism and mitigation.

Until that fix lands, treat **any change to those two CSVs as a wipe-and-reauthor operation** — after the deploy, re-run `AdminService.generateVerbExplainers({mode: 'all'})` and `generateShelfExplainers({mode: 'all'})` from `/admin-ui/#verb-definitions` / `#shelf-definitions`, then optionally mark-reviewed.

---

## The full callsite list

Every file below references the verb list by string. When you add, rename, or remove a verb, update every one. When you finish, a `git grep -l 'VERB_YOU_ADDED'` should return the same file count as the reviewed rows in this table.

### 1. Schema + seed data

| File | What changes | Notes |
|---|---|---|
| `db/homepage.cds` | Add/rename/remove enum value on `HomepageVerb` | Also update the shelf-cardinality comment (currently "7 sub-pages") |
| `db/data/com.sap.developers.ims-VerbDefinitions.csv` | Add/rename/remove row | See wipe warning above. **Keep `tagline`/`whyItMatters` cells empty in the CSV** — real content lives in HANA, populated by admin. `authoringStatus=BLANK`. |
| `srv/admin-service.js` — `VERB_DEFAULTS` array at `~L621` and `existing.length >= N` gate at `~L632` | Add/remove object, bump the length gate | Runtime auto-init fallback; MUST agree with the CSV row count |

### 2. Backend service logic

| File | Symbol | What changes |
|---|---|---|
| `srv/lib/homepage/personalized-envelope.js` | `VERBS_UPPER` array + `VERB_TO_LOWER` map | Both need the new key |
| `srv/lib/homepage/persona-map.js` | `BASE_ORDER` array + all four `ROLE_TILT` arrays | New verb needs a position in `BASE_ORDER` and a tilt in every role's array |
| `srv/lib/prompts/explainer-verb.md` | Enumeration in the prompt body + any "Lane scope" section | Model reads this to write explainer copy — outdated list = wrong explainers |
| `srv/lib/prompts/explainer-shelf.md` | Verb count in the prompt body ("seven") | Same reason |
| `srv/lib/explainer-generator.js` | Any hard-coded verb list constant | Grep-check for the count word ("six", "seven") |

### 3. Hugo static site

| File | What changes | Notes |
|---|---|---|
| `hugo/content/<verb>/_index.md` | Create new file (or delete on removal) | Copy from a sibling — `type: verb`, `layout: list`, `verbKey: <UPPER>`, sitemap priority `0.9` |
| `hugo/layouts/partials/header.html` | `<ui5-li icon="…" data-href="/<verb>/">Label</ui5-li>` inside `#nav-list` | **The one #1029 missed.** Order must match verb-spine sortOrder |
| `hugo/layouts/partials/homepage/verb-spine.html` | Two things: (a) `$fallbackVerbs` slice used when the build feed returns empty; (b) `$hrefMap` dict | Both are hard-coded — the baked JSON from CAP takes precedence when non-empty |
| `hugo/layouts/partials/homepage/directory-footer.html` | Verb-column layout | Column count assumptions live here; adding a verb may cascade CSS |
| `hugo/assets/css/homepage.css` | Verb-column grid rules for narrow viewports | `#1029` had to tweak the ≤900px 2-col mobile rule |

### 4. Vue islands / frontend apps

| File | What changes |
|---|---|
| `hugo-apps/src/cmd-palette/actions.ts` | Add an `explore-<verb>` entry in the EXPLORE group (icon, keywords, `run: navTo('/<verb>/')`) |
| `hugo-apps/src/cmd-palette/actions.test.ts` | Update the fixture list of expected EXPLORE ids |
| `hugo-apps/src/homepage-explainers/VerbFlipTile.test.ts` | Any hard-coded verb enumerations |
| `hugo-apps/src/homepage-explainers/ShelfHeaderPopover.vue` | Verb-path comment (documentation only, but keep current) |

### 5. Admin UI (Fiori Elements)

| File | What changes |
|---|---|
| `app/admin/verb-definitions/webapp/i18n/i18n.properties` | i18n keys if verb-count references it |

### 6. Runtime data seeding (post-deploy)

For a NEW verb, you must seed `HomepageShelves` rows so `/<verb>/` renders shelf entries.

**Preferred: seed rows in the CSV, not just at runtime.** `db/data/com.sap.developers.ims-HomepageShelves.csv` is safe to add shelf rows to — unlike `VerbDefinitions.csv`/`ShelfDefinitions.csv`, its columns (`title`/`url`/`description`/`badge`/`isExternal`/`isActive`) are content, not admin-authored explainer fields, so the [auto-CSV wipe](./hana-hdi-gotchas.md#auto-csv-replaces-admin-editable-columns-on-every-csv-changing-deploy) mechanism just re-imports the same values. Seeding in the CSV means a CSV-backed build (plain `cds watch`) bakes the verb page correctly instead of empty — the root cause of the #1029 MODEL regression, where MODEL's shelf content existed only in HANA and a SQLite-backed build shipped `/model/` with zero cards. **Before adding rows, confirm live HANA matches the CSV** (diff `MODIFIEDBY`/values) so the hash-change re-import doesn't revert an admin edit.

Guidance for the rows:
- Insert ~12 rows (3 per shelf × 4 shelves — START_HERE / REFERENCE / TOOLS / KEEP_CURRENT), matching the tone of existing verbs
- Uniqueness constraint: `@assert.unique.verbUrl` on `(verb, url)` — same URL can appear under multiple verbs
- Optionally run `AdminService.generateShelfEntryExplainers` to seed the per-link ⓘ popovers
- The build guard `scripts/check-verb-shelves.cjs` (chained into `build:hugo`) fails the build if any defined verb bakes zero active shelf rows — so a missing-seed verb can no longer ship silently.

### 7. Tests that reference the count / enumeration

Every test in this list needs updating:

- `test/unit/db/homepage-schema.test.js` — enum value assertions
- `test/unit/homepage-seed.test.js` — seed row assertions (verb count)
- `test/unit/homepage/personalized-envelope.test.js` — envelope shape
- `test/unit/homepage/persona-map.test.js` — persona ordering assertions
- `test/unit/srv/admin-service-explainer-autoinit.test.js` — auto-init row count
- `test/unit/srv/admin-service-explainer-actions.test.js` — action tests
- `test/unit/srv/build-feeds-explainers.test.js` — build-feed shape
- `test/hybrid/homepage-schema.test.js` — hybrid schema assertions
- `test/hybrid/verb-definitions-crud.test.js` — hybrid CRUD
- `test/smoke/build-feeds-explainers.smoke.test.js` — smoke feed check
- `test/smoke/homepage.smoke.test.ts` — homepage renders N tiles

### 8. Docs kept in sync

- `docs/developers/architecture/homepage.md` — verb path table
- `docs/developers/architecture/homepage-explainers.md` — cardinality references
- **This file** — bump the verb list at the top

---

## Verification checklist

Before merging a verb change, all of these should pass:

```bash
# 1. Schema deploys cleanly to an in-memory SQLite (catches @assert.unique.* violations)
npx cds deploy --to sqlite::memory:

# 2. All string references to verbs are consistent
git grep -c "'LEARN','BUILD','INTEGRATE'" srv/ hugo-apps/ hugo/ | awk -F: '{s+=$2} END {print s}'
# Every count in the grep output should include your new/renamed verb

# 3. Unit + hybrid tests pass
npm test
npm run test:hybrid

# 4. Fresh Hugo build has the new verb in the baked JSON
CAP_BASE_URL=<hybrid> npx tsx scripts/fetch-verb-definitions.ts
jq '.verbs | length' hugo/data/verb_definitions.json  # Should match your new count

# 5. Header nav has the new verb (this file's chief lesson)
grep -c 'data-href="/<verb>/"' hugo/layouts/partials/header.html  # Should be 1
```

---

## Post-deploy validation (visitor-facing)

After a merge → MTA deploy → `gh workflow run rebuild-content.yml`:

1. **Homepage tile spine** — Should render N tiles. Curl the homepage and count `<li data-verb=…>` occurrences: `curl -s <homepage> | grep -oE 'data-verb=[a-z]+' | wc -l`
2. **Top-nav dropdown** — Open the shellbar menu; verify N verbs appear between Home and the horizontal separator
3. **Command palette Explore group** — Type `⌘K` → `explore` → count entries
4. **Verb sub-page** — Visit `/<verb>/`; verify all 4 shelf sections render with link cards
5. **Flip-tile back face** — Click any verb tile on the homepage; verify tagline + whyItMatters render (empty if authoringStatus=BLANK — see explainer authoring workflow)

---

## Related

- [Homepage architecture](../architecture/homepage.md) — data flow overview
- [Homepage explainer popovers](../architecture/homepage-explainers.md) — VerbDefinitions/ShelfDefinitions/HomepageShelves data model + AI generation
- [Rebuild content workflow](../operations/rebuild-content-workflow.md) — how catalog-only rebuilds pick up CSV changes
