# AEM Current State — Historical Reference

> **Purpose:** Document how Adobe Experience Manager (AEM) currently serves developers.sap.com so the team can support production until cutover to the tutorials-poc replacement is complete. This is a snapshot of the live system, not a design document.
>
> **Source:** `D:\projects\com.sap.wcms.dx.developers` (1,013 Java files, 6 OSGi bundles, 341 content XML/HTML files), reviewed 2026-05-20.
>
> **Scope filter:** Tutorial *authoring* on developers.sap.com happens in GitHub via a VS Code extension, not in AEM. This document covers only:
> - Tutorial publishing/ingestion (GitHub → AEM)
> - System administration tools (monitoring, cache busting, manual republish)
> - Public-facing delivery (templates, components, search, i18n)
> - Cross-cutting concerns (CDN, redirects, error pages, analytics)
>
> AEM authoring dialogs, editable template policies, and content-fragment authoring forms used by content authors are **out of scope**.

---

## 1. System Topology

```text
                                ┌────────────────────────────────────┐
                                │  Authors (GitHub + VS Code ext.)   │
                                └──────────────┬─────────────────────┘
                                               │ git push
                                               ▼
                                ┌────────────────────────────────────┐
                                │  sap-tutorials GitHub org          │
                                │  - tutorials repos (public)        │
                                │  - *-Contribution repos (private)  │
                                └──────────────┬─────────────────────┘
                                               │ GitHub API (OAuth)
                                               │ hourly scheduler
                                               ▼
       ┌────────────────────┐   JCR import   ┌────────────────────┐
       │  HANA Live Demo    │◀───── proxy ───│        AEM         │
       │  (SQL/algorithms)  │                │  - Author instance │
       └────────────────────┘                │  - Publish instance│
                                             │  - Dispatcher      │
                                             └─────────┬──────────┘
       ┌────────────────────┐                          │ replicate
       │      IMS (Java)    │◀──── proxy ──────────────┤ purge
       │  progress tracking │                          │
       └────────────────────┘                          ▼
                                             ┌────────────────────┐
                                             │   Akamai CDN       │
                                             └─────────┬──────────┘
                                                       ▼
                                             ┌────────────────────┐
                                             │  developers.sap.com│
                                             └────────────────────┘
```

The tutorials-poc replacement collapses Author/Publish/Dispatcher into a single AppRouter+CAP stack on BTP Cloud Foundry, with HANA replacing JCR for tutorial HTML and progress data.

---

## 2. OSGi Bundle Inventory

| Bundle | Role | Status in replacement |
| --- | --- | --- |
| `core` | Servlets, services, schedulers, listeners — most of the dynamic logic | Partially replaced by CAP services + `scripts/fetch-tutorials.ts` |
| `core.tutorial` | Tutorial-specific REST endpoints, GitHub ingestion, IMS proxy, HANA Live Demo proxy | Partially replaced — significant gaps (see gap analysis) |
| `spa` | Sling Models that emit `.model.json` for the SPA frontend | Not applicable — Hugo emits HTML directly |
| `spa.api`, `core.api` | Public Java APIs consumed by other bundles | N/A |
| `responsive` | Responsive image/asset generation | Replaced by Hugo image processing |
| `compat` | Backward-compat shims for legacy templates | N/A |

---

## 3. Tutorial Publishing & Ingestion

### 3.1 GitHub Fetcher (`core.tutorial` bundle)

The fetcher is the highest-risk replacement target. It is a multi-class, multi-token, scheduled OSGi service with the following characteristics:

- **Schedule:** Hourly cron via Sling Scheduler (`@Component` with `scheduler.expression`).
- **Multi-token OAuth rotation:** Maintains a pool of GitHub Personal Access Tokens. On rate-limit exhaustion (HTTP 403 with `X-RateLimit-Remaining: 0`), rotates to the next token in the pool. Token list configured via OSGi config admin.
- **Repo discovery:** Walks the `sap-tutorials` GitHub org, filters by topic/visibility, excludes a configurable deny-list.
- **Private `-Contribution` repos:** Authenticated reads of `rules.vr` validation files from private repos paired with each public tutorial repo. Token must have `repo` scope on the private repos.
- **Per-tutorial fetch:**
  - Reads `tutorial.md` and any referenced images.
  - Parses frontmatter and ACCORDION-BEGIN/END (V1) or H3 step delimiters (V2) — the same parser logic ported into `scripts/parsers/`.
  - Stores parsed result as JCR resources under `/content/developers/...`.
