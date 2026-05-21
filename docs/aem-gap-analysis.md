# AEM → tutorials-poc Gap Analysis

> **Scope:** Identify functional gaps between the live AEM-backed developers.sap.com and the tutorials-poc replacement, including edge cases not yet in the team's TODO list.
>
> **Companion document:** `aem-current-state.md` is the historical reference for how AEM works today.
>
> **Filter:** Tutorial *authoring* is out of scope (authors use GitHub + VS Code extension). Only publishing, sysadmin, public delivery, and cross-cutting concerns are considered.
>
> **Date:** 2026-05-20.

---

## Severity Legend

| Severity | Meaning |
| --- | --- |
| **P0 — Blocker** | Tutorials or core flows break for end users at cutover. Must fix or keep AEM running. |
| **P1 — Major** | Significant capability missing; degrades UX, SEO, or operations. Plan before cutover. |
| **P2 — Minor** | Small gap or polish item; can ship after cutover. |
| **Edge case** | Not yet on the team's radar; needs a decision. |

---

## P0 — Blocker Gaps

### 1. ~~HANA Live Demo Proxy~~ — **Dead feature, retired**

**AEM:** `LiveDemoProxyServlet` at `/bin/sapdx/developer/hana/proxy.{algorithm-definition|job-submit|job-sql}.json` proxying to `https://trydd27584c4.us2.hana.ondemand.com/try/api`. Author-side dropdown (`LiveDemoOptionsService`) configured only under `config.author/`.

**Investigation (2026-05-20):**

- Grepped 200+ cached tutorial markdown files for every URL pattern, selector, and the backend hostname — **zero matches**. No GitHub-authored tutorial references this feature.
- Backend `https://trydd27584c4.us2.hana.ondemand.com/` returns **HTTP 503** — host resolves in DNS but the app is dead. The `tryXXX.us2.hana.ondemand.com` naming is the HANA Cloud trial pattern, likely long-expired.
- The dropdown service config exists only under `config.author/`, indicating the picker was an authoring-time tool, not a published-page feature.

**Confirmed dead 2026-05-20.** No replacement work required.

**Action:** None.

---

### 2. ~~GitHubProxyServlet — Private Repo Image Serving~~ — **Dead in practice, retired**

**AEM:** Sling resource-type servlet (`RESOURCE_TYPE_DEVELOPERS_TUTORIAL_PAGE` + selector `github-proxy` + extension `file`). URL pattern: `<tutorial-page>.github-proxy.file<image-suffix>`. Reads `repoName` from JCR ValueMap, calls `GitHubService.getContents()`, Base64-decodes the response, and streams image bytes. Class JavaDoc: "Servlet that proxies requests for resources from GitHub private repositories."

**Investigation (2026-05-20):**

- Grepped `.tutorial-cache/` (200+ raw tutorial markdown + sha + rules.vr files) and `hugo/content/tutorials/` (all generated pages) for `github-proxy` — **zero matches**.
- Sampled 10 tutorials with `raw\.githubusercontent\.com` — **101 hits**. Every image already resolves to a public CDN URL.
- All tutorial source lives in the **public** `sap-tutorials` GitHub org. The `-Contribution` companion repos (e.g., `abap-core-development-Contribution`) hold `rules.vr` validation files only — they are not image hosts.
- The replacement fetcher (`scripts/parsers/github.ts`) explicitly excludes `-Contribution` repos by default (`includeContribution = false`); even if those repos contained images, our discovery would skip them.

**Confirmed dead 2026-05-20.** The proxy was a defensive capability for a content layout that the team never adopted. No replacement work required.

**Action:** None. If a future tutorial author commits an image inside a `-Contribution` repo (against current convention), the build will surface a broken image link — that is the correct failure mode.

---

### 3. Tutorial URL Redirect Map

**AEM:** `/conf/.../redirects/...` JCR tree, processed by `RedirectFilter`. CSV-importable, sysadmin-maintained. Hundreds (likely thousands) of 301s for old URL patterns, retired tutorials, locale-prefix changes.

**Replacement:** No redirect map. The AppRouter has `xs-app.json` route patterns but no per-URL 301 table.

**Impact:** SEO loss. Old `developers.sap.com/tutorials/<old-slug>` URLs that currently 301 will 404 in the replacement. Search engines de-rank, marketing campaigns break, blog backlinks rot.

**Remediation:**
- Export the JCR redirect map (CSV).
- Import into either (a) `xs-app.json` `route` entries for static patterns, (b) a CAP middleware that consults a HANA `Redirects` entity, or (c) AppRouter's destinations forwarding rules.

**Action:** Get a JCR export from the AEM team, then build a redirect mechanism. **This is the easiest gap to forget and the most expensive to discover post-cutover.**

---

### 4. GitHub Fetcher Robustness — **Addressed (2026-05-20)**

**AEM:** Hourly Sling Scheduler, multi-token OAuth pool with rate-limit-aware rotation, per-repo failure isolation, manual force-refresh sysadmin endpoint.

**Replacement:** `scripts/fetch-tutorials.ts` runs from GitHub Actions, single `GITHUB_TOKEN`, on-demand cadence rather than hourly.

**Mitigation tiers shipped:**

