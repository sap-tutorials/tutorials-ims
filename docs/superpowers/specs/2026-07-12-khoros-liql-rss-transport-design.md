# Design: Khoros LiQL transport for community blog fetch (#1144)

**Date:** 2026-07-12
**Issue:** [sap-tutorials/tutorials-ims#1144](https://github.com/sap-tutorials/tutorials-ims/issues/1144) — Route community RSS fetch via Destination Service / proxy (durable successor to curl transport)
**Status:** Approved, ready for implementation plan

## Problem

`community.sap.com` RSS feeds 403 from the CF app. The shipped curl transport (#1145) borrowed
curl's TLS fingerprint to beat what looked like a JA3 challenge — but post-deploy verification
proved the real discriminator is **egress-IP reputation, not TLS fingerprint**: the identical curl
invocation returns **200 from a workstation IP and 403 from the CF `eu10-005` egress IP**. So
`RSS_TRANSPORT=fetch` and `RSS_TRANSPORT=curl` are now equivalent (both 403 from CF) — the
`community-blogs-fetch` cron has been returning `fetched=0 errored=3`.

The issue proposes three durable successors: (1) Destination Service to community.sap.com,
(2) forward proxy with clean egress, (3) authenticated/API feed that bypasses the public
Cloudflare edge.

## Decision

**Option 3 — the SAP Community Khoros API feed.** `community.sap.com` runs on Khoros (Lithium),
which exposes an **unauthenticated** LiQL JSON API:

```
GET https://community.sap.com/api/2.0/search?q=<LiQL>
→ {"status":"success","http_code":200,"data":{"items":[...]}}
```

Verified 2026-07-12 (from a non-CF egress IP): returns blog posts with every field the fetcher
needs. Only **unauthenticated** access is available/authorized (confirmed by maintainer).

**Why not Options 1 & 2:**
- **Option 1 (Destination Service to community.sap.com) does not solve the problem.** A plain
  Destination Service is a credential/config store, *not* a proxy — an HTTP destination consumed
  from the CF app still egresses from the app's own `eu10-005` IP. Same flagged IP → still 403.
  Only an on-premise/Cloud-Connector-routed destination would change egress, and no Cloud
  Connector is provisioned for `tutorial-system`.
- **Option 2 (forward proxy)** would work but requires standing up and operating new egress
  infrastructure. Deferred as the contingency if Option 3 proves IP-blocked from CF egress too.

### LiQL field map (verified)

`SELECT subject, post_time, view_href, teaser, author.login FROM messages WHERE (<predicate>) AND depth=0 ORDER BY post_time DESC LIMIT 20`

| Khoros field  | RSS/fetcher field       | Notes                              |
|---------------|-------------------------|------------------------------------|
| `subject`     | title                   |                                    |
| `post_time`   | publishedAt             | ISO8601 w/ offset                  |
| `view_href`   | link / sourceUrl        | post permalink                     |
| `teaser`      | description → snippet   | HTML; `toSnippet` strips tags      |
| `author.login`| author                  |                                    |
| `depth=0`     | —                       | top-level posts only (no replies)  |

All three seeded sources map cleanly (verified 2026-07-12):
- board feeds → `board.id='technology-blog-sap'` / `board.id='technology-blog-members'`
- category feed ("Community — Technology, all blogs") → `category.id='technology' AND conversation.style='blog'`

## ⚠️ Unresolved risk (accepted)

`/api/2.0/*` sits behind the **same Cloudflare edge** as `/rss`. The verification above is from a
non-CF IP — the exact caveat that made the curl fix look fine locally yet 403 from CF egress.
Whether the JSON API path is IP-reputation-blocked from CF egress is **UNKNOWN** and cannot be
probed locally (`cf ssh` not authorized in `tutorial-system/dev`).

**Verification is deploy-and-observe:** run the `community-blogs-fetch` cron on the CF app and check
`fetched>0`. If the API path also 403s from CF egress, Khoros-over-app-egress fails identically and
we fall back to curl (kill switch) and escalate to Option 2 (proxy / Cloud-Connector egress) as a
follow-up issue. The maintainer chose to ship Khoros as default and verify on CF rather than
probe-first.

## Architecture

The existing `safeFetch(url, { fetchImpl })` seam (`srv/lib/safe-fetch.js`) is unchanged. We add a
**third transport** alongside native fetch and `curlFetch`.

```
community-blogs-fetcher.js / homepage-rss-fetcher.js
  → builds Khoros API URL from source.apiQuery
  → safeFetch(khorosApiUrl, { fetchImpl: khorosFetch, allowedHosts: {community.sap.com} })
      → SSRF guard runs (host pin + public-IP check + per-hop redirect re-check)
      → khorosFetch(url)  [native fetch → JSON]
          → adapts JSON items into RSS-compatible XML
          → returns Response-shaped { ok, status, headers, text() }
  → parseRss(xml)  ← UNCHANGED; consumes synthesized XML exactly like real RSS
  → isEnglish / toSnippet / upsertOne  ← UNCHANGED
```

**Key design choice:** the Khoros transport emits the **same XML shape** `parseRss()` already
consumes. Nothing downstream changes — the transport is a pure input adapter. This isolates the new
code to one file and keeps the parser/filter/upsert chain untouched and already-tested.

### `RSS_TRANSPORT` becomes tri-state

| Value    | Transport            | Use                                   |
|----------|----------------------|---------------------------------------|
| `khoros` | khorosFetch (**default**) | JSON API, native fetch            |
| `curl`   | curlFetch            | rollback to #1145 behavior (kill switch) |
| `fetch`  | native fetch → RSS   | local/tests against real RSS          |

Shared resolver used by both `community-blogs-fetcher.js` and `homepage-rss-fetcher.js`.

## Components

### New: `srv/lib/khoros-transport.js`
- `khorosFetch(url, init)` — `fetch`-shaped. Receives the fully-built Khoros API URL (the fetcher
  composes it), calls native `fetch`, parses JSON, synthesizes RSS XML from `data.items`, returns a
  `Response`-shaped object (`ok`, `status`, `headers.get()`, `async text()`).
- `buildKhorosUrl(apiQuery)` — composes the LiQL: wraps the admin predicate in parens, appends fixed
  `SELECT`/`AND depth=0`/`ORDER BY`/`LIMIT`, URL-encodes `q`. Exported for the fetchers + tests.
- `itemsToRssXml(items)` — JSON→XML adapter. Emits `<item><title><link><pubDate><description>` +
  `<language>en` so `isEnglish` short-circuits on `language`.
- Body-size cap (mirror events fetcher `MAX_BODY_BYTES`); `LIMIT 20` bounds item count.
- Fail-open: malformed/empty JSON → empty `<rss>` → `parseRss` yields `[]`.
- **NO SSRF validation of its own** (same contract as curl-transport) — it runs inside `safeFetch`.

### Changed: `srv/lib/community-blogs-fetcher.js` & `srv/lib/homepage-rss-fetcher.js`
- Tri-state `rssTransport()` resolver.
- community-blogs: build the Khoros API URL from `source.apiQuery`; pass it as the `safeFetch` URL
  with `allowedHosts: new Set(['community.sap.com'])`; inject `khorosFetch`.
- Per-source fallback: if `source.apiQuery` is null/empty in khoros mode → fall back to curl for
  that one source and log it (un-migrated source degrades to today's behavior, doesn't fail).
- homepage-rss-fetcher: the homepage lane uses a fixed community feed; give it a hardcoded/derived
  `apiQuery` for the community lane (its URLs are the same board feeds).

### Changed: `db/community-blogs.cds`
- Add `apiQuery : String(500);` (nullable) to `CommunityBlogSources`.

### Changed: `srv/admin-service.js`
- Auto-init `before('READ','CommunityBlogSources')`: seed `apiQuery` for the 3 managed rows via the
  existing upsert path (NOT via CSV — avoids the `.hdbtabledata` editable-column-wipe gotcha).
- `before('CREATE'/'UPDATE','CommunityBlogSources')`: validate `apiQuery` against an allowlist —
  permit only `[A-Za-z0-9_.'= ]` + `AND`/`OR`; reject `;`, `LIMIT`, `SELECT`, `ORDER`, backslash,
  and parens (we add our own). Read-only public API → worst case is "wrong blog list," no writes.

### Changed: `.deploy/mta.yaml`
- Add `srv/lib/khoros-transport.js` to the `srv-qa` `cp` list (else QA boot crashes at MTA deploy —
  transitive dep of `community-blogs-fetcher.js` which is already in the list).

### Regenerated: `db/last-dev/csn.json`
- Via `cds build --production` after the `db/community-blogs.cds` change (schema change must land in
  `db/last-dev/`; `cds compile` is insufficient).

## Data flow

1. Cron `community-blogs-fetch` → `fetchAllSources()` → per active source `fetchOneSource()`.
2. `fetchOneSource` reads `source.apiQuery`; if present + khoros mode → `buildKhorosUrl(apiQuery)`.
3. `safeFetch(khorosUrl, { fetchImpl: khorosFetch, allowedHosts:{community.sap.com}, ... })`.
4. `khorosFetch` → native `fetch` → JSON → `itemsToRssXml` → Response w/ `text()` = XML.
5. `parseRss(xml)` → items → `isEnglish` filter → `upsertOne` on `sourceUrl` (unchanged).

## Error handling

- Transport-level: non-2xx from Khoros → returned as `res.status`; fetcher logs `HTTP <status>` and
  counts `errored` (existing behavior). A CF-egress 403 surfaces here — the deploy-observe signal.
- Malformed/empty JSON → empty XML → `parseRss` `[]` → `fetched=0` for that source, fail-open.
- Missing `apiQuery` → per-source curl fallback + warn log.
- Injection: `apiQuery` allowlist at write time; `q` URL-encoded at build time.
- Kill switch: `cf set-env tutorials-srv RSS_TRANSPORT curl && cf restart tutorials-srv`.

## Testing

- **Unit** (`test/unit/khoros-transport.test.js`):
  - Real Khoros JSON fixture (captured 2026-07-12) → `itemsToRssXml` → `parseRss` yields expected
    title/link/pubDate/author/snippet.
  - `buildKhorosUrl` composes + encodes correctly; injection allowlist rejects `;`/`LIMIT`/`SELECT`.
  - Empty/malformed JSON → `[]` (fail-open).
  - Missing `apiQuery` → curl-fallback path selected.
  - **Test-stub inversion (document in file header):** khoros mode uses *native* fetch, so these
    tests CAN `vi.stubGlobal('fetch', ...)` — unlike curl-mode tests, which bypass the fetch stub
    (see memory `curl-transport-bypasses-fetch-stub`). RSS-path tests that must exercise the *real*
    RSS parser via `fetch` still set `RSS_TRANSPORT=fetch`.
- **Existing tests** (`homepage-rss-fetcher.test.js`, `homepage-news-filter.test.js`,
  `srv-fetchers-ssrf-guard.test.js`): confirm still green; update transport-mode env as needed.
- **Deploy verification:** trigger cron on CF, assert `fetched>0` in `cf logs tutorials-srv`.

## Acceptance criteria (from issue)

- Cron returns 200 on CF egress **without shelling to curl** — design satisfies; **confirmation pending deploy-observe** (the unresolved-risk gate).
- SSRF guards preserved — transport injected into `safeFetch`; host pinned to `community.sap.com`. ✔ by design.
- `RSS_TRANSPORT` kill switch retained — tri-state, `curl` reverts to #1145. ✔ by design.

## Out of scope / YAGNI

- Forward proxy / Cloud-Connector egress (Option 2) — the contingency if CF egress 403s the API too.
  Not pre-built; a follow-up issue if the deploy-observe step fails.
- Authenticated Khoros access — only unauthenticated is authorized.
- The events RSS fetcher (`srv/lib/events/rss-fetcher.js`) — different, non-community feeds; untouched.