- **Image proxying:** `GitHubProxyServlet` fetches images from private repos at request time using a service token (avoids exposing the token to the browser). Public repo images are referenced directly via `raw.githubusercontent.com`.
- **Failure handling:** On individual repo failure, logs error and continues with the next repo (does **not** fail the entire batch).
- **Manual trigger:** Sysadmin servlet exposed at a `/bin/...` path (auth-required) to force a refresh of a single repo or all repos.

### 3.2 Tag Bi-Directional Sync (`TagNodeListener`)

A JCR observation listener watches the AEM tag tree (`/content/cq:tags/...`). When tags are added, renamed, or deleted in AEM, the listener writes the change back to the corresponding GitHub source (likely a tag-metadata file in the tutorials org).

This is bi-directional — GitHub changes flow in via the fetcher, AEM changes flow out via the listener.

### 3.3 Content Storage in JCR

Tutorial content lives at `/content/developers/<locale>/tutorials/<slug>/...` with these key structures:

- **Per-step nodes:** Each step is a JCR child with text, image references, and option/quiz subnodes.
- **Asset references:** Images stored under `/content/dam/developers/...` with derived renditions (responsive breakpoints).
- **Frontmatter as JCR properties:** `time`, `level`, `parser`, `tags`, etc., promoted to typed properties.
- **Replication:** Author → Publish replication is event-driven; each tutorial node carries `cq:lastReplicated` metadata.

---

## 4. Public-Facing Delivery

### 4.1 Page Templates (14 total)

| Template | Purpose | Hugo equivalent |
| --- | --- | --- |
| `tutorial-page` | Single-tutorial render | `hugo/layouts/tutorials/single.html` |
| `mission-page` | Mission landing | `hugo/layouts/missions/single.html` |
| `group-page` | Group landing | `hugo/layouts/groups/single.html` |
| `landing-page` | Marketing landing pages with CF composition | **Gap** — Hugo has limited landing pages |
| `topic-page` | Topic taxonomy listing | Gap — needs verification |
| `home-page` | Homepage with Hero/SubNavigation/Resources fragments | Partial — `hugo/layouts/index.html` |
| `error-page` | 404/500 templates (Handlebars-based legacy) | Gap |
| `redirect-page` | Server-side redirect declaration | Gap — handled at AppRouter? |
| `event-page` | Events landing | Replaced by AppSpace Vue app |
| `search-results-page` | Solr-backed search UI | Replaced by SearchService + Hugo template (parity not verified) |
| `sitemap-page` | XML sitemap generator | Gap |
| `robots-page` | author-configurable `robots.txt` | Gap — sysadmin concern |
| `learning-page` | Aggregated learning paths | Gap |
| `xf-page` | Experience Fragment host | N/A |

### 4.2 Components (~80) and Content Fragments

Notable components that affect the public surface:

- **AdaptiveImage** — Six responsive breakpoints with separate image renditions, lazy-loading, art-direction support. Hugo uses image processing but not the exact same breakpoints — verify against `hugo/layouts/_default/baseof.html`.
- **HeroBanner** content fragment — Composed at the homepage level. Needs landing-page composition story in Hugo.
- **SubNavigation** content fragment — Top-of-page secondary nav per topic. Hugo uses a single global nav.
- **Resources** content fragment — "Related links" rail rendered next to articles.
- **VideoEmbed** — YouTube/Vimeo wrappers with cookie-aware lazy iframes.
- **CodeBlock** — Syntax-highlighted code with copy-to-clipboard. Hugo has the highlight via `scripts/highlight-cds.ts`.
- **Tabs / Accordion / Callout / Alert** — Shortcode equivalents in Hugo (verify all are mapped).
- **Handlebars legacy components** — A subset of error pages and product cards still use Handlebars templates rendered server-side. These are pre-migration leftovers.

### 4.3 Clientlibs (18 categories)

AEM ships ~18 clientlib categories: base CSS, base JS, fonts, analytics, search, video, code-syntax, etc. The Hugo replacement consolidates these into `hugo/static/css/sap-fundamental.css` (PostCSS-built) and small Vue islands in `apps/`. Specific JS behaviors to verify:

- Cookie consent banner (likely OneTrust)
- Analytics tracking (Adobe Analytics — not yet wired in tutorials-poc)
- Search box autocomplete
- Mobile nav / hamburger
- Anchor-link smooth scroll on tutorial steps
- Print styles

### 4.4 i18n / Multi-language

