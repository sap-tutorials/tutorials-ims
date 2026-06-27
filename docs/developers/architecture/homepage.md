---
title: Developer Portal Homepage Architecture
description: Architecture of the new developer-portal homepage — data model, services, data flows, URL contract, and failure modes.
---

# Developer Portal Homepage Architecture

The homepage redesign (issue #639) replaces `developers.sap.com/` with a new top-level developer gateway. This document covers the platform engineering view: data model, services, build-time data feeds, runtime endpoints, and operational handles.

**Spec:** [docs/superpowers/specs/2026-06-27-639-developer-homepage-design.md](../../superpowers/specs/2026-06-27-639-developer-homepage-design.md)
**Plan:** [docs/superpowers/plans/2026-06-27-639-developer-homepage.md](../../superpowers/plans/2026-06-27-639-developer-homepage.md)

---

## Components

| Layer | Component | Source |
|-------|-----------|--------|
| **Data model** | `HomepageShelves` entity + admin Fiori app | `db/homepage.cds`, `app/admin-annotations.cds` |
| **Data model** | `LegacyRedirects` entity + admin Fiori app | `db/homepage.cds`, `app/admin-annotations.cds` |
| **Data model** | `HomepageConfig` singleton + admin Fiori app | `db/homepage.cds`, `app/admin-annotations.cds` |
| **Service** | `HomepageService` (`@path: /api/homepage`) | `srv/homepage-service.cds`, `srv/homepage-service.js` |
| **Build feed** | `HomepageShelvesEndpoint` (`GET /build/homepage-shelves`) | `srv/developer-service.js` |
| **Fetcher** | YouTube fetcher (`srv/lib/youtube-fetcher.js`) | Calls YouTube Data API v3 |
| **Fetcher** | RSS fetcher (`srv/lib/homepage-rss-fetcher.js`) | SAP Community blogs + SAP News RSS |
| **Merger** | Events merger (`srv/lib/homepage-events-merger.js`) | Merges DB events + events calendar |
| **Resolver** | Legacy-redirects resolver (`srv/lib/legacy-redirects-resolver.js`) | Loads `LegacyRedirects` from DB, refreshes hourly |
| **Approuter** | Loader + hit counter (`approuter/lib/`) | Loads `redirectsActive` at startup, records `POST /api/homepage/recordRedirectHits` |
| **Cron** | Link-health job (`srv/jobs/homepage-link-health.js`) | Nightly 04:00; updates `HomepageShelves.linkStatus` |

---

## Page Anatomy

Seven rows top-to-bottom on the homepage. Each verb also has a dedicated sub-page at `/<verb>/`:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Row 1 · Hero                                                         │
│   One short sentence. No CTAs, no search bar, no campaign slogan.   │
├──────────────────────────────────────────────────────────────────────┤
│ Row 2 · Verb spine                                                   │
│   Six tiles: Learn · Build · Integrate · Operate · AI · Connect.    │
│   Each tile previews the Start Here shelf + links to /<verb>/.       │
├──────────────────────────────────────────────────────────────────────┤
│ Row 3 · Events band                                                  │
│   3-4 upcoming events. Runtime: /api/homepage/events (60s cache).   │
├──────────────────────────────────────────────────────────────────────┤
│ Row 4 · SAPDevs video band                                           │
│   LEFT — Weekly Developer News. RIGHT — 3-4 recent @sapdevs videos. │
│   Runtime: /api/homepage/videos (15-min cache; YouTube Data API v3). │
├──────────────────────────────────────────────────────────────────────┤
│ Row 5 · Tutorials catalog teaser                                     │
│   6-8 featured cards. Build-time: hugo/data/browse.json.            │
│   "Browse all tutorials →" → /tutorial-navigator/.                  │
├──────────────────────────────────────────────────────────────────────┤
│ Row 6 · Community lane                                               │
│   Columns: Developer Advocates · Community blogs · SAP News.         │
│   Runtime: /api/advocates + /api/homepage/communityBlogs +          │
│            /api/homepage/news (30-min cache for feeds).              │
├──────────────────────────────────────────────────────────────────────┤
│ Row 7 · Comprehensive directory footer                               │
│   6 columns (one per verb). All 50+ destinations grouped by verb.   │
│   Build-time: hugo/data/homepage_shelves.json.                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Verb Sub-Page Contract

Each verb sub-page at `/<verb>/` renders all `HomepageShelves` entries for that verb, organized into four named shelves:

| Shelf key | Purpose |
|-----------|---------|
| `START_HERE` | 1-3 marquee entry points; admin-curated |
| `REFERENCE` | Canonical docs and APIs; admin-curated |
| `TOOLS` | IDEs, SDKs, GitHub org links; admin-curated |
| `KEEP_CURRENT` | Videos, community, news for this verb; mixed curated + live |

Three verb sub-pages carry an extra section beyond the four shelves:

| Sub-page | Extra section |
|----------|---------------|
| `/learn/` | Curated learning paths (missions / learning journeys) |
| `/operate/` | BTP service catalog teaser (Discovery Center feed) |
| `/connect/` | Events calendar (full upcoming event list) |

---

## Data Flow

| Row | Data source | Freshness mechanism |
|-----|-------------|---------------------|
| Row 1 hero | Static (Hugo front matter) | Rebuild only |
| Row 2 verb spine | `hugo/data/homepage_shelves.json` (baked from `GET /build/homepage-shelves`) | Rebuild on admin `HomepageShelves` save (debounced 60s dispatch) |
| Row 3 events | `GET /api/homepage/events` | 60s server-side cache |
| Row 4 videos | `GET /api/homepage/videos` | 15-min server-side cache; depends on `YOUTUBE_API_KEY` |
| Row 5 tutorial teaser | `hugo/data/browse.json` (baked at build time) | Rebuild only |
| Row 6 community | `/api/advocates` + `GET /api/homepage/communityBlogs` + `GET /api/homepage/news` | Advocates: 60s + SWR; RSS feeds: 30-min cache |
| Row 7 directory footer | `hugo/data/homepage_shelves.json` | Same as Row 2 |

`homepage_shelves.json` is generated during `build:all` by fetching `GET /build/homepage-shelves` from the CAP backend (same pattern as `/build/catalog` for missions). This bakes shelf content into the Hugo build so the directory footer and verb-spine previews work without a runtime API call.

---

## URL Contract

### New URLs (spec §9.1)

| URL | Serves |
|-----|--------|
| `/` | New developer-portal homepage |
| `/learn/` | Learn verb sub-page |
| `/build/` | Build verb sub-page |
| `/integrate/` | Integrate verb sub-page |
| `/operate/` | Operate verb sub-page |
| `/ai/` | Extend-with-AI verb sub-page |
| `/connect/` | Connect verb sub-page |
| `/tutorial-navigator/` | Relocated tutorial navigator (was `/`) |

### Legacy Redirects (spec §9.3)

Managed via the `LegacyRedirects` CDS entity. The approuter middleware (`approuter/server.js`) loads the redirect map at startup from `GET /api/homepage/redirectsActive` and refreshes hourly. Redirect hits are written back via `POST /api/homepage/recordRedirectHits` (idempotent batch, approuter-internal).

| Legacy URL | Target | Type |
|-----------|--------|------|
| `/tutorial-navigator.html` | `/tutorial-navigator/` | 301 named |
| `/index.html` | `/` | 301 named |
| `/topics/<tag>.html` | `/tags/<tag>/` | 301 pattern |
| `/mission.html?id=<id>` | `/missions/<slug>/` | 301 pattern |
| `/group.html?id=<id>` | `/groups/<slug>/` | 301 pattern |
| `/<any>.html` | `/<any>/` (if exists) | 301 catch-all |

---

## Admin Operations

**Add shelf entry:** Open `/admin-ui/#homepage`, Shelves tab, press Create. Set `verb`, `shelf`, `title`, `url`, and optionally `description`, `badge`, `sortOrder`. Save triggers a rebuild dispatch (60s debounce) so the change appears in `hugo/data/homepage_shelves.json` within ~2 minutes.

**Add legacy redirect:** Open `/admin-ui/#homepage`, Redirects tab, press Create. Set `fromPath`, `toPath`, `statusCode` (301 default), and optionally `isPattern`. The approuter middleware picks up changes on its next hourly refresh — no redeploy needed.

**Update YouTube playlist ID:** Open `/admin-ui/#homepage`, Config tab, edit `developerNewsPlaylistId` (the YouTube playlist ID for the featured Developer News series). The 15-minute video cache expires automatically; no restart needed.

**Nightly link-health:** The `homepage-link-health` cron job (04:00 daily) sends HEAD requests to every active `HomepageShelves.url` and writes `linkStatus` (`OK` | `SLOW` | `BROKEN`) + `lastChecked` back to the entity. Broken links surface as a red dot on the Shelves tab in the admin UI. Threshold for SLOW is 1500ms (default); timeout is 5000ms per URL; concurrency is 4 with 200ms between requests.

---

## Failure Modes

| Failure | Behaviour |
|---------|-----------|
| YouTube API 403 or timeout | Video band renders a static link card to `@sapdevs` YouTube channel. No crash. |
| Community blogs / SAP News RSS 4xx or network error | Empty column with a direct link to `community.sap.com` / `news.sap.com`. No crash. |
| Events DB unavailable | Events band renders empty. No crash. |
| `HomepageShelves` link-health `BROKEN` | Red indicator on admin Shelves tab only. No user-facing impact (links still render; admins decide whether to disable). |
| Approuter → srv unavailable at startup | Legacy-redirects resolver skips load and logs a warning; middleware retries on the next request. No boot crash. |
| `HomepageConfig` missing | Admin auto-init handler creates the singleton on first READ with safe defaults (`videoBandEnabled: true`, `eventsBandEnabled: true`, `communityLaneEnabled: true`). Consistent with the pattern used by `ChatSettings`, `DisplaySettings`, etc. |
| `YOUTUBE_API_KEY` not set | `youtube-fetcher.js` returns an empty array; video band degrades gracefully to the static link card. |
