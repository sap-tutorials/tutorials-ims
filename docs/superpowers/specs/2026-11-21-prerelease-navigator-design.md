# Pre-release Navigator — Design

**Issue:** [sap-tutorials/tutorials-ims#3168](https://github.com/sap-tutorials/tutorials-ims/issues/3168) · Follow-up to [#3099](https://github.com/sap-tutorials/tutorials-ims/issues/3099) (Private Tutorials, merged to **DEV**) · Design, 2026-11-21.
**Parent design:** Private Tutorials — the `visibility` field + `ROLE_GATED` serve gate (merged on `origin/DEV`).

**Base branch: `origin/DEV`.** #3099 lives on DEV, not `main`. All work here branches from and targets DEV.

Adds a **scope-gated browse navigator** so holders of the `Tutorial.PreRelease` XSUAA scope can *browse, filter, and search* pre-release (ROLE_GATED) tutorials, instead of needing a direct link to `/tutorials-prerelease/:slug` for each one.

---

## Intent & why

#3099 gives role-holders **direct-link** access to pre-release tutorials at `/tutorials-prerelease/:slug`, gated by the `Tutorial.PreRelease` scope. There is intentionally **no listing surface** — ROLE_GATED tutorials are suppressed from the public navigator, search, and sitemap, and the gated prefix has only a slug catch-all route (no index, nav feed, or search).

Consequence: a role-holder can only reach a pre-release tutorial if someone hands them the exact slug. This design adds the missing listing surface: a navigator behind the same scope that lists, filters, and searches ROLE_GATED tutorials only.

## Goals

- A **full navigator** (card grid + category/tag filters + free-text search) at a scope-gated route (`/tutorials-prerelease/`), showing **only** `ROLE_GATED` tutorials.
- Reuse the existing navigator Vue island + Hugo template by adding a **third channel** (`prerelease`), mirroring the QA channel's build-time mechanism exactly.
- Nav data served **live** from `srv-api` behind the existing server-side `{ gated: true }` trust seam (no new CAP app).
- **Search/filter is client-side** over the gated nav feed — the QA channel's proven posture (`data-client-search="true"`, no server search service).
- Cards click through to the existing gated slug route `/tutorials-prerelease/:slug`.
- **Prerequisite fix (in this PR):** close the public `semantic_search` ROLE_GATED leak (see §5) — a pre-existing #3099 anti-goal breach that must be fixed or this feature ships a net leak.

## Non-goals

- Server-side gated `$search` / a `PreReleaseSearchService` / a `SearchablePreReleaseItems` view — **dropped**. Search is client-side over the nav feed (QA model). Server search would add a sibling service + view + handler extraction + a gated `getFacets`, and inherit the known DEV `$search` KG-rerank 500 bug — not worth it for the small pre-release corpus. Revisit only if the pre-release set grows large.
- Per-user allowlists / per-event gating — role-scoped, all-or-nothing by `Tutorial.PreRelease` (inherited from #3099).
- A separate `srv-prerelease` CAP app / HDI container — pre-release reuses `srv-api` + the main model.
- Changing how pre-release tutorials are **served** (#3099 slug gate unchanged) or **authored** (visibility set on the admin Tutorials OP).
- Mission/Group pre-release listing — `visibility` is on `Tutorials` only.

## Anti-goals (would make this a failure even if it "works")

- A ROLE_GATED slug/title/body leaking to a caller **without** the `Tutorial.PreRelease` scope — via the gated nav feed, the (now public-fixed) semantic path, or a cacheable response. Fail **closed**, matching #3099.
- Flipping the public `/build/catalog`, `/content/nav`, or public `/search` to filter *in* ROLE_GATED, or gating them behind auth. Public surfaces stay LISTED-only and anonymous; pre-release gets **parallel** gated surfaces.
- The gated navigator coming up **empty** because its data source is mission-scoped — standalone ROLE_GATED tutorials (the common pre-release case) must be listable (see §2).
- A gated nav response entering a shared/public cache (the #3099 cache-leak class).

## Constraints

- **Base = `origin/DEV`.** PRs target DEV, never direct-merge to `main`.
- **Channel selection is BUILD-TIME, not runtime.** The navigator template switches on `site.Params.qa` — a Hugo site-config param resolved at build (`hugo/layouts/tutorial-navigator/list.html`). QA has a full separate pipeline: `fetch-tutorials:qa --channel qa`, `build:qa` (`hugo.qa.toml` → `hugo/public-qa`), `publish-content:qa`; its **index is served statically** from the approuter (`localDir: "static"` → `/qa/index.html`), not from CAP. There is no runtime channel switch in the island today. The pre-release channel must mirror this build-time mechanism — a runtime switch is net-new mechanism with no precedent and was rejected.
- The public `/content/nav` serves a **pre-baked `__nav__` BLOB** (LISTED-only, built at publish) — `navHandler` at `packages/content/content-store.js:1835`. No pre-release blob is published, so the gated feed must be **live**.
- **`navHandlerFallback` (`content-store.js:1765`) has NO visibility filter** — it enumerates `ContentCurrent` joined to `Tutorials`, filtering only `status !== 'INACTIVE'`. ROLE_GATED tutorials DO have ContentCurrent rows. So it cannot be reused as-is for the gated feed (would list LISTED + ROLE_GATED indiscriminately = leak). The gated feed needs an explicit `visibility='ROLE_GATED'` predicate.
- **`NavigatorCatalog` (`db/views.cds:76`) is mission-scoped** (INNER JOIN to published Missions). A standalone ROLE_GATED tutorial not in a published mission's completion path would never appear. The gated feed must NOT be built from `NavigatorCatalog`.
- The gated slug route rewrites `/tutorials-prerelease/*` → CAP `/content/tutorials-prerelease/*`, mounted with `{ gated: true }` (`srv/server.js:850`). Trust = server-side mount, not a client header. New gated endpoints reuse this.
- **XSUAA scope `Tutorial.PreRelease` already exists** (#3099: scope at `xs-security.json:39`, role-template `TutorialPreRelease:133`, role-collection `"Tutorials PreRelease":211`). **No xs-security change** — navigator routes reference the existing scope. No `cf update-service` gate.
- **Public search bypass points for the leak fix:** the lexical path (OData `$search` + `search_tutorials` MCP) goes through `SearchableItems`, which **does** filter `visibility='LISTED' or is null` (`views.cds:114`) — covered. The **semantic path** (`srv/lib/semantic-search.js:165-209`) filters only `status` ACTIVE + `filterServableSlugs` (ContentCurrent presence, no visibility — `servable-slugs.js`), and the `semantic_search` action is `@requires:'any'`. So public semantic currently leaks ROLE_GATED. §5 fixes this.

---

## Approaches considered

### Overall navigator

- **Live gated nav feed on `srv-api` + QA-style build-time channel for the shell (CHOSEN).** New gated live nav handler behind `{ gated: true }`; a `prerelease` build channel mirroring QA (config, data dir, static shell); client-side search/filter over the feed. No new CAP app, no server search service.
- **Fully baked prerelease content channel incl. a baked nav blob (rejected).** Would add a published `__nav_prerelease__` blob + a publish-channel path; heavier and couples the nav feed to the content-publish cycle. The live feed is simpler and always current.
- **Client-filtered public catalog (rejected, #3099 leak).** Point the island at the anonymous `/build/catalog` and filter client-side — ROLE_GATED titles transit a public endpoint. Violates the leak anti-goal.

### Shell channel mechanism

- **Build-time `site.Params.prerelease` (CHOSEN).** Mirror QA exactly: `hugo.prerelease.toml`, `data-prerelease/`, `build:prerelease`, a static-served `/prerelease/index.html` shell, a `site.Params.prerelease` branch in the navigator template. Proven, but reintroduces a baked artifact into the deploy/rebuild path (documented risk below).
- **Runtime switch (rejected).** One baked page serving all channels via an approuter-injected marker consumed by the island. No baked artifact, but net-new mechanism with no precedent and more risk. Rejected in favor of matching the proven QA pattern.

### Search posture

- **Client-side over the gated nav feed (CHOSEN).** Exactly QA: `data-client-search="true"`, server `$search` disabled, island filters the already-fetched nav list. No `PreReleaseSearchService`, no sibling view, no gated `getFacets`. Avoids the DEV `$search` KG-rerank 500 bug.
- **Server-side role-gated search (rejected).** A sibling view + role-`@requires` service reusing the extracted lexical pipeline + a gated `getFacets`. True server search, but heavy and bug-inheriting for a small corpus.

---

## The design

### 1. Data model

No schema change. `visibility` already exists on `Tutorials` (enum `Visibility { LISTED; UNLISTED; ROLE_GATED; }`). This design adds a view (optional), a live handler, a build channel, routes, a template branch, and the semantic leak fix.

### 2. Gated nav feed (live) — `srv-api`

- **Source (corrected):** a live query over `Tutorials WHERE visibility = 'ROLE_GATED' AND (status IS NULL OR status = 'ACTIVE')`, intersected with ContentCurrent presence (servable) — **not** `NavigatorCatalog` (mission-scoped) and **not** bare `navHandlerFallback` (no visibility filter). This lists standalone pre-release tutorials, which is the point.
- **Shape:** emit the **same tutorial-shaped nav JSON** the island's `_nav.json` consumer expects (the `navHandlerFallback` output shape: `slug`, `title`, `description`, `time`/`averageTimeToComplete`, `level`/`experienceTag`, `stepCount`, `displayTags`), so the island needs no shape changes — only a different base. Factor the tutorial-metadata-assembly part of `navHandlerFallback` into a shared helper parameterized by the slug set + visibility, and call it with the ROLE_GATED slug set.
- **Handler** `preReleaseNavHandler` in `packages/content/content-store.js`: returns `{ version, count, tutorials }`; set `Cache-Control: private, no-store` (gated content must not enter a public/shared cache — #3099 rule). The handler itself only ever returns ROLE_GATED rows (defense-in-depth), but the approuter scope on its route (§4) is the real gate.
- **Mount** `srv/server.js` (bootstrap, near line 850): `app.get('/content/tutorials-prerelease/_nav', (req,res)=>preReleaseNavHandler(req,res))`.
- *Optional view:* a `PreReleaseServableTutorials` view (`Tutorials` ⋈ `ContentCurrent` where `visibility='ROLE_GATED'`) if it reads cleaner than inline CQL — builder's call; the predicate is the load-bearing part.

### 3. Shell — QA-style build-time `prerelease` channel

Mirror the QA channel end to end:

- **`hugo.prerelease.toml`** (copy `hugo.qa.toml`): `dataDir = "data-prerelease"`, `params.prerelease = true`, base URL/path for the gated prefix.
- **`fetch-tutorials.ts`:** extend the existing `--channel` switch (currently `qa`) with `prerelease`, filtering the fetched/cataloged set to `visibility='ROLE_GATED'` (reads visibility off `/build/catalog`, already carried), writing `hugo/data-prerelease/`.
- **`build:prerelease`** npm script (copy `build:qa`): island-manifest sync + `hugo --config ../hugo.prerelease.toml` → `hugo/public-prerelease` + a verify step. Wire into `build:all`/deploy as a sibling of the QA build.
- **Template** `hugo/layouts/tutorial-navigator/list.html`: add a `site.Params.prerelease` branch mirroring the `site.Params.qa` branch — render only the island, set `data-nav-base="/tutorials-prerelease"`, `data-client-search="true"`, `data-href-base="/tutorials-prerelease"`, a "Pre-release" heading/badge, and drop the homepage discovery sections.
- **Static shell:** the built `prerelease/index.html` is served from the approuter `localDir: "static"` behind the scope (§4), exactly like `/qa/index.html`.

### 4. Approuter routes — `approuter/xs-app.json`

Add a block mirroring the QA routes (~lines 626–674) but `scope: "$XSAPPNAME.Tutorial.PreRelease"`, inserted **before** the existing `/tutorials-prerelease/(.*)` slug catch-all (specific first; ordering is load-bearing):

```jsonc
// static shell index
{ "source": "^/tutorials-prerelease/?$", "target": "/prerelease/index.html",
  "localDir": "static", "authenticationType": "xsuaa", "scope": "$XSAPPNAME.Tutorial.PreRelease" },
// static assets for the shell
{ "source": "^/tutorials-prerelease/((?:css|js|img|fonts|vendor)/.*)$", "target": "/$1",
  "localDir": "static", "authenticationType": "xsuaa", "scope": "$XSAPPNAME.Tutorial.PreRelease" },
// live gated nav feed
{ "source": "^/tutorials-prerelease/_nav\\.json$", "target": "/content/tutorials-prerelease/_nav",
  "destination": "srv-api", "authenticationType": "xsuaa", "scope": "$XSAPPNAME.Tutorial.PreRelease" },
// (existing slug route stays LAST)
{ "source": "^/tutorials-prerelease/(.*)$", "target": "/content/tutorials-prerelease/$1", ... }
```

No `xs-security.json` change — scope already exists. (Builder: confirm exact QA route set to mirror, incl. whether the static shell lives under `/prerelease/*` or `/tutorials-prerelease/*` in the static dir, matching how QA maps `/qa/*`.)

### 5. Prerequisite: fix the public `semantic_search` ROLE_GATED leak

Independent of the navigator, but **must ship in this PR** (else the feature is a net leak). The public anonymous `semantic_search` returns ROLE_GATED slugs/titles/body today because the tutorial corpus query (`semantic-search.js:165-209`) filters only `status` + ContentCurrent presence, with no visibility predicate.

- Add a **visibility exclusion** to the semantic tutorial corpus: exclude `visibility='ROLE_GATED'` from the public path (both HANA raw-SQL branch and the SQLite CQL branch). Simplest: a `filterOutRoleGated(db, slugs)` applied alongside `filterServableSlugs`, OR add the predicate to the `Tutorials` join/index subquery in both branches.
- Covers only the **public** surface (the navigator is client-side, so it does not call `semantic_search` on a gated surface in v1 — no gated semantic path needed).
- Add a regression test: public `semantic_search` never returns a ROLE_GATED slug.

### 6. Island — `hugo-apps/src/navigator/`

- The island already reads `data-nav-base`/`data-search-base`/`data-href-base` with public defaults and supports `data-client-search="true"` (QA uses it: server search disabled, client filters the nav list). The prerelease channel sets `data-nav-base="/tutorials-prerelease"`, `data-href-base="/tutorials-prerelease"`, `data-client-search="true"` — **no island code change expected** beyond confirming no hardcoded `/tutorials/_nav.json` or `/search` fallback bypasses the gated bases. Verify; parameterize only if needed.
- Confirm client-side search/filter (category/tag + free text) works over the nav feed shape without `getFacets` (QA path derives facets client-side). If the island unconditionally calls `getFacets` even in client-search mode, that's a bug to fix in the prerelease (and QA) path — verify against `useSearch.ts`.

---

## What's left to the builder

- **Exact QA route mirror** in `xs-app.json` (which of the 6 QA routes map to prerelease; static-dir path mapping `/prerelease/*`).
- **Whether a `PreReleaseServableTutorials` view** reads cleaner than inline CQL in the handler — either is fine; the `visibility='ROLE_GATED'` + ContentCurrent predicate is the requirement.
- **`fetch-tutorials.ts` channel plumbing** — exact shape of the existing `--channel` switch and where the visibility filter slots in.
- **CAP `@requires` for any CAP surface:** decided — the live nav handler is a plain Express route behind the approuter scope (matching #3099's serve posture, no CAP `@requires`); if any CAP entity is exposed, use `@requires: 'Tutorial.PreRelease'` (matches the scope short-name convention `AdminService` uses for `Admin`). Defense-in-depth; approuter scope is the primary gate.
- **Deploy/rebuild wiring for the baked `prerelease` channel** — this is the documented operational risk: like QA, the static shell can be wiped by a content-rebuild tarball or skipped by a local deploy that doesn't run `build:prerelease`. Ensure `build:prerelease` is in `build:all` and the deploy packages `public-prerelease`/static shell. Call this out in the plan's rollout + the ops runbook.
- **`getFacets`-in-client-search** island behavior — verify and fix if it fetches server facets in client-search mode.
- Tests: unit — gated nav handler returns only ROLE_GATED + sets `private, no-store`; standalone (mission-less) ROLE_GATED tutorial IS listed; **public semantic_search excludes ROLE_GATED** (the §5 regression, both DB branches). Integration — `/tutorials-prerelease/` + `/_nav.json` 403 without scope, 200 with. e2e — role-holder loads navigator, filters/searches client-side, clicks through to a gated slug.

## Rollout

- DEV-first (base + target DEV). Inert until a tutorial is `ROLE_GATED` (default-`LISTED` safety from #3099).
- No new XSUAA scope → no `cf update-service` gate; deploy with new routes + handler + the baked `prerelease` channel.
- **Ship order:** (1) §5 public semantic leak fix (standalone, must land — arguably its own commit/PR cherry-pickable to a #3099 hotfix if you later want it on main faster); (2) live gated nav handler + mount (testable via `cds watch` with a seeded ROLE_GATED row); (3) `prerelease` build channel + template branch + approuter routes (makes the surface reachable); (4) e2e. Steps 1–2 change no public behavior; step 3 adds the gated surface.
- **Baked-artifact caution:** the `prerelease` static shell shares the QA channel's fragility (rebuild-tarball wipe, local-deploy skip). Verify the shell is present on DEV after deploy (XSUAA-gated, so `curl` can't check it anonymously — use an authenticated check or the e2e).