AEM has language masters under `/content/developers/<lang-code>/...` with translation copy/replication to localized branches. The site supports multiple languages (verify exact locale list — typically `en`, `de`, `ja`, `zh`, `ko`, `fr`, `es`, `pt-br`).

The Hugo replacement is currently English-only. Multi-language is a known gap.

### 4.5 Search

`SolrSearchServlet` proxies to a Solr cluster with faceted search across tutorials, missions, blog posts, and other developers.sap.com content. Facets typically include: content type, technology tag, level, time-to-complete, language.

The replacement has `SearchService` in CAP — parity (facets, weighting, typo tolerance, multi-language stemming) is not yet verified.

---

## 5. Integrations

### 5.1 IMS (Internal Management System)

`IMSProxyServlet` and related code in `core.tutorial` route `/api/ims/*` to the Spring Boot IMS app at the URL stored in OSGi config. Used for:

- Mission progress lookup
- Task completion writes
- User identity bridging (SAP IDP → IMS user)
- Leaderboards / event-mode counters

Replacement: CAP `DeveloperService` reimplements IMS endpoints; `srv/lib/ims-proxy.js` (if present) handles legacy fallback during migration.

### 5.2 HANA Live Demo (`LiveDemoProxyServlet`)

A servlet proxying SQL execution and algorithm runs to a HANA instance for embedded tutorial demos (e.g., "run this query against a sample dataset"). Authenticated, rate-limited, with sandbox per-user temp schemas.

**This is entirely missing from the tutorials-poc replacement.** Tutorials that depend on it will break unless the proxy is kept running pointing at the AEM URL during cutover, or the feature is reimplemented.

### 5.3 GitHub Feedback → GitHub Issues

Three feedback servlets (tutorial / group / mission) take user-submitted feedback and open GitHub issues against the source repo using a service token. URL routing rules per repo are configurable via OSGi config admin.

### 5.4 Akamai CDN

`AkamaiCachePurgeService` integrates with AEM's replication framework. On `cq:lastReplicated` change, the service computes affected URLs and calls Akamai's Fast Purge API to invalidate the CDN cache.

The replacement has no equivalent — content updates flow `publish-content.ts` → HANA, and HTTP responses set `Cache-Control` + `ETag` headers, but there is no CDN purge call.

### 5.5 Siteimprove

`SiteimproveServlet` and a clientlib snippet provide accessibility and SEO scoring via the Siteimprove SaaS. Used by sysadmins to monitor content quality.

### 5.6 NextStepsServlet

A recommendation engine endpoint that takes a current tutorial slug and returns suggested follow-on tutorials based on tag overlap, mission membership, and (likely) collaborative-filtering data from IMS.

---

## 6. Scheduled Jobs (Sling Scheduler)

| Job | Cadence | Purpose |
| --- | --- | --- |
| GitHub fetcher | Hourly | Sync tutorials from sap-tutorials org |
| Tag sync (outbound) | Event-driven (JCR listener) | Push AEM tag changes to GitHub |
| Akamai purge queue drain | Event-driven | Coalesce purge requests after replication bursts |
| Solr indexer | Event-driven + nightly full | Maintain search index |
| Health check / metrics | Continuous | OSGi healthchecks consumed by infra monitoring |
| Asset rendition cleanup | Daily | Delete unused image renditions from DAM |

---

## 7. Sysadmin Surface

### 7.1 Manual Tools (`/bin/...` servlets)

- **Force tutorial refresh** — re-pull from a single GitHub repo or all repos.
- **Force Akamai purge** — invalidate by URL pattern.
- **Force Solr reindex** — rebuild full index or single content tree.
- **Replication queue inspector** — view pending replications, retry failed.
- **OSGi console** (`/system/console/...`) — config admin, bundle status, scheduler view, healthchecks.

### 7.2 Configuration Model

- **OSGi configs** (`/apps/.../config/*.xml`) — runtime configuration for all `@Designate` services. Includes GitHub tokens, IMS URL, HANA Live Demo URL, Solr cluster URL, Akamai credentials, feedback issue templates.
- **Per-environment overlays** (`/apps/.../config.author`, `config.publish`, `config.dev`, `config.prod`) — environment-specific overrides selected by Sling run modes.

### 7.3 Trials & Downloads ChecksumServlet

A servlet that reads a JSON file maintained in the DAM (sysadmin-edited) and computes/serves SHA checksums for downloadable trial software. Used on `/trials/...` pages.

