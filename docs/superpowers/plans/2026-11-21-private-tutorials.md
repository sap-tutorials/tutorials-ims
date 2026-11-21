# Private Tutorials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-tutorial `visibility` field (`LISTED`/`UNLISTED`/`ROLE_GATED`) that hides event-hidden tutorials from discovery and hard-gates pre-release tutorials behind an XSUAA scope, reusing the existing render/serve pipeline.

**Architecture:** One enum column on `Tutorials`, defaulting to `LISTED` (no data migration). Discovery surfaces (navigator view, search view, catalog feed, sitemap) suppress non-`LISTED`. Pre-release tutorials are served only via a new scope-gated approuter prefix `/tutorials-prerelease/*` → a distinct CAP mount `/content/tutorials-prerelease/*` (same serve handler, `gated: true` flag); the public route 404s ROLE_GATED slugs and never caches them (fail-closed).

**Tech Stack:** CAP (Node.js, CDS), SAP HANA, @sap/approuter, XSUAA, Hugo. Tests: Vitest/Jest unit (in-memory SQLite), existing `npm test -- <file>` scoped run.

**Spec:** `docs/superpowers/specs/2026-11-21-private-tutorials-design.md`

## Global Constraints

- PRs target **DEV**; never direct-merge to `main`. (per project memory)
- Never write raw SQL via CDS QL — but the serve handler already uses raw `db.run()` for BLOB/LOB reasons; follow the existing pattern in `packages/content/content-store.js` only there.
- Never SELECT a HANA BLOB alongside metadata in one CDS QL query (LOB locators expire) — the status/visibility lookup is metadata-only, keep it separate from BLOB reads.
- Enum values are exactly `LISTED`, `UNLISTED`, `ROLE_GATED` (strings). Default `LISTED`. Treat `null` as `LISTED` for the pre-activation window.
- XSUAA scope name exactly `$XSAPPNAME.Tutorial.PreRelease`; role-template `TutorialPreRelease`; role-collection `"Tutorials PreRelease"` — mirroring the existing `Tutorial.Author` trio.
- Gated approuter prefix exactly `/tutorials-prerelease/`; gated CAP mount exactly `/content/tutorials-prerelease/`.
- Scope changes require manual `cf update-service tutorials-xsuaa -c xs-security.json` after deploy, verified live before the gated route serves.

## Review Focus

- **Null visibility on existing rows** — before the column default activates on HANA, rows read `null`; every discovery filter and the serve gate must treat `null` as `LISTED` (don't hide existing tutorials, don't gate them). → covered in Tasks 2, 3, 6.
- **Cache leak across routes** — a ROLE_GATED body fetched via the gated route must never be served to a later public-route hit from the shared in-process cache or the edge CDN. → covered in Task 6 (no-store + no shared-cache entry + check-before-cache-hit).
- **Public route hitting a ROLE_GATED slug** — must 404 (not 403, not serve). → covered in Task 6.
- **UNLISTED still servable** — hide-only means a direct URL still works; the serve gate must NOT 404 UNLISTED on the public route. → covered in Task 6.
- **Scope referenced before it's live** — approuter route references `Tutorial.PreRelease` before the XSUAA re-push; rollout must sequence scope-live before gated serving. → covered in Task 5 + Rollout.

---

## Task 1: Add the `visibility` field and `Visibility` enum

**Files:**
- Modify: `db/schema.cds` (enum near `TaskStatus` line ~18; element on `Tutorials` body lines 46-73)
- Test: `srv/__tests__/` (new file `visibility-model.test.js`)

**Interfaces:**
- Produces: `com.sap.developers.ims.Tutorials.visibility` — enum string, default `'LISTED'`, values `LISTED|UNLISTED|ROLE_GATED`.