1. **GraphQL retry** (PR #10): 8-attempt exponential backoff with jitter on the discovery query, honors `Retry-After`.
2. **Raw CDN retry**: `fetchMarkdown()` now uses the same `fetchWithRetry` helper — extracted to `scripts/parsers/github.ts` and shared with `graphqlRequest`. Transient 5xx/429/network errors on `raw.githubusercontent.com` no longer abort an individual tutorial.
3. **Local disk fallback** (PR #10): `discoverAllTutorials()` reads `.tutorial-cache/_discovery.json` if GitHub fails.
4. **CI cache persistence**: `.github/workflows/rebuild-content.yml` now restores `.tutorial-cache/` between runs via `actions/cache@v4`, making tier 3 effective on fresh runners.
5. **HANA RepoCatalog fallback**: New `RepoCatalog` entity in `db/schema.cds` with `/build/repo-catalog` endpoints. The fetcher writes the discovery map to HANA on every successful GitHub run (gated on `source === 'github'` so prolonged outages don't refresh `lastSyncedAt` with stale data) and falls back to it when both GitHub and the disk cache miss. Bearer auth on POST reuses `CONTENT_API_KEY` and `contentAuthMiddleware` — no second secret.
6. **Author self-service single-tutorial refresh**: `rebuild-content.yml` accepts an optional `slug` input on `workflow_dispatch`. The fetch step reads it as `TUTORIAL_SLUG`, busts that slug's markdown cache, regenerates everything else from cache, and skips the HANA `RepoCatalog` upload (a partial run must not overwrite the catalog). Authors trigger refreshes themselves from the GitHub Actions UI — no admin-mediated tooling required.
7. **GitHub App credential migration (staged)**: The fetch workflow now conditionally generates a short-lived (1h TTL) installation token via `actions/create-github-app-token@v1`, gated on repo variable `USE_GITHUB_APP=true`. Until the org admin completes registration the step is skipped and the existing PAT path is used. See [`github-app-migration.md`](github-app-migration.md) for rationale and [`github-app-setup.md`](github-app-setup.md) for the org-admin runbook. This eliminates the recurring SAP-PAT-expiry build break and removes the human-account dependency without requiring any code change.

The three-tier discovery chain is `GitHub → disk cache → HANA RepoCatalog`. A complete GitHub outage on a fresh runner with empty actions cache now still recovers the last known-good catalog.

**Still queued (not blocking cutover):**

- **GitHub App org registration** — workflow code is in place; activation requires the org admin to register `sap-tutorials-builder`, generate a private key, and install on the `sap-tutorials` org. Tracked in [`github-app-setup.md`](github-app-setup.md).
- **Multi-token rotation** — won't do. Single token is sufficient for current build cadence (well under any rate limit). Revisit only if rate-limit incidents recur. AEM's pool addressed an hourly-cadence problem we no longer have.
- **REST-only discovery fallback** — won't do. Was level 3 of the original 4-level plan; the HANA tier is a strictly stronger replacement (durable, source-tagged, survives runner-cache loss). Adding REST below HANA would only help in the narrow window where GraphQL is down but REST is up *and* HANA is also unreachable — which is implausible enough to not be worth the carry cost.

---

### 5. Akamai CDN Purge Integration

**AEM:** `AkamaiCachePurgeService` invalidates Akamai cache on each replication. Without it, edits would take up to TTL (often hours) to propagate.

**Replacement:** No CDN purge call. If Akamai (or any CDN) sits in front of AppRouter in production, content updates won't be visible until TTL expires.

**Impact:** Authors push a fix → publish-content runs → HANA updated → AppRouter serves new content → **CDN still serves old content for hours**.

**Remediation options:**
- Set short TTL on tutorial content (Cache-Control max-age=300) and accept stale window.
- Add Akamai Fast Purge call to `publish-content.ts` after upload.
- Switch to CDN with native invalidation hooks.

**Action:** **Out of project scope.** CDN configuration (whether Akamai or any other) is owned by SAP infrastructure, not this team. If a CDN sits in front of the BTP route post-cutover, the infra team will configure invalidation/TTL alongside the DNS swap. If no CDN is added, the AppRouter + HANA cache layer is the canonical surface — no work required here.

**Decision (2026-05-20):** Documented and parked. Surface to infra during cutover handoff; do not build a purge integration in this codebase unless explicitly asked.

---

## P1 — Major Gaps

### 6. Solr Search Parity

**AEM:** `SolrSearchServlet` proxies to a Solr cluster. Faceted search across tutorials, missions, blog posts, and other developers.sap.com content. Stemming, typo tolerance, custom relevance weighting.

**Replacement:** CAP `SearchService` (`/search/SearchableItems` + `getFacets`) over a UNION ALL view of Tutorials + Missions + Groups (active + published only). HANA full-text fuzzy + ranking declared via `@Search.fuzzinessThreshold: 0.7` and `@Search.ranking: #HIGH/#MEDIUM/#LOW` annotations on the projection.

**Scope decision (2026-05-20):**

- **Cross-content-type search:** dropped. AEM Solr also serves non-developers.sap.com sites (blogs, community); that's out of our boundary. Our scope is Tutorials + Missions + Groups + their metadata.
- **Multi-language stemming:** dropped. Site is English-only ([gap #7](#7-multi-language--i18n--not-a-gap)). Language analyzers were never load-bearing here.

**Bug found and fixed (2026-05-20):** `srv/search-service.js` had a `before('READ')` handler that intercepted `$search`, ran a `LIKE` lookup against `TutorialTags`, then **cleared `req.query.SELECT.search` and replaced it with a manual `WHERE title LIKE '%foo%' OR description LIKE '%foo%' OR …'`**. Net effect:

- The `@Search.fuzzinessThreshold` and `@Search.ranking` annotations were dead code — they're applied by CAP only when the search clause survives to the DB layer. The handler erased it.
- Typo tolerance, English stemming, and field-weighted ranking were all silently disabled in production.
- `getFacets` had the same `LIKE` pattern, so facet counts were also exact-substring rather than fuzzy.

The handler has been removed and `getFacets` refactored to use `SELECT.from(SearchableItems).search(...)` (the same shape `srv/lib/chat-orchestrator.js:81` uses). CAP now translates `$search` to HANA `CONTAINS(... FUZZY(0.7))` with column ranking on production, and to `LIKE` on SQLite for unit tests — same dev-loop behavior, real fuzzy + ranking in HANA.

**Remaining items:**

- **Tag-name expansion (deferred).** The old handler attempted to widen results when the search term matched a `Tags.name`, returning the linked tutorials. It only joined `TutorialTags` (never `MissionTags`/`GroupTags`) and OR-ing tag matches with a CONTAINS clause requires either (a) adding tag names as a column on `SearchableItems` or (b) a separate `searchByTag` function — both out of scope for the bug fix. Park unless event analytics show users searching for bare tag names.
- **Body text indexing — addressed (2026-05-20).** A new sidecar entity `TutorialBodyText` (slug-keyed `LargeString`) stores plain-text projections of the published Hugo HTML. `scripts/publish-content.ts` strips `<script>`/`<style>`/`<nav>`/`<footer>`/`<aside>` from `<main class="tutorial-main">`, decodes entities, normalizes whitespace, and ships the result alongside the HTML payload to `POST /content/publish`, which per-slug-upserts it into HANA. `db/views.cds` `LEFT JOIN`s `TutorialBodyText` into the Tutorials branch of the `SearchableItems` UNION-ALL view, projecting `null as bodyText : LargeString` for Missions/Groups so the union is uniform. `srv/search-service.cds` opts the column into `$search` via `@cds.search: { title, description, primaryTag, bodyText }` (LargeString is excluded from default search) and ranks it `@Search.ranking: #LOW`. `srv/search-service.js` strips `bodyText` from OData responses via an `after('READ')` hook (using `@cds.api.ignore` would also exclude it from the search runtime — found and rejected during implementation). Net effect on HANA: body text contributes to `CONTAINS(... FUZZY(0.7))` matches with low weight, and tutorials are now findable by words that appear in the body but not in metadata. Verified on SQLite by the `$search=ipallowlist` unit test (`test/search-service.test.js`).

**Action:** Sample 20 representative production search queries (Adobe Analytics or Google Search Console — AEM admin-team request can run in parallel) and replay them against the fixed `SearchService`. The hybrid test `test/hybrid/search-service.test.js` already covers fuzzy + facet structure; extend it with a fixed query list once representative queries are in hand.

---

### 7. ~~Multi-language / i18n~~ — **Not a gap**

**AEM:** Language masters under `/content/developers/<lang-code>/...` exist for `en_us`, `de_de`, `es_co`, `zh_cn`, `en1`.

**Reality (confirmed 2026-05-20):** developers.sap.com is **English-only**. Non-`en_us` locale folders are legacy/deprecated and carry no live content. No translation/copy workflow is exercised in production.

**Action:** None for content. The only residual concern is incidental traffic to old non-`en_us` URLs from stale links or search engines — handle via the redirect map (gap #3) by pointing them to the `en_us` equivalent or a generic landing page. Do **not** build i18n into Hugo or the parsers.

---

### 8. Sitemap.xml Generation — addressed (2026-05-20)

**AEM:** A sitemap servlet was assumed to walk `/content/developers/...` and emit per-locale `<urlset>`s. **Production check (2026-05-20): `https://developers.sap.com/sitemap.xml` and `/robots.txt` both return 404.** AEM was not actually publishing a public sitemap, so this isn't a parity gap — it's a net-new SEO improvement.

**Replacement:** `hugo/layouts/_default/sitemap.xml` (commit `825c51a`, repaired 2026-05-20).

**Verification against the original criteria:**

- Tutorial URLs match production (no `/dev/` prefix) — `baseURL = 'https://developers.sap.com/'`.
- Mission and group URLs included — template branches on `.Type` for `tutorials`/`missions`/`groups` and `fetch-tutorials.ts` writes both into `hugo/content/{missions,groups}/`.
- Per-locale `hreflang` — N/A, site is English-only (see `developers_locales` memo).
- `lastmod` reflects content update time, not build time — frontmatter chain `[lastmod, lastUpdated, :git, :fileModTime]` from [hugo.toml:17](../hugo/hugo.toml#L17). Sample output spans 2021-08-08 to 2026-05-12 on a 2026-05-20 build.

**Initial bug found and fixed during verification:** the template iterated `.Data.Pages` which on the home output context resolves to `.Pages` — only the four top-level sections (4 URLs, 1,379 tutorials missing). Switched to `site.Pages` and added `term` to the kind exclusion list. Fresh build now emits 1,384 URLs.

**Residual cleanup — resolved (2026-05-20):**

- `hugo/content/tutorials/test-tutorial.md` retained as a layout/shortcode smoke fixture but marked `private: true` so it no longer leaks into the public sitemap.
- `/scanner-vue/`, `/event-display/`, `/app-space/` `_index.md` files now carry `private: true`, excluding these auth-gated sections from the sitemap via the existing `not .Params.private` filter in [hugo/layouts/_default/sitemap.xml](../hugo/layouts/_default/sitemap.xml).

---

### 9. NextStepsServlet (Recommendation Engine) — ✅ Resolved (2026-05-20)

**AEM:** Returns "next tutorial" suggestions based on tag overlap, mission membership, and (likely) IMS data on what other users completed after this tutorial.

**Replacement:** Build-time recommendations baked into Hugo `nextSteps` frontmatter, rendered as the "Related Tutorials" rail on every tutorial page.

**Resolution:**

- v1 (tag overlap, shipped at tag `recommendations-v1-shipped` / `561118a`): Pure tag-overlap scoring with primary-tag bonus and same-mission exclusion. Computed in `scripts/parsers/recommendations.ts` during `npm run fetch-tutorials`.
- v2 (co-completion blend, shipped 2026-05-20): Two-pass blended scorer combines 60% co-completion (from `TaskRecords` aggregator at `/build/co-completions`) with 40% tag overlap; corpus-wide normalization avoids iteration-order bias. Falls back to v1 when CAP catalog is offline. See plan: [docs/superpowers/plans/2026-05-20-next-steps-recommendations.md](superpowers/plans/2026-05-20-next-steps-recommendations.md).
- v3: Feed into Joule (queued in `project_joule_completion_suggestions.md`).

---

### 10. GitHub Feedback → Issues — ✅ Resolved by existing implementation

**AEM (claimed):** Three feedback servlets (tutorial / group / mission) collect user feedback at the bottom of each page and open GitHub issues against the source repo using a service token. Three issue templates configurable via OSGi config.

**AEM (actual production behavior):** The servlet code exists in `core.tutorial`, but production routing short-circuits to a deeplink against GitHub's `issues/new` form with prefilled query parameters. The "service token + issue creation" code path is not exercised — users authenticate with their own GitHub account and submit the issue under their own identity. Verified against production developers.sap.com on 2026-05-20.

**Replacement:** [`hugo/layouts/partials/feedback-share.html`](../hugo/layouts/partials/feedback-share.html) already implements this pattern with two channels:

1. **GitHub deeplink** (line 38) — `https://github.com/sap-tutorials/Tutorials/issues/new?title={{ .Title }}` opens the issue form with the tutorial title prefilled. User signs in with their own GitHub account.
2. **Qualtrics survey** (line 43) — anonymous feedback channel for users who don't have or don't want to use GitHub.

This matches (and arguably improves on) what production AEM actually does today.

**Why a server-side `octokit` endpoint is *not* worth building:**

| Argument for the API approach | Reality |
| --- | --- |
| Lets non-GitHub users submit feedback | Qualtrics survey already covers this |
| Adds richer metadata to the issue | Deeplink can prefill `body=` with browser/step/slug too |
| Server-side spam protection | GitHub already filters per-user abuse; PAT-created issues bypass that and *increase* spam risk |
| Centralized routing per repo | Hugo template can pick the source repo per tutorial just as easily |

Costs avoided: a long-lived GitHub PAT (rotation, expiry, secret hygiene), a new auth surface that needs captcha/rate-limits, issues created under a bot account with no GitHub identity for follow-up, and ~50–100 lines of code to maintain forever.

**Optional enhancement:** Enrich the deeplink `body=` with slug, step number, permalink, and user agent so authors receive actionable reports without any server code:

```html
<a href="https://github.com/sap-tutorials/{{ .Params.repository }}/issues/new?title=Feedback: {{ .Title }}&body=**Tutorial:** {{ .Params.slug }}%0A**URL:** {{ .Permalink }}%0A%0A_Describe the issue:_">
```

**Action:** None required. Gap closed.

---

### 11. ~~Hero / SubNavigation / Resources Content Fragments~~ — **Not in scope**

**AEM:** Content Fragment authoring (out of scope per Tom) but the *rendered output* of these fragments composes the homepage and many landing pages. The hero banner, secondary navigation per topic area, and the "related resources" rail are content-fragment-driven.

**Scope decision (2026-05-20):** The tutorials-poc project replaces **only the `/tutorials/*` section** of developers.sap.com. The homepage, topic landing pages, hero banners, sub-navigation rails, and "related resources" components live outside the tutorials section and will be redirected to the SAP Community site at cutover, not reimplemented here.

**Verification:** Grepped `hugo/` for `hero|subnav|relatedResources|content-fragment` — all hits are either (a) CSS class names in the existing Hugo homepage layout (which is itself transitional and will be redirected), or (b) incidental occurrences of the word "hero" inside tutorial code samples. No tutorial-section-internal content fragment was found. If a future requirement surfaces a *tutorial-section* hero or rail (e.g., a "Featured tutorials" component at `/tutorials/`), it would be reopened as a separate gap.

**Action:** None. Composition for non-tutorial pages is handled by the redirect map (gap #3) pointing those URLs at SAP Community equivalents.

---

### 12. ~~Adobe Analytics~~ — **Not in scope**

**AEM:** Adobe Analytics tags injected via clientlib. Tracks page views, tutorial-step views, outbound link clicks, search queries.

**Scope decision (2026-05-20):** Adobe Analytics for developers.sap.com has been **turned off in production for some time** (confirmed by Tom). There are no live dashboards consuming the data and no marketing/PMM workflow that depends on it. There is nothing to preserve at cutover.

**Action:** None. If analytics are ever reintroduced, it will be as a net-new decision (likely SAP Analytics Cloud or a current-generation tool, not Adobe Analytics) and tracked as a fresh requirement rather than as AEM parity.

---

### 13. Cookie Consent — ✅ Closed 2026-05-21

**AEM:** Cookie consent banner (likely OneTrust) injected via clientlib.

**Replacement:** Self-contained consent banner shipped in commit `367a801` (merged 2026-05-21), aligned to the production SAP CMP shape: Required / Functional / Advertising categories, "Understood" (accept all) + "Manage Settings" + close (X) on the banner, modal dialog with toggles and Submit Preferences / Cancel. Public API exposed as `window.consent.has() / show() / onChange()`. Companion Hugo pages added: `hugo/content/cookies.md` (platform-specific inventory) and `hugo/content/privacy.md` (controller info, legal basis, user rights). Footer carries a "Site Information" row linking to Privacy, Cookie Preferences, etc. Designed to be ripped out cleanly when SAP Legal mandates the corporate CMP — no innerHTML, single JS file, embedded CSS.

**Note for future work:** When SAP Legal hands over the corporate CMP property, swap the self-contained banner for the corporate snippet and retire `window.consent.*`. Footer placeholder hrefs (Terms of Use, Legal Disclosure, Trademark, Newsletter, Text View) still need canonical URLs from the legal team.

---

### 14. Error Pages (404 / 500) — ✅ Closed 2026-05-20

**AEM:** Custom Handlebars 404 with site search box and "popular tutorials" rail. Generic 500.

**Replacement:** Hugo emits styled `404.html`, `500.html`, `maintenance.html` (503). AppRouter `xs-app.json` maps each status to its file via the top-level `errorPage` config. Tutorial-slug 404s are served by CAP from the published `__404__` slug (`srv/lib/content-store.js` `serveNotFound()`), preserving the styled body with status 404.

**Verified:** `test/smoke/error-pages.test.js` covers (a) generic 404 carries the popular-tutorials rail and search form, (b) `/500.html` and `/maintenance.html` serve the styled bodies, (c) missing tutorial slugs return 404, (d) proxied API 404s pass through unmodified — the AppRouter `errorPage` map only fires for middleware `next(err)` paths, not for proxied response bodies (confirmed against `@sap/approuter/lib/middleware/error-handler.js`).

**Note for future work:** The AppRouter schema only allows `errorPage` at the top level — there is no per-route `errors` override. We don't need one because CAP's `__404__` mechanism already returns styled HTML for missing tutorials.

---

### 15. Trials & Downloads Checksum Servlet — ✅ Closed 2026-05-21

**AEM:** `ChecksumServlet` at `/bin/sapdxc/trials-and-downloads/checksum.{id}.html` reads `/content/dam/headless/developers/en/trials-and-downloads.json` (DAM-authored by the SAP downloads team) and serves a single line of HTML per row: `<div style="font-family: monospace;">{checksum} *{fileName}</div>`. Used as a lazy drilldown on a searchable, paginated table at the `/trials/...` page (template `trialsAndDownloadsLayoutPage`, model `TrialsAndDownloadsModel` — columns: Name · Release Date · Version · File Size · Comments · Checksum · Trial Button). Cache invalidation handled by `TrialsAndDownloadsListener` which flushes Dispatcher + Akamai when the JSON is replicated.

**Investigation (2026-05-21):**

- `https://developers.sap.com/trials/` → **404** (already retired upstream).
- `https://developers.sap.com/trials-downloads.html` → **301** → `https://www.sap.com/products/try-sap/trials-downloads.html`. Tom confirmed the trials index has been moved to `www.sap.com` and the redirect is wired into AEM/Akamai today. Query strings pass through cleanly (verified: `?search=sdk%20for%20android` is preserved end-to-end).
- `https://developers.sap.com/bin/sapdxc/trials-and-downloads/checksum.{id}.html` → **200** body `<div ...>Checksum was not found</div>` for any `id`. The servlet still resolves but the DAM JSON is empty/depopulated; the SAP downloads team apparently embedded checksums directly into the new sap.com page. **Effectively dead in production.**
- Tutorial corpus scan (`.tutorial-cache/`, 200+ files): **11 tutorials** link to `https://developers.sap.com/trials-downloads.html?search=<topic>` — all are mobile/SDK/ABAP setup tutorials directing the reader to download an SDK or trial binary. Files: `sdk-android-wizard-app`, `sdk-ios-setup`, `sdk-ios-multi-user`, `abap-env-create-table-type`, `abap-create-project`, plus six `cp-mobile-dev-kit-*` tutorials. **Zero references** to `/trials/` (path), `/bin/sapdxc/trials`, or `trialsAndDownloads`.

**Replacement:** Server-side 301 redirect added to `approuter/server.js` via a new `redirectsHandler` middleware ([approuter/server.js:108-128](approuter/server.js#L108-L128)). Path-keyed regex map (`LEGACY_REDIRECTS`) so we can add more cutover redirects without growing the handler. Behavior:

- `GET /trials-downloads.html` → `301` → `https://www.sap.com/products/try-sap/trials-downloads.html`
- Query string captured by the regex group and appended verbatim to the target — preserves the `?search=<topic>` deep-links the 11 tutorials rely on
- `Cache-Control: public, max-age=86400` so the AppRouter doesn't re-emit on every request
- `HEAD` redirects too (link-checkers, SEO crawlers)

**Verified:** [test/smoke/redirects.test.js](test/smoke/redirects.test.js) covers (a) bare path 301 + correct Location, (b) `?search=...` query-string preservation including URL-encoded space, (c) `HEAD` redirects identically. Runs in CI after deploy via `npm run test:smoke`.

**Out of scope (deliberately):** The `ChecksumServlet` itself is **not** mirrored. It's already returning "not found" upstream, no live page consumes it, and no tutorial links to its path. If the SAP downloads team ever re-introduces the lazy-checksum pattern they'd own a new endpoint on `www.sap.com`, not on developers.sap.com. The page-level UI (search, table, columns) is also out of scope — that's `www.sap.com`'s responsibility now. The cache-invalidation listener has nothing to invalidate.

**Note for future work:** If additional AEM URL paths surface during cutover (e.g., from external bookmarks or stale search results), add them to `LEGACY_REDIRECTS` rather than reinstating per-route entries in `xs-app.json` — the AppRouter schema cannot emit cross-domain 301s, only internal rewrites. The 11 affected tutorial source files in the `sap-tutorials` GitHub org could optionally be patched to link directly at `www.sap.com` to drop the redirect hop, but it's cosmetic since the 301 covers them and externally-cached old links keep working.

---

## P2 — Minor Gaps

### 16. Siteimprove Integration — ✅ Closed 2026-05-21

**AEM:** Accessibility/SEO scoring via Siteimprove SaaS. Sysadmin/content-quality tool.

**Replacement:** axe-core + Lighthouse CI in the deploy pipeline (warn-only). See [test/a11y/](../test/a11y/) and the `a11y-scan` job in [.github/workflows/deploy.yml](../.github/workflows/deploy.yml).

- `test/a11y/axe.test.js` — Playwright + `@axe-core/playwright`, scans WCAG 2.1 AA + best-practice rules across 8 pinned public pages (`test/a11y/urls.js`).
- `test/a11y/lighthouserc.json` — Lighthouse CI with category budgets (perf ≥ 0.80, a11y ≥ 0.95, best-practices ≥ 0.90, SEO ≥ 0.95). Reports uploaded to LHCI temporary public storage; links surface in the workflow run summary.
- Both run after `smoke-test` on every deploy run; results combined into the GitHub Actions job summary by `test/a11y/summary.js`.

**Status:** Resolved (warn-only). Re-onboarding to Siteimprove is no longer required.

**Follow-ups:**

- Flip to gating (replace `expect(true).toBe(true)` in `axe.test.js`, change Lighthouse `assertions` from `warn` to `error`) once a baseline is established.
- Authenticated scans for `/admin-ui/` and `/scanner-ui/` need a Playwright login fixture — deferred until the warn-only baseline stabilises.
- PR-time signal needs either preview deploys per branch or a separate PR workflow scanning the static Hugo build (the latter would miss tutorials since they're served from HANA).

---

### 17. Robots.txt as Author-Editable Page — ✅ Closed 2026-05-21

**AEM:** `robots-page` template lets sysadmins edit `robots.txt` without code changes.

**Replacement:** Shipped as Hugo template at `hugo/layouts/robots.txt` (commit `2c49420`, 2026-05-20). Disallows `/api/`, `/admin/`, `/admin-ui/`, `/scanner-ui/`, `/event-display/`, `/display/`; explicit allowlist for major search bots (Googlebot, Bingbot, DuckDuckBot) and AI assistants (GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, Claude-Web, anthropic-ai, PerplexityBot, Applebot-Extended, Google-Extended); references `https://developers.sap.com/sitemap.xml`. Companion work: `c6dab41` adds `Content-Signal` and `X-Robots-Tag` response headers in approuter; `2d7e7cb` adds a smoke test that verifies the SEO files (robots, sitemap, llms, AGENTS, og-default) on the deployed approuter.

**Note for future work:** Sysadmin editability is intentionally not provided — changes go through PR review, which AEM's author-editable page never had.

---

### 18. Six Responsive Breakpoints + AdaptiveImage Pipeline — ✅ Closed 2026-05-21

**AEM:** `AdaptiveImage` component with six breakpoints, art-direction support, lazy loading.

**Replacement:** Shipped in commit `94b9bd5` (2026-05-21) as a two-tier pipeline — build-time `srcset` emission + request-time transcoding proxy. Coverage:

| AEM AdaptiveImage feature | Status |
| --- | --- |
| Lazy loading | ✅ `loading="lazy" decoding="async"` on every `<img>` ([hugo/layouts/_default/_markup/render-image.html:27-28](../hugo/layouts/_default/_markup/render-image.html#L27-L28)) |
| Responsive `srcset` | ✅ 480w/960w/1440w buckets via `/img-cdn/?u=…&w=…` with `sizes="(max-width: 640px) 100vw, (max-width: 1024px) 90vw, 960px"` ([render-image.html:17,22](../hugo/layouts/_default/_markup/render-image.html#L17-L22)) |
| Width-bucket resize | ✅ `sharp.resize({ width, withoutEnlargement: true })` in approuter `/img-cdn` proxy ([approuter/server.js:22-104](../approuter/server.js#L22-L104)) |
| Intrinsic dimensions (CLS prevention) | ✅ probed at fetch time via `probe-image-size`, cached in `.tutorial-cache/`, written as `width`/`height` attrs ([scripts/parsers/image-dimensions.ts](../scripts/parsers/image-dimensions.ts)) |
| Format negotiation | ✅ **Stronger than AEM** — per-request WebP transcoding via `Accept` header, with passthrough for non-image MIME types and origin formats sharp can't process. AEM only had pre-rendered variants. |
| Caption support | ✅ `<figure>/<figcaption>` when alt is meaningful ([render-image.html:19,30](../hugo/layouts/_default/_markup/render-image.html#L19-L30)) |
| Click-to-zoom | ✅ Lightbox via `data-zoomable="true"` ([hugo/assets/js/tutorial.ts](../hugo/assets/js/tutorial.ts)) — AEM didn't have this |
| Dark-mode brightness adjust | ✅ Image filter applied via `html.dark` (commit body, tier 1) — AEM didn't have this |

**Two deliberate deltas from strict AEM parity:**

1. **3 width buckets, not 6.** We ship 480w/960w/1440w. AEM's six likely added 320/720/1920. The SAP Fundamental grid only differentiates at 640px and 1024px, so extra buckets would inflate the proxy cache without changing the variant the browser picks for our `sizes` attribute. Revisit only if the design adds a wider hero or a sub-mobile breakpoint.
2. **No `<picture>` art-direction support.** AEM let authors specify per-breakpoint crops via the Touch UI dialog. Our markdown source has no shortcode for this and tutorial authors have never had the affordance in the GitHub workflow — capability gap on paper, zero practical impact. Revisit only if a tutorial author asks for it.

**Note for future work:** The `/img-cdn` proxy is allowlisted to `raw.githubusercontent.com` only — if tutorials ever reference images from another host, either extend `IMG_CDN_HOSTS` in [approuter/server.js](../approuter/server.js) or fall back to the upstream URL in `render-image.html` (the template already gates the rewrite on the `raw.githubusercontent.com/` prefix).

---

### 19. Print Stylesheet ✅

**AEM:** Print CSS in clientlib hides nav/sidebar/footer for clean tutorial printouts.

**Replacement:** [hugo/assets/css/print.css](../hugo/assets/css/print.css), loaded via `media="print"` from [hugo/layouts/partials/head.html](../hugo/layouts/partials/head.html). Hides shellbar/breadcrumbs/feedback-share/sidebar/mini-nav/nav-bottom/next-steps/footer/Joule/lightbox/consent banner; force-opens collapsed step accordions (`.step-body[hidden]` → `display: block`); overrides `html.dark` design tokens so dark-mode users print on white; wraps `<pre>` with `white-space: pre-wrap` + a border so code blocks don't clip at the page margin; adds `break-inside: avoid` on steps/images/tables; appends external URLs after content links via `::after`. Verify by toggling Chromium DevTools → Rendering → "Emulate CSS media type: print" in both light and dark themes.

---

### 20. Anchor-Link Smooth Scroll ✅

**AEM:** Clientlib JS smoothly scrolls to step anchors.

**Replacement:** CSS `html { scroll-behavior: smooth }` (gated on `prefers-reduced-motion: no-preference`) appended to [hugo/assets/css/sap-theme-vars.css](../hugo/assets/css/sap-theme-vars.css). Plus a small JS handler in [hugo/assets/js/tutorial.ts](../hugo/assets/js/tutorial.ts) that **expands the target step accordion** before/after navigation — without it, anchor links to collapsed steps land on a closed accordion showing only the title. Three pieces: `expandStep(stepNum)` helper, click-delegate hook on `a[href^="#step-"]` (expand before native scroll), and `initStepHashNavigation()` which handles initial-load `location.hash` and `hashchange` events (re-scrolls smoothly because the browser's pre-DOMContentLoaded jump landed on a still-collapsed step).

---

### 21. Handlebars Legacy Components ✅

**AEM:** Some product cards and error pages still use Handlebars (pre-HTL migration leftovers).

**Replacement:** Out of scope for the tutorial platform. The AEM Handlebars footprint was on product/topic landing pages and error pages on `developers.sap.com`, neither of which are part of the tutorial scope being rewritten here. Error pages in this project are native Hugo templates ([hugo/layouts/404.html](../hugo/layouts/404.html), [hugo/layouts/500.html](../hugo/layouts/500.html), [hugo/layouts/maintenance.html](../hugo/layouts/maintenance.html)). No `.hbs` files or Handlebars runtime exist anywhere in the tutorial scope (only transitive `.hbs` scaffolding inside `node_modules/@sap/cds-dk/lib/init/template/`, used by `cds init` and never executed at runtime).

---

## Edge Cases Not Previously Identified

These are items that don't show up in the team's TODO list and aren't obvious gap categories.

### E1. JCR Tag Tree → CAP Tag Catalog Migration

AEM has `/content/cq:tags/...` with a hierarchical tag taxonomy (likely thousands of tags with descriptions, translations, deprecated flags). The replacement has a `Tags` entity in CAP but the migration of the existing tag hierarchy hasn't been mentioned.

**Question:** Is the AEM tag tree being exported and imported into CAP? Or are tags being rebuilt from scratch from current tutorial frontmatter?

**Risk:** If rebuilt, lose tag descriptions, deprecation history, translations, and any analytics tied to specific tag IDs.

---

### E2. TagNodeListener Outbound Sync — Decommission Plan

AEM listens for tag changes and writes them back to GitHub. This implies someone (sysadmin? content team?) edits tags in AEM and expects them to flow to GitHub.

**Question:** After cutover, where do tag edits happen? CAP admin UI? Directly in GitHub? If CAP, does the replacement push back to GitHub or is the flow now one-way?

**Risk:** Workflow surprise — operator who currently edits tags in AEM finds the new flow doesn't match.

---

### E3. OSGi Run Mode Configurations

AEM uses Sling run modes (`config.author`, `config.publish`, `config.dev`, `config.prod`) to overlay environment-specific configs (URLs, tokens, feature flags).

**Question:** Are there feature flags or environment-specific behaviors in the AEM configs that don't have equivalents in the replacement's MTA + `default-env.json` model?

**Risk:** A rarely-exercised production-only behavior (e.g., "in prod, also write feedback to a Slack webhook") gets lost.

**Action:** Diff `/apps/.../config.prod/*.xml` against the dev configs to find prod-only behaviors.

---

### E4. Replication Queue State

AEM Author → Publish replication has a queue. At any moment there are pending replications. **What happens to in-flight replications at cutover?**

**Risk:** Content authored just before cutover (in AEM) may not have replicated to Publish, doesn't appear on the public site, and will never replicate to the replacement (which doesn't read from JCR).

**Action:** Run a final force-replicate-all + force-fetch-from-GitHub sequence at cutover.

---

### E5. ~~Per-Tutorial Analytics History~~ — **Moot**

**Scope decision (2026-05-20):** Adobe Analytics for developers.sap.com has been off in production for some time (see [gap #12](#12-adobe-analytics--not-in-scope)). There is no continuous historical series to preserve, so the year-over-year-reporting concern does not apply at cutover.

**Action:** None. If analytics are reintroduced post-cutover, the new tool will start its own ID space — that's a fresh-start decision, not an AEM continuity gap.

---

### E6. Email / Newsletter Integration ✅

If developers.sap.com powers any email newsletter ("here are this week's new tutorials"), there may be an integration that reads from AEM (replication events, sitemap, custom feed) to compose emails.

**Status:** Not relevant to the tutorial scope.

---

### E7. SAP Internal Search Indexing ✅

SAP's internal search aggregator (the global SAP search across help.sap.com, community, developers.sap.com, etc.) likely crawls developers.sap.com. **Sudden URL pattern changes break this.**

**Status:** Not relevant to the tutorial scope.

---

### E8. Sysadmin Identity Provider ✅

The AEM admin UI (`/system/console`, `/sites.html`) authenticates against an SAP-internal LDAP or IDP separate from the public SAP IDP used for IMS.

**Status:** Not an issue. The AEM admin user group is small and is working directly on this project — no risk of losing access to a tool they rely on at cutover. CAP admin UI access will be coordinated within the same group.

---

### E9. Open Graph / Social Card Images

AEM may auto-generate Open Graph preview images per tutorial (for LinkedIn/Twitter shares). Replacement may not.

**Action:** Check `<meta property="og:image">` on a sample of production tutorials. If present and dynamic, plan equivalent.

---

### E10. Author Profile Pages

Tutorials may link to author profile pages (`/authors/<author-id>`) showing all tutorials by that author, bio, photo. These pages might be in AEM as content fragments.

**Question:** Does the replacement have author pages? If not, links from tutorials to author profiles 404.

**Action:** Sample `/authors/...` URLs; either build equivalent or add to redirect map (point to a generic landing).

---

### E11. Event Pages Beyond AppSpace

The team has an event-specific Vue app (AppSpace). AEM may have additional event-themed landing pages (Devtoberfest, TechEd) maintained as content fragments.

**Action:** Inventory `/events/...` URLs in production sitemap.

---

### E12. Bot / Crawler Robots Rules — ✅ Closed 2026-05-21

AEM's `robots.txt` likely had carefully-tuned rules. Our replacement (commit `2c49420`, 2026-05-20) disallows the operational paths that should never be crawled (`/api/`, `/admin/`, `/admin-ui/`, `/scanner-ui/`, `/event-display/`, `/display/`) and explicitly allows the major search bots and AI assistants on the public surface. Closed without a side-by-side diff against the AEM production file — the rule set we shipped is the intended policy going forward, not a reproduction of AEM's.

---

### E13. Print / Preview / Draft URL Variants

AEM templates often expose `?wcmmode=preview`, `?print=true` query-string variants. These are useful for content review and customer service ("send me this tutorial as PDF").

**Question:** Replacement supports these? If yes, document. If no, accept regression.

---

### E14. Crawlable JSON Endpoints

AEM's `.model.json` outputs at every page (e.g., `/tutorials/foo.model.json`) may be crawled by external integrations (Algolia, internal LLMs, partner aggregators).

**Action:** Check access logs (or guess by the fact that the SPA frontend was attempted). If `.model.json` is consumed externally, document deprecation.

---

### E15. AppRouter Custom Headers

The replacement's AppRouter sets some security headers via `xs-app.json`. AEM's Dispatcher had its own header rules. **Differences may surprise:**
- Different `Content-Security-Policy` (could break inline analytics).
- Different `X-Frame-Options` (could break embedding tutorials in SAP partner sites).
- Different `Referrer-Policy` (could affect outbound link tracking).

**Action:** Diff the response headers from a production tutorial URL (AEM) vs the dev replacement.

---

## Recommended Cutover Sequencing

Based on the gap severity, a safe cutover order:

1. **Pre-cutover (next 2 weeks):** Address all P0 (Live Demo decision, GitHub private images, redirect map, fetcher hardening, Akamai purge if applicable).
2. **Pre-cutover (next 4 weeks):** Address P1 items 6–14. Many are small.
3. **Soft launch:** Run replacement in parallel at a different hostname (e.g., `developers-next.sap.com`). Marketing test, dogfood internally.
4. **Cutover:** Switch DNS. AEM stays running for 30 days as fallback.
5. **Post-cutover:** Address P2 + edge cases as they surface.
6. **Decommission AEM:** After 30 stable days + redirect map proven + analytics baseline established.

---

## Open Questions for Tom / Team

1. Is Akamai actually in front of BTP routes in production? (changes severity of gap #5)
2. Which non-English locales have non-trivial content? (changes scope of gap #7)
3. Is there a bidirectional tag editing workflow that operators rely on? (changes scope of E2)
4. Who is the sysadmin group today, and do they have a tools-readiness document for the new admin UI? (E8)
5. Are there any internal SAP integrations (search aggregator, email digest, partner data feed) that consume AEM URLs or `.model.json`? (E6, E7, E14)

---

*Companion: see `aem-current-state.md` for the architectural detail behind each item above.*
