# TechEd RainFocus ingest (issue #2312)

Fetches the **SAP TechEd 2026** session catalog (Berlin + Virtual) — sessions,
their embedded speakers, and tracks — from the RainFocus JSON API that backs
the catalog SPA, normalizes it, and upserts it into the `TechEd*` entities
(`db/external/teched.cds`, namespace `com.sap.developers.ims.external`).

Ingest runs on a recurring delta schedule (below). KG concept-link enrichment
is flag-gated. The `/teched/` page, the island, and Devtoberfest cross-linking
build on these entities + the `/build/teched` feed.

## Files

| File | Role |
| --- | --- |
| `db/external/teched.cds` | `TechEdSessions`, `TechEdSpeakers`, `TechEdTracks`, `TechEdSessionSpeakers` (junction), `TechEdSessionConceptLinks` (KG links) |
| `srv/lib/teched/rainfocus-fetcher.js` | `fetchAllTechEdSessions(opts)` → `{sessions, speakers, tracks}` (both venues, `safeFetch` SSRF guard, `Promise.allSettled`, dedup, retry, body cap, `_fetch` seam) |
| `srv/lib/teched/normalize.js` | `computeContentHash` (array-order-independent), `generateSlug`/`toKebabSlug` (via shared `slugify`), `normalizeSession/Speaker/Track` |
| `srv/lib/teched/seed-core.js` | `runSeed(...)` idempotent SELECT-then-UPSERT (source-owned columns only; `metadataOnly` mode for the refresh job) |
| `srv/lib/teched-session-extract.js` | LLM adapter — extract `covers` concept links from a session |
| `srv/jobs/fetch-teched-sessions-job.js` | **weekly** — fetch + upsert + delta core (always) + flag-gated KG enrichment |
| `srv/jobs/refresh-teched-sessions-job.js` | **every 6 h** — metadata-only upsert (no LLM; never touches contentHash/lastExtractedHash) |
| `scripts/seed-teched.cjs` | CLI wrapper (dry-run default; `--commit`, `--force`, `--file`) |
| `/build/teched` in `srv/server.js` | public projected feed, `Cache-Control: public, max-age=60` |

## RainFocus contract (proven live 2026-09-15, both venues)

The catalog is backed by a POST endpoint. An unauthenticated server-side call
(no browser, no cookie, no bearer token) with the per-venue profile+widget
headers returns the catalog:

```
POST https://events.rainfocus.com/api/sessions
content-type: application/x-www-form-urlencoded; charset=UTF-8
rfapiprofileid: <per-venue api profile id>
rfwidgetid:     <per-venue widget id>

type=session&browserTimezone=Europe%2FBerlin&catalogDisplay=list&from=<n>&size=<n>
```

Success response:

```jsonc
{
  "responseCode": "0",             // non-"0" ⇒ failure (e.g. "Invalid API Profile")
  "responseMessage": "Success",
  "totalSearchItems": 299,         // Berlin 299, Virtual 49
  "sectionList": [ { "total": 299, "from": 0, "size": 50, "items": [ /* sessions */ ] } ]
}
```

**Pagination.** `size` is honored but hard-capped at 50 server-side (omitting it
defaults to 20). Loop `from += size` until `from >= totalSearchItems`. The
fetcher requests `size=50` and pages accordingly, retrieving the full catalog
(~297 Berlin + 49 Virtual after dropping a couple of invalid/all-day rows).
Hammering the endpoint with many rapid requests can trip a soft throttle that
returns empty offset pages; the fetcher's empty-page break + retry/backoff
handle that gracefully (partial ingest that cycle, recovers next cycle).

**Session item fields:** `sessionID`, `code`, `title`, `abstract`, `type`,
`eventName`, `eventCode`, `published`, and
`times[].{date, room, length, startTime, endTime, utcStartTime, utcEndTime, dayName}`.
`utcStartTime`/`utcEndTime` are UTC in `"YYYY/MM/DD HH:MM:SS"` form (NOT ISO) —
the fetcher normalizes them to ISO-Z (plain `Date.parse` would misread them as
local time).

