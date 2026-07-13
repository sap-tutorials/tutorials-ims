# Community blog RSS transport (`RSS_TRANSPORT`)

The homepage Community lane and the `community-blogs-fetch` cron pull SAP Community
blog posts. `community.sap.com` is behind Cloudflare, which blocks the CF app's
outbound requests. This doc explains the transport layer that works around it.

## History (why this is not just `fetch`)

1. **#1033** — Node `fetch` got 403s on the RSS feeds. First fix: a browser-shaped
   User-Agent + client-hint headers (`srv/lib/rss-parse.js` `RSS_FETCH_HEADERS`).
   Worked in July 2026, then silently died.
2. **#1143 / #1145** — Cloudflare escalated to a TLS/HTTP-2 **fingerprint** (JA3/JA4)
   challenge, so headers alone couldn't help. Fix: route through the `curl` binary
   (`srv/lib/curl-transport.js`) to borrow its TLS fingerprint.
3. **Post-#1145 finding** — curl **also** 403s from the CF `eu10-005` egress IP,
   even though the identical curl call returns 200 from a workstation. The real
   discriminator is **egress-IP reputation, not TLS fingerprint**. So `curl` and
   native `fetch` are now equivalent (both 403 from CF).
4. **#1144 (this doc)** — durable successor: hit the SAP Community **Khoros LiQL
   JSON API** (`https://community.sap.com/api/2.0/search`), which is
   **unauthenticated** and returns blog posts as JSON. We adapt that JSON into
   RSS-compatible XML so the existing parser chain is untouched.

## The tri-state `RSS_TRANSPORT` env var

Both `srv/lib/community-blogs-fetcher.js` and `srv/lib/homepage-rss-fetcher.js`
resolve a transport by `process.env.RSS_TRANSPORT`:

| Value    | Transport                     | When to use                                    |
|----------|-------------------------------|------------------------------------------------|
| `khoros` | Khoros JSON API → RSS XML     | **Default.** The durable path.                 |
| `curl`   | `curlFetch` (curl binary)     | Rollback / kill switch (reverts to #1145).     |
| `fetch`  | native `fetch` on the raw RSS | Local dev + unit tests against real RSS.       |

Anything other than an explicit `curl`/`fetch` resolves to `khoros`.

Kill switch (instant rollback, no redeploy):

```bash
cf set-env tutorials-srv RSS_TRANSPORT curl && cf restart tutorials-srv
```

## How the Khoros path works

`srv/lib/khoros-transport.js`:
- `buildKhorosUrl(apiQuery)` composes the LiQL and returns the full API URL:
  `SELECT subject,post_time,view_href,teaser,author.login FROM messages
   WHERE (<apiQuery>) AND depth=0 ORDER BY post_time DESC LIMIT 20`
- `khorosFetch(url, init)` — a `fetch`-shaped transport (uses **native fetch**),
  calls the API, and synthesizes RSS 2.0 XML from `data.items` via `itemsToRssXml`.
- `validateApiQuery(q)` — allowlist for admin-supplied predicates (letters, digits,
  `_ . ' = -` space + `AND`/`OR`; rejects `;`, `LIMIT`, `SELECT`, `ORDER`, backslash).

Field map (JSON → RSS → fetcher):

| Khoros field   | RSS element   | Fetcher field       |
|----------------|---------------|---------------------|
| `subject`      | `<title>`     | title               |
| `view_href`    | `<link>`      | link / sourceUrl    |
| `post_time`    | `<pubDate>`   | publishedAt         |
| `teaser`       | `<description>` | descriptionSnippet |
| `author.login` | `<dc:creator>`  | author            |
| —              | channel `<language>en>` | (makes isEnglish accept) |

CDATA-wrapped fields are `]]>`-escaped to close an XML-injection vector on
community-authored titles.

## Where the query comes from

- **`community-blogs-fetch` cron:** each `CommunityBlogSources` row carries an
  `apiQuery` column (nullable, admin-editable, `#1144`). Seeded for the 3 managed
  rows — **NOT** the seed CSV (adding a column to `db/data/*.csv` triggers the
  `.hdbtabledata` editable-column wipe). The defaults and the backfill live in
  **`srv/lib/community-blog-source-defaults.js`** (single source of truth), and
  `backfillManagedApiQuery` is invoked from BOTH places that can be the first to
  touch the table: `srv/admin-service.js`'s `before('READ')` hook AND the cron's
  `fetchAllSources()`. The cron self-heals a NULL managed `apiQuery` in-flight, so
  it no longer depends on an admin having opened the Sources page. A source with
  no `apiQuery` (unmanaged/user-added) degrades to `curl` on its raw `feedUrl`.

  > **History:** #1155 shipped the `apiQuery` column but left the only backfill in
  > the admin READ hook. On DEV, nobody opened the Sources page post-deploy, so all
  > 3 managed rows stayed NULL, every source fell back to curl, and curl 403'd from
  > the CF egress IP → the feed silently went 4 days stale (diagnosed 2026-07-13).
  > Moving the backfill into the cron path (this section) is the durable fix.
- **Homepage lane:** `homepage-rss-fetcher.js` derives `board.id='<id>'` from the
  feed URL's `?board.id=` param (`apiQueryFromFeedUrl`); no board.id → curl fallback.
  In practice the homepage community lane is served from the DB
  (`HomepageService.communityBlogs()` reads `CommunityBlogPosts`, which the cron
  populates), and the only URLs passed to `fetchRssItems` today (the `news.sap.com`
  feed and the community aggregate feed) carry **no** `board.id` — so they take the
  curl fallback, not the Khoros path. The board.id derivation exists so that a
  board-scoped homepage feed URL would automatically use Khoros, but no such caller
  exists yet.

## SSRF guard is preserved

The transport is injected into `safeFetch(url, { fetchImpl })` exactly like
`curlFetch` — it performs no validation of its own. On the Khoros path,
`allowedHosts` is pinned to `new Set(['community.sap.com'])`, and the protocol
allowlist + private-IP rejection + per-hop redirect re-check all still run.

## ✅ Verified working from CF egress (2026-07-13)

`/api/2.0/*` is behind the **same Cloudflare edge** as `/rss`, so it was an open
question whether the JSON API would also 403 from the CF `eu10-005` egress IP
(that exact caveat masked the #1145 curl regression). **Resolved 2026-07-13:** a
forced cron run on `tutorial-system/dev` logged
`community-blogs-fetcher: 3 sources → fetched=60 ... errored=0` and
`CommunityBlogPosts` populated 40 fresh rows. The Khoros JSON API path returns
**200 from CF egress** — the IP-reputation block that killed native fetch and
curl does **not** apply to it. No forward-proxy / Cloud Connector needed.

To re-confirm after any deploy, trigger the cron (admin board force-trigger) and check:

```bash
cf logs tutorials-srv --recent | grep community-blogs-fetcher
# expect: fetched=<N>  with N>0  and  errored=0
```

If it ever 403s again (`errored>=sources`), roll back with `RSS_TRANSPORT=curl` and
escalate to a forward-proxy / Cloud-Connector egress (issue #1144 Option 2, not yet built).

## Test gotcha

The Khoros transport uses **native `fetch`**, so khoros-mode unit tests CAN
`vi.stubGlobal('fetch', ...)`. The **curl** transport shells out and does NOT go
through `global.fetch` — tests exercising the curl path must set
`RSS_TRANSPORT='fetch'` (or mock `curl-transport.js`) or they hit the real network.

## Staleness alarm (`COMMUNITY_BLOGS_STALE_HOURS`)

The `community-blogs-fetch` job (`srv/jobs/community-blogs-fetch-job.js`) can
return HTTP 200 yet ingest **0 new posts** for days — a degraded transport (e.g.
`apiQuery=NULL` → curl fallback → CF-egress 403) "succeeds" every tick with
`inserted=0`. That mode went unnoticed for 4 days once (2026-07-13) because the
only alarm fired when *all* sources errored, and a quiet zero-insert tick is
recorded as a **success** on the `JobLastRun` cron-health tile.

The job therefore also checks freshness: after a clean fetch it reads
`MAX(createdAt)` from `CommunityBlogPosts` (the last time a genuinely *new* post
landed — an updated-only tick does not reset it) and **throws** if that is older
than `COMMUNITY_BLOGS_STALE_HOURS`. Throwing rides the cron chassis into the two
admin-visible surfaces a thrown job error already hits — `JobLastRun.lastErrorAt`
+ `lastErrorMessage` (Cron-health tile) and a `PipelineLog` **FAILED** row (Job Log
tile) — so a silent stall becomes loud without any new entity or endpoint.

| Knob | Default | Meaning |
|------|---------|---------|
| `COMMUNITY_BLOGS_STALE_HOURS` | `48` | Throw when the newest ingested post is ≥ this many hours old. |
| `COMMUNITY_BLOGS_STALE_HOURS=0` | — | **Disables** the staleness alarm (the age gauge is still emitted). |

Notes:
- **48h is deliberately loose.** The 3 managed boards (technology all-blogs /
  by-SAP / by-members) produce multiple posts a day, so 48h of nothing is
  anomalous, not a slow news day. A normal quiet tick never throws — only
  sustained staleness does.
- **Empty table (fresh env / first run) is not stale** — `MAX(createdAt)` is null,
  the check is skipped.
- A `community_blogs.newest_post_age_hours` **gauge** is emitted every run
  (visible in `MetricSnapshots` / `GET /admin/metrics/live`) for trend analysis,
  independent of whether the alarm fires.
- Tune down for faster paging (`cf set-env tutorials-srv COMMUNITY_BLOGS_STALE_HOURS 24 && cf restart tutorials-srv`).