- [ ] **Step 1: Write the failing test** — `visibility-model.test.js`: insert a `Tutorials` row without `visibility`, read it back, assert `visibility === 'LISTED'` (default applies); insert one with `'ROLE_GATED'`, assert it round-trips.
- [ ] **Step 2: Run, verify it fails** — `npm test -- visibility-model` → FAIL (field unknown).
- [ ] **Step 3: Add to `db/schema.cds`** — `type Visibility : String(50) enum { LISTED; UNLISTED; ROLE_GATED; }` near line 18; add `visibility : Visibility default 'LISTED';` to the `Tutorials` entity body. Do **not** add to `TaskBase` (keep it per-tutorial).
- [ ] **Step 4: Run, verify it passes** — `npm test -- visibility-model` → PASS.
- [ ] **Step 5: Commit** — `feat(db): add Tutorials.visibility enum (#3099)`

## Task 2: Filter the navigator view

**Files:**
- Modify: `db/views.cds:95-96` (`NavigatorCatalog` view WHERE)
- Test: `srv/__tests__/` (`navigator-visibility.test.js`)

**Interfaces:**
- Consumes: `Tutorials.visibility` (Task 1).

- [ ] **Step 1: Write the failing test** — seed three tutorials (LISTED, UNLISTED, ROLE_GATED) wired into a published mission/path; read `NavigatorCatalog`; assert only the LISTED slug appears. Add a fourth with `visibility = null`; assert it DOES appear (null = listed).
- [ ] **Step 2: Run, verify it fails** — `npm test -- navigator-visibility` → FAIL (UNLISTED/ROLE_GATED present).
- [ ] **Step 3: Edit the view WHERE** — add `and (tut.visibility = 'LISTED' or tut.visibility is null)` to the `NavigatorCatalog` WHERE at `db/views.cds:95-96`.
- [ ] **Step 4: Run, verify it passes** — → PASS.
- [ ] **Step 5: Commit** — `feat(nav): hide non-listed tutorials from navigator (#3099)`

## Task 3: Filter the search index view

**Files:**
- Modify: `db/views.cds:112` (`SearchableItems` Tutorials-branch WHERE)
- Test: `srv/__tests__/` (`search-visibility.test.js`)

**Interfaces:**
- Consumes: `Tutorials.visibility` (Task 1).

- [ ] **Step 1: Write the failing test** — seed LISTED + UNLISTED + ROLE_GATED + null tutorials; read `SearchableItems` filtered to `taskType='TUTORIAL'`; assert only LISTED and null appear.
- [ ] **Step 2: Run, verify it fails** — `npm test -- search-visibility` → FAIL.
- [ ] **Step 3: Edit the view WHERE** — add `and (t.visibility = 'LISTED' or t.visibility is null)` to the Tutorials branch at `db/views.cds:112`.
- [ ] **Step 4: Run, verify it passes** — → PASS.
- [ ] **Step 5: Commit** — `feat(search): exclude non-listed tutorials from search index (#3099)`

## Task 4: Carry `visibility` on the catalog feed (do NOT filter it)

**Files:**
- Modify: `srv/lib/build-catalog.js:24-26` (add column, no predicate change)
- Test: `srv/__tests__/` (`build-catalog-visibility.test.js`)

**Interfaces:**
- Consumes: `Tutorials.visibility` (Task 1).
- Produces: each tutorial entry in the `/build/catalog` payload carries a `visibility` property. Consumed by Task 7 (sitemap front-matter).

- [ ] **Step 1: Write the failing test** — call `buildCatalogHandler` (or the function it delegates to) with a seeded UNLISTED tutorial; assert the tutorial entry is **present** in the payload AND has `visibility: 'UNLISTED'`. (Guards against accidentally filtering the feed.)
- [ ] **Step 2: Run, verify it fails** — `npm test -- build-catalog-visibility` → FAIL (`visibility` undefined).
- [ ] **Step 3: Edit the SELECT** — add `'visibility'` to the `.columns(...)` list at `srv/lib/build-catalog.js:24-26`. Do **not** change the `status` WHERE. Ensure the field is passed through into the emitted payload object.
- [ ] **Step 4: Run, verify it passes** — → PASS.
- [ ] **Step 5: Commit** — `feat(catalog): expose visibility on build-catalog feed (#3099)`

## Task 5: Add the `Tutorial.PreRelease` XSUAA scope + role, and the gated approuter route

