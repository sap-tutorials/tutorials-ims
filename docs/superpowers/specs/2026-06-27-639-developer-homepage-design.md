# Developer Portal Homepage — Design Spec

**Date:** 2026-06-27
**Issue:** [#639 — developers.sap.com homepage and moving the homepage of the site to be under tutorials](https://github.com/sap-tutorials/tutorials-ims/issues/639)
**Author:** Claude (with Thomas Jung)
**Status:** Approved by Tom; spec-reviewer pending

**Companion research artifacts:**

- [`2026-06-27-639-homepage-research.md`](./2026-06-27-639-homepage-research.md) — 10-site competitor analysis
- [`2026-06-27-639-homepage-sap-destination-inventory.md`](./2026-06-27-639-homepage-sap-destination-inventory.md) — ~50-destination SAP developer-resource inventory

---

## 1. Goal

Replace `developers.sap.com/` (today: the tutorial navigator + featured-missions grid) with a **new top-level developer homepage** that becomes the gateway for everything SAP offers developers. The current homepage relocates to `/tutorial-navigator/`.

The new homepage is a **discovery catalog** over the entire SAP developer landscape — at least 50 distinct destinations across 9 hostname families (`developers.sap.com`, `community.sap.com`, `learning.sap.com`, `help.sap.com`, `api.sap.com`, `cap.cloud.sap`, `discovery-center.cloud.sap`, `skills.cloud.sap`, `sap.github.io/*`, plus microsites like `btp-ai-bp.docs.sap`).

The page solves a **"we have so much, but it's hard to find or even know"** problem. None of the 10 competitor portals analyzed have this problem at SAP's scale.

## 2. Non-goals

- **Marketing site.** This is a developer destination, not a campaign surface. No campaign hero takeovers, no newsletter capture forms, no testimonial walls, no slang-meets-enterprise tonal collisions.
- **Persona chooser.** No "I am an ABAP developer / I am a CAP developer" segmentation wizard. Competitor research showed zero of 10 modern developer portals use one. Personas are visible passively via verb shelves, not actively chosen.
- **Per-user personalization above the fold.** The existing `/me/` page handles per-user state and is linked from the header. The homepage is the same for everyone.
- **Search bar in the hero.** Current SAP-wide search is fragmented and worth its own design pass. Hero is pure IA + content.
- **Translations.** Per project convention: English-only is the active scope.
- **QA-channel equivalent.** New homepage is prod-only initially. QA channel stays as-is.
- **Co-branded `sap.com` global nav.** The page is an autonomous developer destination with a footer-only labeled door to `sap.com` (per the brand-seam decision).
- **Phased / opt-in cutover.** Current site is way out of date — hard cutover only. No `?new=true` flag, no `/v2/` preview URL, no opt-in cookie.

## 3. Audience model

**All developers equal in fold weight, with two pressures:**

1. **The long tail is "catch-up newcomers."** Many SAP developers with 20+ years of on-prem experience are effectively cloud + AI newcomers. The homepage's job is partly to **name the modernization shifts** (on-prem → ABAP Cloud, custom code → Joule extensibility, SAP GUI → Fiori/UI5) and offer ways across them.
2. **Personas are real and distinct but never asked.** ABAP/RAP, CAP/Fiori, Integration, AI/Joule, HANA/Data, BTP Architect are visible passively through what content lives where — never via a chooser.

## 4. Design principles (approved during brainstorming)

1. **Present from the developer's viewpoint, not SAP's.** The page asks "what are you here to do?" — not "which of our products did you come for?" Product fragmentation is SAP's problem, not the developer's.
2. **One short hero sentence that names the thing.** Not a paragraph. Not an empty-calorie tagline.
3. **Density is good when it's scannable.** A sparse landing page with three big buttons doesn't serve someone who's catching up. A dense one with named entry points does.
4. **Same shape everywhere.** Every verb panel uses the same 4-shelf structure (Start here / Reference / Tools & samples / Keep current) so once you've learned one, you can navigate all.
5. **Data-driven where it makes sense, hand-curated where editorial judgment matters.** Events and YouTube videos pull from live APIs. Shelves are admin-curated.
6. **Hard cutover.** Pre-cutover tests carry the weight. No fallback to the old shape.

## 5. The verb spine

Six verbs as the primary IA:

| Verb | What it covers |
|------|---------------|
| **Learn** | Tutorials, missions, learning journeys, certifications, "new to cloud SAP" curated path |
| **Build** | CAP, ABAP Cloud, UI5, Fiori, SAP Build (low-code), Build Code, design system, SDKs, IDE |
| **Integrate** | api.sap.com (Business Accelerator Hub), Integration Suite, Event Mesh, ORD, OData Vocabularies |
| **Operate** | BTP Cockpit, BTP CLI, Discovery Center, Kyma, CI/CD, HANA Cloud, IAS, Datasphere, SAC |
| **Extend with AI** | btp-ai-bp.docs.sap, skills.cloud.sap, AI4U, AI Core, AI Launchpad, Joule |
| **Connect** | SAP Community, @sapdevs YouTube, TechEd, CodeJams, Devtoberfest, advocates, GitHub orgs, news |

Six was a deliberate ceiling — it scans in one row on desktop, folds to two rows on mobile, and avoids the wraps-or-truncate problem of 7+ verbs.

## 6. Page anatomy

Top-to-bottom, seven rows:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Row 1 · Hero                                                         │
│   One short sentence. No CTA buttons. No search bar.                 │
│   Working draft: "Everything you need to build on SAP — tutorials,   │
│   docs, APIs, and community in one place."                           │
├──────────────────────────────────────────────────────────────────────┤
│ Row 2 · Verb spine                                                   │
│   Six tiles: Learn · Build · Integrate · Operate · Extend w/ AI ·    │
│   Connect. Each tile is an accordion AND links to /<verb>/ sub-page. │
├──────────────────────────────────────────────────────────────────────┤
│ Row 3 · Events band                                                  │
│   📅 3-4 upcoming events. Data-driven from EventStreamService +      │
│   sap-devs MCP events bridge. 60s server cache.                      │
├──────────────────────────────────────────────────────────────────────┤
│ Row 4 · SAPDevs video band                                           │
│   ▶ Two surfaces:                                                    │
│     LEFT — Weekly Developer News (featured, large thumb)             │
│     RIGHT — Most recent uploads from @sapdevs (3-4 thumbnails)       │
│   YouTube Data API v3 (server-side, 15-min cache).                   │
├──────────────────────────────────────────────────────────────────────┤
│ Row 5 · Tutorials catalog teaser                                     │
│   📘 6-8 featured/recent cards from /build/catalog.                  │
│   "Browse all tutorials →" links to /tutorial-navigator/.            │
├──────────────────────────────────────────────────────────────────────┤
│ Row 6 · Community lane                                               │
│   💬 Three columns: Developer Advocates · SAP Community blogs ·      │
│   SAP News headlines.                                                │
├──────────────────────────────────────────────────────────────────────┤
│ Row 7 · Comprehensive directory footer                               │
│   📚 6 columns (one per verb). Every destination from the 50+-site   │
│   inventory listed, organized by verb. Plus utility links + the      │
│   footer-only labeled door to sap.com.                               │
└──────────────────────────────────────────────────────────────────────┘
```

**Explicitly NOT on the page:**

- No persona chooser
- No newsletter signup
- No campaign / conference hero takeover
- No stacked carousels (every band is a single row of tiles/cards)
- No mascot, no slang, no "Define your path"-style empty-calorie tagline
- No "we use cookies" banner (handled by SAP corporate CMP at chrome level)

## 7. Per-verb content blocks (the 4-shelf shape)

Every verb panel and every `/<verb>/` sub-page uses the same four shelves:

| Shelf | Contents |
|-------|---------|
| **Start here** | 1-3 marquee entry points. Hand-curated by admins. |
| **Reference** | Canonical docs + APIs. Hand-curated. |
| **Tools & samples** | IDE, SDKs, GitHub orgs. Hand-curated. |
| **Keep current** | Videos, community, news scoped to this verb. Mixed: some hand-curated, some pulled live (per verb). |

**Initial seed content per verb:** see Appendix A. (Compiled from the destination inventory; final wording is admin-editable post-launch.)

## 8. Verb sub-pages (in scope for this issue)

Each verb has a dedicated sub-page that shows ALL entries for that verb, not just "Start here":

| URL | Layout |
|-----|--------|
| `/learn/` | Full Learn directory: every shelf, every entry, plus filtering |
| `/build/` | Full Build directory |
| `/integrate/` | Full Integrate directory |
| `/operate/` | Full Operate directory |
| `/ai/` | Full Extend-with-AI directory |
| `/connect/` | Full Connect directory (events, community, advocates, news, GitHub) |

**Implementation:** One Hugo content tree (`hugo/content/<verb>/_index.md`) per verb, one shared layout (`hugo/layouts/verb/list.html`) that renders shelves from a JSON dump of `HomepageShelves` scoped by `verb`. The JSON dump is generated at Hugo build time from a one-shot `/build/homepage-shelves` CAP endpoint, mirroring how `/build/catalog` is consumed today.

Each verb sub-page also gets a per-verb "Keep current" band (verb-scoped events + YouTube playlists). Where a verb has a natural sub-shape (e.g., Connect's events calendar, Learn's certification tracks), the sub-page can include a verb-specific extra section beyond the 4 shelves.

## 9. URL contract

### 9.1 New URLs

| URL | Serves | Status |
|-----|--------|--------|
| `/` | New developer-portal homepage | **New** |
| `/learn/` | Learn sub-page | **New** |
| `/build/` | Build sub-page | **New** |
| `/integrate/` | Integrate sub-page | **New** |
| `/operate/` | Operate sub-page | **New** |
| `/ai/` | Extend-with-AI sub-page | **New** |
| `/connect/` | Connect sub-page | **New** |
| `/tutorial-navigator/` | Relocated current homepage (tutorial navigator + filter UI) | **New (relocated)** |

### 9.2 Unchanged URLs

- `/tutorials/<slug>/` — individual tutorial pages (HANA-served)
- `/missions/<slug>/`, `/groups/<slug>/`, `/tags/<tag>/` — Hugo-rendered
- `/browse/`, `/me/`, `/developer-advocates/`, `/devtoberfest/`, `/app-space/`, `/event-display/` — existing sub-pages
- All `/api/*`, `/admin/*`, `/admin-ui/*`, `/scanner/*`, `/analytics-ui/*` routes

### 9.3 Legacy redirects (backwards compatibility)

| Legacy URL | Redirects to | Type |
|-----------|--------------|------|
| `/tutorial-navigator.html` | `/tutorial-navigator/` | 301 named |
| `/index.html` | `/` | 301 named |
| `/topics/<tag>.html` | `/tags/<tag>/` | 301 pattern |
| `/mission.html?id=<id>` | `/missions/<slug>/` (via slug lookup) | 301 pattern |
| `/group.html?id=<id>` | `/groups/<slug>/` (via slug lookup) | 301 pattern |
| `/<any-path>.html` | `/<any-path>/` if target exists, else 404 | 301 catch-all (conservative variant — only redirect when target exists) |
| Specific high-traffic legacy URLs | Named targets (hand-curated map) | 301 named |

**Implementation:** A Node middleware in `approuter/server.js` intercepts requests for `*.html`, looks up a redirect map sourced from the new `LegacyRedirects` CDS entity, returns 301 if matched. The middleware fetches the map at startup and refreshes hourly so admins can add entries without redeploys.

### 9.4 SEO

- All legacy redirects are **301**, not 302, so PageRank/SEO equity flows to new URLs.
- `sitemap.xml` regenerates from the new content tree at build time. All six verb sub-pages get appropriate `sitemap` frontmatter (priority + changefreq).
- Submit updated sitemap to Google Search Console + Bing Webmaster at launch (operational checklist, not a code task).
- Every new page emits `<link rel="canonical">` with the Hugo-native URL (no `.html`).
- OG metadata + Twitter cards on every new page (existing `baseof.html` already handles this; just need per-page metadata frontmatter).
- 404 page gets a "Looking for the tutorial navigator?" link at the top for users who land on legacy URLs not in our redirect map.

## 10. Data model

### 10.1 `HomepageShelves` (new CDS entity)

Source of truth for every shelf entry on the homepage and verb sub-pages.

```cds
entity HomepageShelves : managed {
  key ID         : UUID;
  verb           : String enum { LEARN; BUILD; INTEGRATE; OPERATE; AI; CONNECT };
  shelf          : String enum { START_HERE; REFERENCE; TOOLS; KEEP_CURRENT };
  sortOrder      : Integer;
  title          : String(120);
  url            : String(500);
  description    : String(280);
  badge          : String enum { NEW; UPDATED; HIDDEN_GEM; THIRD_PARTY; null };
  isExternal     : Boolean default true;
  isActive       : Boolean default true;
  lastChecked    : Timestamp;          // nightly link-health job
  linkStatus     : String enum { OK; BROKEN; SLOW; UNKNOWN } default 'UNKNOWN';
}
```

- `@assert.unique.url` to prevent duplicate destinations within a verb.
- `@PersonalData.EntitySemantics` is intentionally **NOT** applied to `HomepageShelves`. The entity holds admin-curated catalog metadata (URLs, titles, descriptions) — not a data subject, not a data-subject's content, and not credentials. Project convention (audit 2026-06-27): `@PersonalData` is reserved for entities containing user PII or user-authored content (`Users`, `UserMetaData`, `UserLearningPreferences`, `TaskRecords`, `CodeCheckSubmissions`, `ValidateAnswerSubmissions`, `AuthorAiRequests`, `BranchDecisions`, `Concepts`, `Secrets`, `Advocates`). Other admin-curated platform metadata (`Alerts`, `Missions`, `Groups`, `Events`, `ChatSettings`, `Categories`, `Accomplishments`, `Prizes`) is NOT annotated — `HomepageShelves` follows that established pattern. The `managed` aspect's `createdBy`/`modifiedBy` are still audit-log inputs via the entity-edit hook; they don't need `@PersonalData` propagation.
- `@cap-js/change-tracking` annotated per project convention.
- CSV seed file (`db/data/com.sap.developers.ims-HomepageShelves.csv`) seeds the initial ~50-destination inventory from the discovery artifact.

### 10.2 `LegacyRedirects` (new CDS entity)

Admin-curated map of legacy URLs → new URLs.

```cds
entity LegacyRedirects : managed {
  key ID         : UUID;
  fromPath       : String(500) not null;       // e.g. /tutorial-navigator.html
  toPath         : String(500) not null;       // e.g. /tutorial-navigator/
  statusCode     : Integer default 301;
  isPattern      : Boolean default false;      // if true, fromPath is regex
  isActive       : Boolean default true;
  hitCount       : Integer default 0;          // observability
}
```

- `@assert.unique.fromPath` (case-insensitive).
- Approuter middleware bumps `hitCount` async via a non-blocking POST to `/api/redirects/hit` (admin endpoint, debounced).
- Admin UI shows which redirects are actually being used (helps prune dead entries).

## 11. CAP services and endpoints

### 11.1 Existing endpoints we reuse (no new wiring)

- `GET /build/catalog` — missions/groups/tutorials catalog (Row 5).
- `GET /api/advocates` — Developer Advocates list (Row 6 column 1).
- `GET /api/alerts` — runtime alert banner (already wired into Hugo).
- `EventStreamService` (WebSocket + REST) — for live event updates.

### 11.2 New CAP service: `HomepageService` (@path: `/api/homepage`)

| Endpoint | Returns | Cache |
|----------|---------|-------|
| `GET /api/homepage/events` | 3-4 next-up events, merged from `EventStreamService` + sap-devs `search_events` | 60s server-side |
| `GET /api/homepage/videos` | YouTube payload: featured Developer News + 3-4 most recent uploads from `@sapdevs` | 15-min server-side |
| `GET /api/homepage/community-blogs` | 3 recent SAP Community blog headlines (developer-relevant) | 30-min server-side |
| `GET /api/homepage/news` | 2 recent `news.sap.com` headlines (developer-relevant filter) | 30-min server-side |
| `GET /api/homepage/shelves?verb=<v>` | Shelves for verb (used by verb sub-pages at runtime; build pipeline uses `/build/homepage-shelves` for static gen) | 5-min server-side |

All endpoints are public (no auth). All have graceful empty-state fallbacks so a failed upstream never produces an empty band.

### 11.3 New build-time endpoint

- `GET /build/homepage-shelves` — full dump of all active shelves, consumed by Hugo's existing `fetch-tutorials.ts` (no rename — adding one more fetch step alongside the catalog/nav/tag fetches it already does) to bake into `hugo/data/`.

### 11.4 YouTube integration (new module)

- **File:** `srv/lib/youtube-fetcher.js`
- **Secret:** `YOUTUBE_API_KEY` (BTP credstore), resolved via existing `srv/lib/secret-resolver.js`.
- **Channel:** `@sapdevs` (channel ID resolved once at startup, cached).
- **Playlist for featured:** Developer News playlist (pinned playlist ID, configured via `ChatSettings`-style config entity).
- **API quota:** 10k units/day default. Worst-case 15-min cache + 4 video lookups + 1 playlist fetch ≈ 500 units/day. Comfortable.
- **Failure mode:** If API fails or quota exhausted → render a graceful link card to `youtube.com/@sapdevs` + last successfully cached state. Never empty band.

## 12. Admin app (new)

A new Fiori Elements app at `app/admin/homepage/`, following the existing 14-admin-apps pattern (loaded as `componentUsage` by `admin-shell`).

**Two main views:**

1. **Shelves** — List Report + Object Page for `HomepageShelves`. Filterable by verb + shelf. Drag-reorder via `sortOrder`. Link-status indicator column (green/red/yellow) from `linkStatus`. Bulk-edit support for badge + isActive.
2. **Redirects** — List Report + Object Page for `LegacyRedirects`. Hit-count column for observability. Test-redirect action that validates `fromPath` doesn't shadow a real URL.

**Annotations:** Standard `@UI.LineItem`, `@UI.HeaderInfo`, `@UI.FieldGroup` in `app/admin-annotations.cds`. Draft pattern via `@odata.draft.enabled: true` (per project default).

**Access control:** Same scope as other admin apps (`Tutorial.Author` or new `Homepage.Admin` if we want finer-grained control — TBD during implementation).

## 13. Nightly jobs (new)

### 13.1 Homepage link-health check

- **Scheduled:** Via `srv/jobs/scheduler.js` (existing harness).
- **Cadence:** Nightly at 04:00 (after content GC at 03:00).
- **Behavior:** Walk all `HomepageShelves` where `isActive = true`. Fetch each `url` with 5s timeout and `HEAD` (fall back to `GET` if HEAD not allowed). Update `linkStatus` (OK / BROKEN / SLOW) and `lastChecked`. Surface broken-count as a badge on the Shelves admin tab.
- **Rate limit:** 4 concurrent fetches, 200ms between requests to avoid hammering external hosts.

### 13.2 No new automation for the YouTube band

The YouTube band is fetched lazily on `GET /api/homepage/videos` with server-side cache. No cron needed — first hit per 15-min window populates the cache.

## 14. Testing

Three Vitest workspaces (existing project pattern).

### 14.1 Unit (`npm test`)

- `HomepageShelves` CRUD against in-memory SQLite.
- `LegacyRedirects` lookup logic (exact-match, pattern-match, fall-through to 404).
- Redirect middleware: assert 301 for legacy paths, 200 for real paths, 404 for unknown.
- `youtube-fetcher.js` with mocked HTTP responses (success, 403, 429 quota, timeout).
- `HomepageService` endpoint shape tests (assert response schema for all 5 endpoints).

### 14.2 Hybrid (`npm run test:hybrid`)

- `HomepageShelves` deploys to HANA and seed-data imports correctly.
- Admin CRUD round-trip via OData against HANA.
- `LegacyRedirects` enforces case-insensitive uniqueness.

### 14.3 Smoke (`npm run test:smoke`)

- `GET /` returns the new homepage (assert hero text + verb spine markup).
- `GET /tutorial-navigator.html` returns 301 to `/tutorial-navigator/`.
- `GET /tutorial-navigator/` renders the relocated navigator with its Vue island.
- All six verb sub-pages render (`/learn/`, `/build/`, etc.).
- `GET /api/homepage/events`, `/videos`, `/community-blogs`, `/news`, `/shelves` all return well-formed JSON.
- Tutorial detail URL (`/tutorials/abap-dev-get-started/foo/`) still resolves — **regression test, must not skip.**
- Catch-all `*.html → */` redirect doesn't shadow API paths (no `.html` on those — guard test).

### 14.4 Pre-cutover regression

Because cutover is hard (no opt-in fallback), the cutover PR must:

1. Pass all three workspaces green.
2. Sample 10-20 actual Google search-result URLs for `developers.sap.com` and verify each either resolves correctly or 301s to a sensible target.
3. Manual click-through on every verb tile + sub-page on staging.
4. Lighthouse + accessibility audit (target: ≥ 90 on all four scores, AA contrast).
5. Mobile viewport check (320px / 768px / 1024px).

## 15. Launch (hard cutover)

**No phased rollout.** The current homepage is way out of date; preserving an opt-in flag would just leave broken state alive longer.

**Cutover sequence:**

1. Merge implementation PR(s) into `main` once all reviews + tests pass.
2. Deploy to DEV via standard `mbt build && cf deploy` flow.
3. Run smoke tests against DEV.
4. Manual stakeholder walkthrough (Tom + 1-2 others).
5. Deploy to PROD (when PROD cutover happens per the July-2026 plan).
6. Post-cutover within 24h: re-submit sitemap to Search Console + Bing.
7. Announcement post on community.sap.com.
8. **Watch window (1-2 weeks):** monitor 404 rate, hit counts on `LegacyRedirects`, Search Console "page indexed without content" warnings. Add named redirects for surprises via the admin app — no deploy needed.

## 16. Out of scope (deferred to follow-up issues)

- Per-user personalization on the new homepage (e.g., "your last viewed tutorial"). Already handled by `/me/`.
- Search bar in the hero. Worth a separate design pass.
- Translations / non-English locales. Per memory: English-only is the active scope.
- QA-channel equivalent.
- Co-branding with sap.com global nav.
- Additional data sources beyond YouTube / community blogs / news (e.g., Stack Overflow `[sap]` tag feed, Reddit r/SAP). Easy to add later as new `HomepageService` endpoints if desired.
- The AEM-side redirect tree (your memory flags this as access-blocked). We handle inbound legacy URLs defensively via the catch-all + named map; we don't try to replicate AEM's redirect tree.
- A "verb owner" admin-app permission split (currently all admins can edit all verbs).

## 17. Open questions surfaced during brainstorming, deferred to implementation

These are not blockers but want a quick decision when the implementation plan is written:

1. **Catch-all `*.html` strictness.** Spec proposes the conservative variant ("only redirect if target exists, else 404"). Confirm during implementation that this is what we ship.
2. **Verb sub-page extras.** Each `/<verb>/` page may want a verb-specific extra section (e.g., Connect's events calendar, Learn's certification tracks). Decide per-verb during implementation.
3. **Pinned Developer News playlist ID.** Get the actual playlist ID from the SAPDevs YouTube channel.
4. **Initial high-traffic legacy URLs to pre-seed.** Optional list — Tom may have a few in mind. Otherwise, observability via `LegacyRedirects.hitCount` will surface them post-launch.
5. **Admin app permission scope.** Reuse `Tutorial.Author` (matches the existing 14 apps) or introduce `Homepage.Admin`? Lean reuse for simplicity unless we have a reason to split.

6. **`LegacyRedirects.hitCount` write path.** Spec §10.2 says approuter middleware bumps `hitCount` via async POST to `/api/redirects/hit`. The implementation plan should confirm the call path and whether per-request writes are worth the write amplification vs. a periodic log-scrape (or an in-process counter that flushes every N seconds). Either is defensible — pick one when implementing.

## 18. Success criteria

The homepage is successful if, six months after cutover:

1. **Discovery works.** Survey + analytics (page-depth + outbound-click) show users finding destinations they didn't know existed before.
2. **The catalog is current.** `HomepageShelves.modifiedAt` (from the `managed` aspect) shows admin activity within the last 90 days; no shelf has been broken (`linkStatus = BROKEN`) for more than 14 days. (`lastChecked` is set by the nightly link-health job, not by admin edits — that's a separate signal.)
3. **No SEO regression.** Search Console shows preserved indexed-page count and stable or improved click-through for top 50 inbound queries.
4. **Tutorial traffic preserved.** `/tutorials/*` page views are stable or growing — the homepage's role is gateway, not bottleneck.
5. **No "where did the homepage go?" support tickets** after the first 4 weeks.

## 19. Appendix A — initial shelf seed content

Compiled from the destination inventory at [`2026-06-27-639-homepage-sap-destination-inventory.md`](./2026-06-27-639-homepage-sap-destination-inventory.md). All entries become rows in the `HomepageShelves` CSV seed file. Final wording, badges, and ordering are admin-editable post-launch.

(Full seed list below — abbreviated here as a representative sample; the implementation PR will include the complete CSV.)

### Learn

- **Start here:** The tutorial navigator · SAP Learning Journeys · "New to cloud SAP?" curated path
- **Reference:** learning.sap.com · help.sap.com · Certifications · SAP PRESS
- **Tools & samples:** BTP free tier signup · github.com/SAP-samples · SAP-docs on GitHub
- **Keep current:** Developer News (Fridays) · Devtoberfest · TechEd recordings

### Build

- **Start here:** CAP (cap.cloud.sap) · ABAP Cloud + RAP · Fiori / UI5 / Web Components · SAP Build (low-code) + Build Code
- **Reference:** ui5.sap.com Demo Kit · SAP Cloud SDK · Business Application Studio docs · Fiori design system
- **Tools & samples:** BAS · VS Code extensions · Eclipse ADT · tools.hana.ondemand.com · UI5 Web Components for React · github.com/SAP · SAP-samples
- **Keep current:** SAP Tech Bytes · CAP / ABAP community blogs · CodeJams

### Integrate

- **Start here:** SAP Business Accelerator Hub (api.sap.com) · Integration Suite · "Your first integration flow" tutorial
- **Reference:** Event Mesh · Destination Service · Private Link · Open Resource Discovery · OData Vocabularies
- **Tools & samples:** Postman/Bruno collections from api.sap.com · Project "Piper" · Integration samples on GitHub
- **Keep current:** Integration-specific videos · SAP Integration community group

### Operate

- **Start here:** BTP Cockpit · trial signup · BTP CLI · BTP getting-started docs
- **Reference:** BTP docs index · SAP Discovery Center · CI/CD service · IAS · Kyma · HANA Cloud
- **Tools & samples:** MTA build / cf push patterns · HANA-CLI · Datasphere · SAC
- **Keep current:** BTP release notes · SAP Architects community

### Extend with AI

- **Start here:** BTP AI Best Practices (btp-ai-bp.docs.sap) · AI Skills Library (skills.cloud.sap) · "Your first Joule extension" tutorial
- **Reference:** Joule · AI Core · AI Launchpad docs · HANA Cloud vector engine · SAP AI Foundation overview
- **Tools & samples:** AI4U Use Case Repository · github.com/SAP-samples AI patterns · RAG on HANA cookbook
- **Keep current:** AI-focused Tech Bytes · AI community + Joule discussions

### Connect

- **Start here:** SAP Community (community.sap.com) · SAP Developers YouTube (@sapdevs) · Devtoberfest
- **Reference:** SAP News Center (news.sap.com) · Community blogs · Developer Advocates roster (on this site)
- **Tools & samples:** github.com/SAP · SAP-samples · SAP-docs (public PRs welcome)
- **Keep current:** TechEd · Sapphire · CodeJams · ASUG · SAPinsider (independent) · Developer News (Fridays)
