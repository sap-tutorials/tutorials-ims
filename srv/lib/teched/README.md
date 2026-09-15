# TechEd RainFocus ingest (issue #2312, Unit F — FOUNDATION)

Fetches the **SAP TechEd 2026** session + speaker catalog (Berlin + Virtual)
from the RainFocus JSON search API that backs the catalog SPA, normalizes it,
and upserts it into the `TechEd*` entities (`db/external/teched.cds`,
namespace `com.sap.developers.ims.external`).

This is the FOUNDATION unit. Cron jobs, KG projection, embeddings, the
`/teched/` page, the island, and Devtoberfest cross-linking are LATER PRs that
build on these entities + the `/build/teched` feed.

## Files

| File | Role |
| --- | --- |
| `db/external/teched.cds` | `TechEdSessions`, `TechEdSpeakers`, `TechEdTracks`, `TechEdSessionSpeakers` (junction), `TechEdSessionConceptLinks` (KG link table, populated later) |
| `srv/lib/teched/rainfocus-fetcher.js` | `fetchAllTechEdSessions(opts)` → `{sessions, speakers, tracks}` (both venues, `Promise.allSettled`, dedup, retry, timeout, body cap, `_fetch` seam) |
| `srv/lib/teched/normalize.js` | `computeContentHash`, `generateSlug`, `normalizeSession/Speaker/Track` |
| `srv/lib/teched/seed-core.js` | `runSeed(...)` idempotent SELECT-then-UPSERT (source-owned columns only) |
| `scripts/seed-teched.cjs` | CLI wrapper (dry-run default; `--commit`, `--force`, `--file`) |
| `/build/teched` in `srv/server.js` | public projected feed, `Cache-Control: public, max-age=60` |

## RainFocus contract (confirmed reachable 2026-09-15)

RainFocus catalogs are backed by a single POST search endpoint. Confirmed by a
live probe from the build sandbox — an unauthenticated call returns a
structured JSON error, which establishes the request shape and success gate:

```
POST https://events.rainfocus.com/api/search
Content-Type: application/x-www-form-urlencoded
rfWidgetId: <per-venue widget id>
rfApiProfileId: <per-venue api profile id>

type=session&size=50&from=0        # sessions (offset pagination via `from`)
type=speaker&size=50&from=0        # speaker catalog
```

Success response:

```jsonc
{
  "responseCode": "0",            // non-"0" ⇒ error (e.g. "101" = Invalid API Profile)
  "responseMessage": "OK",
  "sectionList": [ { "items": [ /* session or speaker records */ ] } ]
}
```

Session records expose (field names vary per RainFocus deployment; the fetcher
reads common aliases): `sessionID`/`id`/`code`, `title`, `code`, `abstract`,
`times[].{utcStartTime,utcEndTime,room}`, `participants[]`/`speakers[]`,
`attributevalues[]` (Track), and `url`. Speaker records expose
`speakerId`/`id`, `firstName`/`lastName`/`fullName`, `jobtitle`,
`companyName`, `bio`, `photoURL`.

Flow ids: **Virtual = `tev26`**, **Berlin = `te26`** (from the catalog SPA URLs
`www.sap.com/events/teched/{virtual,berlin}/flow/sap/{tev26,te26}/...`).

### ⚠️ VERIFY LIVE before production use

- The **`rfWidgetId` / `rfApiProfileId` per venue are NOT yet known.** They live
  in the catalog SPA's JavaScript, which is **Akamai bot-gated** — a direct
  `curl` of the catalog page returns `Access Denied`. The 2026 catalog was also
  not yet live at capture time. Supply them via `opts.venues` or env
  (`TECHED_RF_TEV26_WIDGET_ID`, `TECHED_RF_TEV26_API_PROFILE`,
  `TECHED_RF_TE26_WIDGET_ID`, `TECHED_RF_TE26_API_PROFILE`).
- The test fixture (`test/fixtures/teched/rainfocus-search.json`) is therefore
  **constructed** to match the confirmed contract, not a live capture. When the
  catalog goes live, capture a real response, diff the field names against
  `parseSession`/`parseSpeakers` in the fetcher, and refresh the fixture.

To discover the IDs from a browser once the catalog is live: open the catalog,
watch the Network tab for the `POST /api/search` request, and copy the
`rfWidgetId` / `rfApiProfileId` request headers.

## Running the seed

```bash
# dry-run from the fetcher-output fixture
npx cds bind --exec -- node scripts/seed-teched.cjs --file test/fixtures/teched/teched-feed.json

# commit
npx cds bind --exec -- node scripts/seed-teched.cjs --file test/fixtures/teched/teched-feed.json --commit

# live (needs the venue widget/apiProfile env vars above)
npx cds bind --exec -- node scripts/seed-teched.cjs --commit
```

Re-running with unchanged input is a no-op: rows whose `contentHash` is
unchanged are skipped (`--force` bypasses the skip). Curated/lifecycle columns
(`pinUntil`, `lastExtractedHash`, `firstSeenAt`) are never overwritten.
