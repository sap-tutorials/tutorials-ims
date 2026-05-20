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
- **Body text not indexed.** AEM Solr indexed the full tutorial body. `SearchableItems` indexes only title + description + primaryTag (plus, on the underlying `Tasks` view, step titles — but those aren't in the search projection). Real parity gap, separate from the LIKE bug. Most user queries are short and metadata-driven, but worth measuring before declaring done.

**Action:** Sample 20 representative production search queries (Adobe Analytics or Google Search Console — AEM admin-team request can run in parallel) and replay them against the fixed `SearchService`. The hybrid test `test/hybrid/search-service.test.js` already covers fuzzy + facet structure; extend it with a fixed query list once representative queries are in hand.

---

### 7. ~~Multi-language / i18n~~ — **Not a gap**

**AEM:** Language masters under `/content/developers/<lang-code>/...` exist for `en_us`, `de_de`, `es_co`, `zh_cn`, `en1`.

**Reality (confirmed 2026-05-20):** developers.sap.com is **English-only**. Non-`en_us` locale folders are legacy/deprecated and carry no live content. No translation/copy workflow is exercised in production.

**Action:** None for content. The only residual concern is incidental traffic to old non-`en_us` URLs from stale links or search engines — handle via the redirect map (gap #3) by pointing them to the `en_us` equivalent or a generic landing page. Do **not** build i18n into Hugo or the parsers.

---

### 8. Sitemap.xml Generation

**AEM:** Sitemap servlet walks `/content/developers/...` and emits per-locale `<urlset>`s consumed by Google, Bing, internal SAP search.

**Replacement:** Hugo can emit a sitemap from its content, but verify:
- Tutorial URLs match production (no `/dev/` prefix in canonical URLs).
- Mission and group URLs are included.
- Per-locale entries with `hreflang` (depends on i18n outcome).
- `lastmod` reflects actual content update time, not Hugo build time.

**Action:** Generate Hugo sitemap, diff against current AEM sitemap.xml, address discrepancies.

---

### 9. NextStepsServlet (Recommendation Engine)

**AEM:** Returns "next tutorial" suggestions based on tag overlap, mission membership, and (likely) IMS data on what other users completed after this tutorial.

**Replacement:** Nothing.

**Impact:** End-of-tutorial "Continue learning" rail loses its recommendations. Users finish a tutorial and have no obvious next action. Engagement drops.

**Remediation:**
- v1: Tag-overlap recommendations from CAP catalog (no IMS dependency).
- v2: Combine tag overlap with TaskRecord co-completion data.
- v3: Feed into Joule (already queued in `project_joule_completion_suggestions.md`).

**Action:** Ship v1 before cutover. v1 is ~40 lines of CAP code over the existing catalog.

---

### 10. GitHub Feedback → Issues

**AEM:** Three feedback servlets (tutorial / group / mission) collect user feedback at the bottom of each page and open GitHub issues against the source repo using a service token. Three issue templates configurable via OSGi config.

**Replacement:** Nothing.

**Impact:** Tutorial authors lose the feedback channel they currently rely on. Feedback either goes to a black hole or moves to a different channel users aren't trained to use.

**Remediation:** A CAP endpoint `POST /api/feedback/{tutorial|group|mission}/:slug` that authenticates with a service token and creates an issue via `octokit`. Reuse the three templates from AEM OSGi config.

**Action:** Tractable, ~half-day's work. Worth doing.

---

### 11. Hero / SubNavigation / Resources Content Fragments

**AEM:** Content Fragment authoring (out of scope per Tom) but the *rendered output* of these fragments composes the homepage and many landing pages. The hero banner, secondary navigation per topic area, and the "related resources" rail are content-fragment-driven.

**Replacement:** Hugo homepage exists but the composition story is unclear. Are landing pages other than the homepage planned? How does a new topic area get a hero banner without a developer writing HTML?

**Edge cases:**
- Sysadmins (or marketing) currently update hero banners and "related resources" rails through AEM dialogs. After cutover, this becomes either a Hugo content edit + rebuild + redeploy, or a CAP-backed CMS surface.
- Topic-page hierarchies may not be mapped in Hugo at all.

**Action:** Inventory production landing pages with `curl + sitemap.xml`. Decide which are essential for cutover vs deferrable.

---

### 12. Adobe Analytics

**AEM:** Adobe Analytics tags injected via clientlib. Tracks page views, tutorial-step views, outbound link clicks, search queries.

**Replacement:** Not yet wired.

**Impact:** Marketing/PMM loses dashboards on day one of cutover.

**Action:** Get the Adobe Analytics property + s_code (or AEP equivalent) from the marketing team and inject into `hugo/layouts/_default/baseof.html`.

---

### 13. Cookie Consent

**AEM:** Cookie consent banner (likely OneTrust) injected via clientlib.

**Replacement:** Not yet wired.

**Impact:** Compliance issue (GDPR, ePrivacy). Possibly blocking for legal sign-off.

**Action:** Get the OneTrust property ID from compliance, inject into Hugo layout. Verify cookie categories, consent persistence across subdomains.

---

### 14. Error Pages (404 / 500)

**AEM:** Custom Handlebars 404 with site search box and "popular tutorials" rail. Generic 500.

**Replacement:** Hugo defaults — minimal or absent.

**Impact:** A 404 is the user's first impression after a broken link from a search engine. Generic 404 = bounce.

**Action:** Build `hugo/layouts/404.html` mirroring AEM's content with search + popular tutorials. AppRouter `xs-app.json` should serve it on unmatched routes.

---

### 15. Trials & Downloads Checksum Servlet

**AEM:** Reads a JSON file from DAM (sysadmin-maintained) and serves SHA checksums for downloadable trial software. Used on `/trials/...` pages.

**Replacement:** Out of scope of `tutorials-poc`? Verify:
- Are `/trials/...` URLs still under the developers.sap.com domain post-cutover?
- If yes, who serves them?
- If they move to a different system, ensure URL continuity (redirect map covers it).

**Edge case:** This is a touch point with the SAP downloads team — not the tutorial team. Coordination needed.

**Action:** Out-of-band conversation with the trials/downloads owner.

---

## P2 — Minor Gaps

### 16. Siteimprove Integration

**AEM:** Accessibility/SEO scoring via Siteimprove SaaS. Sysadmin/content-quality tool.

**Replacement:** Nothing. Site can be re-onboarded to Siteimprove (or replaced with axe-core + Lighthouse in CI) post-cutover.

**Action:** Park. Re-onboard to Siteimprove or wire axe-core into CI after cutover stabilizes.

---

### 17. Robots.txt as Author-Editable Page

**AEM:** `robots-page` template lets sysadmins edit `robots.txt` without code changes.

**Replacement:** Should ship as a static file in `hugo/static/robots.txt`. If sysadmin editability is required, expose as an admin OData entity.

**Action:** Ship as static file unless someone explicitly needs admin editing.

---

### 18. Six Responsive Breakpoints + AdaptiveImage Pipeline

**AEM:** `AdaptiveImage` component with six breakpoints, art-direction support, lazy loading.

**Replacement:** Hugo has image processing (`{{ .Resize }}`) but specific breakpoint values and srcset behavior not verified.

**Action:** Compare a sample tutorial page in AEM vs replacement on three viewport sizes. Adjust Hugo image config to match if there's a meaningful regression.

---

### 19. Print Stylesheet

**AEM:** Print CSS in clientlib hides nav/sidebar/footer for clean tutorial printouts.

**Replacement:** Verify Hugo has equivalent.

**Action:** Trivial CSS work. Ship if missing.

---

### 20. Anchor-Link Smooth Scroll

**AEM:** Clientlib JS smoothly scrolls to step anchors.

**Replacement:** CSS `scroll-behavior: smooth` covers most browsers. Verify.

---

### 21. Handlebars Legacy Components

**AEM:** Some product cards and error pages still use Handlebars (pre-HTL migration leftovers).

**Replacement:** Should be reimplemented as Hugo partials or shortcodes. Inventory needed.

**Action:** Inventory + reimplement as needed. Not blocking.

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

### E5. Per-Tutorial Analytics History

If Adobe Analytics tracks events by tutorial slug or AEM resource ID, and the resource ID is JCR-specific, **the historical analytics for a tutorial may be unreachable post-cutover**. New events will use a new ID space.

**Risk:** Year-over-year reporting breaks. PMs lose the ability to say "this tutorial has had 50K views since 2022."

**Action:** Check analytics implementation. If it tracks by slug (likely), no problem. If it tracks by JCR path, coordinate with marketing on backfill.

---

### E6. Email / Newsletter Integration

If developers.sap.com powers any email newsletter ("here are this week's new tutorials"), there may be an integration that reads from AEM (replication events, sitemap, custom feed) to compose emails.

**Question:** Does such an integration exist? If yes, what does it consume?

**Action:** Ask the marketing/comms team. May be reading the public sitemap, in which case continuity is preserved.

---

### E7. SAP Internal Search Indexing

SAP's internal search aggregator (the global SAP search across help.sap.com, community, developers.sap.com, etc.) likely crawls developers.sap.com. **Sudden URL pattern changes break this.**

**Action:** Coordinate with the SAP-wide search team before cutover.

---

### E8. Sysadmin Identity Provider

The AEM admin UI (`/system/console`, `/sites.html`) authenticates against an SAP-internal LDAP or IDP separate from the public SAP IDP used for IMS.

**Question:** Who has admin access today? When AEM is decommissioned, does that group lose access to a tool they rely on (e.g., for Akamai purge, Solr reindex)?

**Action:** Ensure sysadmin tools in CAP admin UI cover all current AEM admin workflows. The CAP admin UI uses XSUAA roles — different identity model.

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

### E12. Bot / Crawler Robots Rules

AEM's `robots.txt` likely has carefully-tuned rules (allow Googlebot deeply, restrict aggressive crawlers, sitemap reference). A naive replacement that disallows `/admin-ui/` but allows `/tutorials/*` may be fine, but verify edge cases like `/print/`, `/preview/`, `/draft/` paths.

**Action:** Side-by-side `robots.txt` review.

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