**Files:**
- Modify: `xs-security.json` (scope after line ~37; role-template after the `TutorialAuthor` block ~127; role-collection after `"Tutorials Author"` ~197)
- Modify: `approuter/xs-app.json` (new route block mirroring the `Tutorial.Author` QA routes ~629-674)
- Test: none automated (config); verified in Task 8 smoke.

**Interfaces:**
- Produces: scope `$XSAPPNAME.Tutorial.PreRelease`; approuter route `^/tutorials-prerelease/(.*)$` → target `/content/tutorials-prerelease/$1`, `authenticationType: xsuaa`, `scope: $XSAPPNAME.Tutorial.PreRelease`, destination `srv-api`. Consumed by Task 6 (CAP mount) + Task 8 (smoke).

- [ ] **Step 1: Add XSUAA entries** — mirror the three `Tutorial.Author` entries in `xs-security.json` for `Tutorial.PreRelease` / `TutorialPreRelease` / `"Tutorials PreRelease"` (scope-references include `$XSAPPNAME.Everyone`, same as the Author trio).
- [ ] **Step 2: Add the approuter route** — insert the gated route block (exact shape in the design §3) into `approuter/xs-app.json`, placed with the other authenticated routes.
- [ ] **Step 3: Validate JSON** — `jq . xs-security.json >/dev/null && jq . approuter/xs-app.json >/dev/null` → no parse errors.
- [ ] **Step 4: Commit** — `feat(auth): add Tutorial.PreRelease scope + gated approuter route (#3099)`

## Task 6: Serve-gate ROLE_GATED tutorials (distinct mount + handler check + cache fail-closed)

**Files:**
- Modify: `packages/content/content-store.js` — status SELECT ~1295-1298 (add `visibility` column), `serveHandler` ~1116 and `serveStoredSlug` ~984 (gated flag, pre-cache check, no-store cache rules)
- Modify: `srv/server.js:849` area — add `app.get('/content/tutorials-prerelease/*slug', ...)` calling the shared handler with `{ gated: true }`
- Test: `srv/__tests__/` (`serve-gate-visibility.test.js`)

**Interfaces:**
- Consumes: `Tutorials.visibility` (Task 1); gated route from Task 5.
- Produces: public `/content/tutorials/*` mount (`gated: false`) + gated `/content/tutorials-prerelease/*` mount (`gated: true`), both → `serveHandler`.

- [ ] **Step 1: Write the failing tests** — four cases against the serve handler:
  (a) public route + ROLE_GATED slug → 404 (`serveNotFound`);
  (b) gated mount + ROLE_GATED slug → 200, served;
  (c) public route + UNLISTED slug → 200, served (hide-only, NOT gated);
  (d) gated-route response sets `Cache-Control: private, no-store` and the slug is NOT retrievable from the shared cache on a subsequent public hit (assert public hit after a gated hit still 404s — proves no cross-route cache leak).