The DAM file is not in `D:\projects\com.sap.wcms.dx.developers` source — it's content authored by the SAP downloads team. This is a sysadmin touch point.

---

## 8. Cache & Performance

| Layer | Mechanism |
| --- | --- |
| Akamai CDN | URL-keyed cache, purged via `AkamaiCachePurgeService` |
| AEM Dispatcher | File-system cache in front of Publish, invalidated by replication agents |
| AEM Publish | In-memory + JCR query cache |
| Solr | Search-result cache |
| Browser | `Cache-Control` + `ETag` headers on responses |

The replacement has Cloud Foundry → AppRouter → CAP → HANA with no Akamai or Dispatcher in front. The bounded LRU cache in `srv/lib/content-store.js` (50MB) is the only hot-path cache.

---

## 9. Authentication & Identity

- **Public surface:** Anonymous (no login required for tutorial reading).
- **Progress tracking:** SAP IDP via the Spring Boot IMS app's auth handler. AEM forwards the identity token in IMS proxy calls.
- **Author instance:** AEM-internal users (LDAP-bridged) — out of scope.
- **Sysadmin tools:** AEM admin role.

---

## 10. URL Structure & Redirects

Tutorial URLs follow `/tutorials/<slug>/<step-or-page>` with locale prefix in some markets. The redirect map is maintained in JCR (`/conf/.../redirects/...`) — rules can be CSV-imported. AEM has a `RedirectFilter` Sling filter that intercepts requests and serves 301s.

The replacement currently has no redirect map. Any URL pattern changes during cutover (e.g., locale-prefixed → flat) need redirects to preserve SEO.

---

## 11. Error Pages

- **404** — Custom Handlebars template with site search box and "popular tutorials" rail.
- **500** — Generic apology page.
- **403** — Likely the SAP IDP login redirect, not a static page.

The replacement has Hugo defaults — verify against AEM templates if SEO matters.

---

## 12. Sitemap & SEO

- **`sitemap.xml`** — Generated by AEM's sitemap servlet, walks `/content/developers/...` and emits per-locale `<urlset>`s.
- **`robots.txt`** — Authored as a page in AEM (`robots-page` template) so sysadmins can adjust without code changes.
- **Open Graph / Twitter Cards** — Per-page meta tags from frontmatter.
- **canonical URLs** — Per-locale canonical with `hreflang` links.

---

## 13. Analytics

Adobe Analytics tags injected via clientlib. Page-view, tutorial-step-view, and outbound-link events tracked.

---

## 14. Known Quirks / Carry-Forwards

- **Handlebars legacy layer** — Some components still render via Handlebars (not HTL). Pre-migration leftovers; works in production but not maintained.
- **`compat` bundle** — Shims for legacy templates. If anything still depends on it, removal during cutover will surface those dependencies.
- **Per-bundle Sling Models** — `.model.json` outputs were intended for an SPA frontend that was never fully realized. Rendering today is HTL → HTML.
- **Magic OSGi configs** — Several services have hardcoded fallbacks if config is missing. Audit before turning AEM off.

---

## 15. Cutover Reference Checklist

When tutorials-poc reaches production parity, the following items must be migrated, kept dual-running, or explicitly retired:

| Item | Action required at cutover |
| --- | --- |
| GitHub fetcher | Replacement runs on GitHub Actions cron — verify schedule + token rotation |
| HANA Live Demo proxy | Either keep AEM proxy running or reimplement in CAP |
| GitHubProxyServlet (private repo images) | Reimplement in CAP or migrate to `raw.githubusercontent.com` for public repos |
| Akamai purge | Configure in CAP `publish-content.ts` |
| Solr search | Verify SearchService parity |
| IMS proxy | Already migrated to CAP DeveloperService |
| Tag bi-directional sync | Decide: keep one-way (GitHub → CAP) or rebuild outbound |
| GitHub feedback → issues | Reimplement in CAP |
| NextStepsServlet | Reimplement in CAP |
| Siteimprove | Wire into Hugo build or skip |
| i18n locales | Phase plan needed |
| Redirects | Export from JCR, import into AppRouter |
| robots.txt | Move to repo as static file or Hugo template |
| Trials checksums | Owner: SAP downloads team — coordinate |
| Adobe Analytics | Wire into Hugo |
| Cookie consent | Wire into Hugo |
| Akamai DNS | Switch CNAME from AEM Dispatcher to AppRouter |

---

*See `aem-gap-analysis.md` for a prioritized gap list and edge cases vs the tutorials-poc replacement.*
