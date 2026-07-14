---
title: On-read external-fetch caching (cds-caching)
description: TTL caching of on-read/ad-hoc external fetches (RSS / YouTube / Khoros profile) via the shared cds-caching service — key namespacing, invalidation, and RSS_TRANSPORT interaction.
---

# On-read external-fetch caching (`cds-caching`)

> Issue #1181. Builds on the #1177 prototype ([kg-neighborhood cache](../../../srv/lib/kg-neighborhood-cache.js), PR #1178) and the #1180 LRU migration.

## What this covers

The homepage and a couple of authenticated endpoints fan out **on-read** (request-time)
`fetch()` calls to third-party sources. Each is a latency/reliability risk on the
render path. These three on-read fetchers now wrap their responses in the shared
`caching` service (the `cds-caching` plugin) so a slow or failed upstream serves
the last good response instead of blocking or erroring a page:

| Fetcher | Source | Called from | Key prefix | TTL | Failure policy |
| --- | --- | --- | --- | --- | --- |
| `srv/lib/homepage-rss-fetcher.js` (`fetchRssItems`) | `news.sap.com` / `community.sap.com` RSS | homepage `news()` legacy pass-through + `get_recent_news` MCP tool | `rss:<url>` | 30 min | **not cached** — RSS recovers fast |
| `srv/lib/youtube-fetcher.js` (`fetchSapDevsVideos`) | `www.googleapis.com/youtube/v3` | homepage `videos()` handler | `yt:videos:<handle>\|<playlist>`, `yt:channel-id:<handle>` | 15 min (result) / 24 h (channel id) | **cached 1 min** — deliberate quota protection (#740) |
| `srv/lib/khoros-cache.js` (`get`/`set`/`evict`) | `community.sap.com` profile lookup | `developer-service.js` `setKhorosLink`/`getKhorosProfile`, `admin-service.js` `clearKhorosLink` | `khoros:<khorosId>` | 6 h | n/a (only successful profiles are stored) |

All three previously used hand-rolled in-process caches (a `globalThis`-singleton `Map`
or a bounded LRU). The migration preserves each source's original TTL and
success/failure policy verbatim — it only swaps the *storage* for the shared service,
which buys tag-based invalidation, metrics, and cross-CF-instance coherence. As of
issue #1179 the shared store **is** configured — the `caching` service uses the
CDS-Database store (`store: "cds"`) with metrics persistence in the
`[hybrid]`/`[production]` profiles, so these on-read caches are now coherent across CF
instances in prod. See [cds-caching CDS-Database store + metrics](./cds-caching-store.md).

## Scope boundary — what is NOT cached here

Most of these sources are **also** pulled by cron jobs (`srv/jobs/fetch-*.js`) that
persist to HANA. Those persist paths are intentionally left untouched — caching the
fetch would double-cache data that already has a durable home. The following fetchers
are **cron/persist only** and were deliberately excluded:

- `srv/lib/events/rss-fetcher.js` + `srv/lib/events/khoros-fetcher.js` (community events → `CommunityEvents`)
- `srv/lib/help-docs/*-fetcher.js` (help.sap.com / cap.cloud.sap / ui5 → `HelpDocs`)
- `srv/lib/youtube-corpus-fetcher.js` (video corpus → `ext.Videos`; distinct from the on-read `youtube-fetcher.js`)
- `srv/lib/khoros-blogs-client.js`, `srv/lib/sap-devs-*.js`, `srv/lib/sap-samples-fetcher.js` (all cron-fed)

Also **never cached** (per the issue): tutorial HTML / HANA BLOB paths
(`content-store.js`, `embedding-query.js`) — LOB-locator expiry + memory-footprint hazard.

## Key namespacing & invalidation

There is a single shared `caching` service (config in `package.json` under
`cds.requires.caching`, `namespace: 'kg'`, `store: 'memory'`). Per-source isolation is
done with **key prefixes**, not separate service instances — the same convention as
the `slice:` (#1180) and `pat:` (#1180) consumers and the kg-neighborhood cache:

- `rss:<feedUrl>` — the feed URL is the identity; different `limit` values share one entry (the full sorted array is cached, sliced on read).
- `yt:videos:<handle>|<playlistId>` and `yt:channel-id:<handle>`.
- `khoros:<khorosId>`.

Each entry is tagged so a whole source can be invalidated with one `deleteByTag`:

| Source | Tag | Bust command (programmatic) |
| --- | --- | --- |
| RSS | `homepage-rss` | `(await cds.connect.to('caching')).deleteByTag('homepage-rss')` |
| YouTube | `homepage-youtube` | `… .deleteByTag('homepage-youtube')` |
| Khoros | `khoros-profile` | `… .deleteByTag('khoros-profile')` |

**Time-based expiry is the primary invalidation strategy** — every entry has a TTL, so
staleness is bounded without any explicit bust. Explicit invalidation exists for two
cases: `khoros-cache.evict(id)` (a user re-links to a different Khoros id) and the
per-source tags above (operational reset). No cron or publish path needs to bust these
caches — they are read-time only and self-expire.

## Fail-open contract

Every get/set is wrapped in try/catch and **fails open**: a caching-service fault on
read is treated as a cache miss (fall through to the live fetch), and a fault on write
is logged and swallowed (the next read simply re-fetches). A caching outage therefore
degrades to the pre-#1181 behavior (always-live fetch), never to a page error.

## Interaction with `RSS_TRANSPORT` / curl-transport

The caching layer sits **above** the transport layer and does not interfere with it.
`fetchRssItems` still resolves its transport (`khoros` / `curl` / `fetch`) via
`RSS_TRANSPORT` on every cache **miss** — see [community-rss-transport.md](community-rss-transport.md).

Critically, **caching cannot mask a transport regression**: a cache miss goes through
the full `safeFetch` → transport chain live, and failures are not cached for RSS, so a
broken transport surfaces on the very next request after the 30-min TTL (or immediately
on a cold key). Unit tests force a live fetch by setting `RSS_TRANSPORT=fetch` and
clearing the store via the async `_resetForTests()` in `beforeEach`, so the stubbed
`global.fetch` is always exercised rather than served from cache.

## Testing notes

- Tests boot an in-memory caching store in `beforeAll` (`cds.env.requires.caching = { impl: 'cds-caching', namespace: '<x>-test', store: 'memory' }`) then `await cds.connect.to('caching')`.
- `_resetForTests()` is now **async** and connect-and-clears the store unconditionally (it must NOT gate the clear on the memoized connection promise, or a prior test's entries leak under the same key — this was the one regression caught during #1181, in `homepage-news-filter.test.js`).
- The cds-caching memory store honors `vi.useFakeTimers()` for TTL-boundary assertions (it reads `Date.now()` internally), so the YouTube 15-min-vs-1-min differential-TTL tests still work.