- [ ] **Step 2: Run, verify they fail** — `npm test -- serve-gate-visibility` → FAIL.
- [ ] **Step 3: Implement** —
  - Add `visibility` to the status SELECT columns (`content-store.js:1295-1298`), metadata-only (no BLOB).
  - Thread a `gated` boolean into `serveHandler`/`serveStoredSlug` (bound per mount).
  - **Before `cache.get(slug)`** (line ~989): resolve visibility; if `visibility === 'ROLE_GATED'` and `!gated` → `serveNotFound` and return (runs on every request, including would-be cache hits).
  - When `gated && visibility === 'ROLE_GATED'`: set `Cache-Control: private, no-store` instead of `public, max-age=60`, and do **not** `cache.set(...)` for it (or key the cache by `gated`+slug so a gated entry can't satisfy a public lookup).
  - Treat `null`/`undefined`/`LISTED`/`UNLISTED` visibility as servable on the public route.
- [ ] **Step 4: Add the gated CAP mount** — in `srv/server.js` near line 849, mount `/content/tutorials-prerelease/*slug` to the shared handler with `{ gated: true }`; leave the public mount `{ gated: false }`.
- [ ] **Step 5: Run, verify they pass** — `npm test -- serve-gate-visibility` → PASS.
- [ ] **Step 6: Commit** — `feat(serve): hard-gate ROLE_GATED tutorials, fail-closed cache (#3099)`

## Task 7: Sitemap suppression via `private` front-matter

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (page front-matter generation; reads catalog `visibility` from Task 4)
- Test: `scripts/__tests__/` or the repo's TS test location (`fetch-tutorials-private.test.ts`) — if fetch-tutorials has no unit harness, a focused test around the front-matter emit function; otherwise document a manual check.

**Interfaces:**
- Consumes: catalog `visibility` property (Task 4).

- [ ] **Step 1: Write the failing test** — given a catalog entry with `visibility: 'UNLISTED'` (and one `ROLE_GATED`, one `LISTED`), the generated tutorial front-matter has `private: true` for UNLISTED and ROLE_GATED, and no `private` (or `false`) for LISTED.
- [ ] **Step 2: Run, verify it fails** — scoped test → FAIL.
- [ ] **Step 3: Implement** — in the front-matter emit path, set `private: true` when the catalog `visibility` for that slug is not `LISTED` (and not null). The Hugo template `hugo/layouts/_default/sitemap.xml` already excludes `.Params.private` — no template change needed.
- [ ] **Step 4: Run, verify it passes** — → PASS.
- [ ] **Step 5: Commit** — `feat(sitemap): exclude non-listed tutorials via private front-matter (#3099)`

## Task 8: Admin-UI affordance + smoke verification

**Files:**
- Modify: the tutorial admin Fiori form (field annotation enabling `visibility` edit — builder locates the admin entity projection for `Tutorials`)
- Test: `test/smoke/` or `test/e2e/` as fits the repo — a smoke assertion that the gated route 403s without the scope.

**Interfaces:**
- Consumes: scope + route (Task 5); gated mount (Task 6).

- [ ] **Step 1: Expose `visibility` on the admin projection** — add the field to the admin service projection of `Tutorials` so it's editable; a dropdown falls out of the enum type. (Follow existing admin-field patterns.)
- [ ] **Step 2: Smoke test (post-deploy, documented)** — against a deployed DEV env with a ROLE_GATED tutorial: `GET /tutorials-prerelease/<slug>` without the role → 403 at approuter; with the role → 200. `GET /tutorials/<slug>` (public) for the same slug → 404. Record as a smoke/e2e step (self-skips without `SMOKE_BASE_URL`, per repo convention).
- [ ] **Step 3: Commit** — `feat(admin): edit tutorial visibility; smoke-gate pre-release (#3099)`

---

## Rollout

DEV-first. Default `LISTED` keeps the change inert until a tutorial is marked otherwise.

**Ship order (each step independently safe):**
1. Tasks 1–4, 7 — data model + discovery suppression + sitemap. Makes UNLISTED fully work and hides ROLE_GATED from discovery.
2. Tasks 5–6 — XSUAA scope/role + approuter gated route + handler gate. **Before this serves:** run `cf update-service tutorials-xsuaa -c xs-security.json` and verify `Tutorial.PreRelease` is live (MTA deploys skip the re-push). Admin edit (Task 8) can land with either step.

Fail-closed everywhere: if `visibility` can't be read, a ROLE_GATED-marked row is never served on the public route; discovery filters treat unknown as LISTED (don't accidentally hide everything).

## Self-review notes

- **Spec coverage:** field (T1), three discovery seams (T2 nav, T3 search, T4+T7 sitemap), serve gate (T6), XSUAA+route (T5), admin (T8) — all design sections mapped.
- **Type consistency:** `visibility` string enum used identically across T1–T7; `gated` boolean defined T6 and used only there; catalog `visibility` property produced T4 / consumed T7.
- **Review Focus:** all five pinned to tasks (null→T2/T3/T6, cache leak→T6, public-404→T6, UNLISTED-servable→T6, scope-sequencing→T5/Rollout).
- **Proportion:** plan is signatures + test names + exact values; no function bodies transcribed. In proportion to the design.