**Speakers are EMBEDDED per session** in `participants[]` (no separate speaker
endpoint): `speakerId` (stable, venue-suffixed), `fullName`/`firstName`/`lastName`,
`companyName`, `globalJobtitle` (or `jobtitle`), `bio`, `photoURL`. De-duped by
`speakerId` — the same person at both venues has distinct ids, so is two rows.

**Tracks** come from `attributevalues[]` where `attribute === "Track"` (other
facets — "Products (offerings)", subtracks, "Session level", … — are ignored).
The stable track id is `rf_attributevalue_id` (same across venues); `value` is
the display name. First Track wins (schema is single-track per session).

**Credentials** (static for the event lifetime but MAY rotate) are configurable
via env, defaulting to the live 2026 values:

| Venue | profile env | widget env |
| --- | --- | --- |
| Berlin (te26)   | `RAINFOCUS_TE26_PROFILE`  | `RAINFOCUS_TE26_WIDGET`  |
| Virtual (tev26) | `RAINFOCUS_TEV26_PROFILE` | `RAINFOCUS_TEV26_WIDGET` |

A venue whose call returns a non-"0" `responseCode` (or otherwise throws) fails
SOFTLY via `Promise.allSettled` — the other venue still ingests.

## Scheduled jobs

- **`fetch-teched-sessions`** (weekly, Sun 05:43 UTC) — fetch both venues,
  then `runSeed` (idempotent upsert of sessions/speakers/tracks + junction
  reconciliation, `contentHash` delta). This fetch+upsert+delta core ALWAYS
  runs. KG concept-link enrichment (embed + LLM `covers` extraction into
  `TechEdSessionConceptLinks`, then set `lastExtractedHash`) is **double-gated**
  (`KNOWLEDGE_GRAPH_ENABLED` master switch AND `KG_TECHED_SESSIONS_ENABLED`,
  default OFF) and fail-open. #708 crash-safety: sessions whose
  `lastExtractedHash === contentHash` are skipped.
- **`refresh-teched-sessions`** (every 6 h at :23) — metadata-only upsert
  (`runSeed({ metadataOnly: true })`) for the `/teched/` page; NO LLM cost;
  deliberately never touches `contentHash`/`lastExtractedHash` (owned by the
  weekly job), so the two jobs are idempotent on the same rows.
- GC: `TechEdSessions` is in `gc-external-content-job` `ITERATION_SET`
  (`teched-session`, TTL 730 d) — stale rows past `lastSeenAt + 2×TTL` (and
  unpinned) are pruned, cascading the junction + concept links.

## Running the seed

```bash
# dry-run from the fetcher-output fixture
npx cds bind --exec -- node scripts/seed-teched.cjs --file test/fixtures/teched/teched-feed.json

# commit
npx cds bind --exec -- node scripts/seed-teched.cjs --file test/fixtures/teched/teched-feed.json --commit

# live (uses the default 2026 credentials, or the RAINFOCUS_* env overrides)
npx cds bind --exec -- node scripts/seed-teched.cjs --commit
```

Re-running with unchanged input is a no-op: rows whose `contentHash` is
unchanged are skipped (`--force` bypasses the skip). Curated/lifecycle columns
(`pinUntil`, `lastExtractedHash`, `firstSeenAt`) are never overwritten.

## Fixtures

`test/fixtures/teched/rainfocus-search.json` is a REAL (trimmed) capture of
`POST /api/sessions` for both venues (2026-09-15). `teched-feed.json` is the
fetcher-output shape (`{sessions,speakers,tracks}`) derived by running
`fetchAllTechEdSessions()` over that real capture. Refresh both by re-capturing
if the upstream field shape changes.
