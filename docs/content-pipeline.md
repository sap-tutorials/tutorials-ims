# Content Pipeline

Complete flow of tutorial content from GitHub source to end-user delivery, including exception handling, versioning, and tracking.

## Pipeline Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                        CONTENT PIPELINE                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────────┐  │
│  │  FETCH   │───▶│  PARSE   │───▶│  BUILD   │───▶│     PUBLISH      │  │
│  │ (GitHub) │    │ (MD→AST) │    │  (Hugo)  │    │ (Delta → HANA)   │  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────────────┘  │
│       │                                                    │             │
│       ▼                                                    ▼             │
│  .tutorial-cache/                               ContentFiles (BLOB)      │
│  errors.json                                    ContentManifest          │
│                                                                          │
│                        ┌──────────────────┐                              │
│                        │      SERVE       │◀── LRU Cache (50MB)          │
│                        │ (Decompress+ETag)│                              │
│                        └──────────────────┘                              │
│                                 ▲                                        │
│                                 │                                        │
│                        AppRouter /tutorials/*                             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Fetch (`scripts/fetch-tutorials.ts`)

Downloads tutorial markdown from the `sap-tutorials` GitHub organization.

### Steps

| Step | Action | Concurrency | Output |
|------|--------|-------------|--------|
| 1.1 | GraphQL discovery of repos | Sequential (paginated, 100/page) | `.tutorial-cache/_discovery.json` |
| 1.2 | Batch metadata prefetch | 3 repos × 20 tutorials/batch | `.tutorial-cache/github-meta.json` |
| 1.3 | Download markdown | 5 concurrent tutorials | `.tutorial-cache/{slug}.md` + `.sha` |
| 1.4 | Parse & transform | Inline (per tutorial) | `hugo/content/tutorials/{slug}.md` |
| 1.5 | Fetch CAP catalog | Single request | `.tutorial-cache/cap-catalog.json` |
| 1.6 | Generate navigation | Inline | `hugo/content/tutorials/_nav.json` |

### Cache Strategy (SHA-based)

```text
For each tutorial slug:
  local_sha  = read .tutorial-cache/{slug}.sha
  remote_sha = latest commit SHA from GitHub

  if local_sha == remote_sha → use cached .md (status: "cached")
  if local_sha != remote_sha → re-fetch .md (status: "refreshed")
  if no local file           → fetch new   (status: "fetched")
```

Cache stored in `.tutorial-cache/` (gitignored). Delete directory to force full re-fetch.

### Exception Handling

| Failure | Scope | Behavior | Recovery |
|---------|-------|----------|----------|
| Markdown 404 | Single tutorial | Error thrown, caught | Logged to `errors.json`; pipeline continues |
| GitHub rate limit | Batch | Batch metadata fails | Fallback metadata applied (`{lastCommitSha: '', ...}`) |
| GraphQL errors | Discovery | Warnings logged | Continues with discovered repos |
| rules.vr fetch fail | Single tutorial | Returns null silently | Tutorial proceeds without quiz data |
| CAP catalog fail | All missions | Warning logged | Proceeds without mission/group assignments |
| Network timeout | Per request | Standard fetch rejection | Caught per-tutorial; logged |

### Error Tracking

Failed tutorials are written to `.tutorial-cache/errors.json`:

```json
[
  {
    "slug": "tutorial-slug",
    "repo": "sap-tutorials/repo-name",
    "error": "HTTP 404: Not Found",
    "timestamp": "2026-05-05T10:30:00.000Z"
  }
]
```

---

## Phase 2: Parse (`scripts/parsers/`)

Transforms raw markdown into Hugo-compatible content pages.

### Parser Selection

Determined by frontmatter field `parser: v2`:
- **V2** (current): H3 headings (`###`) delimit steps
- **V1** (legacy): `[ACCORDION-BEGIN]` / `[ACCORDION-END]` markers

### Transformations Applied

| Parser | File | Transformation |
|--------|------|----------------|
| Frontmatter | `parsers/frontmatter.ts` | Extract YAML metadata (title, level, tags, time) |
| Steps | `parsers/steps.ts` | Split into numbered steps with titles |
| Images | `parsers/images.ts` | Resolve relative paths → `raw.githubusercontent.com` CDN URLs |
| Options | `parsers/options.ts` | `[OPTION BEGIN]`/`[OPTION END]` → Hugo shortcodes |
| Rules | `parsers/rules.ts` | Parse `.rules.vr` quiz validation files |
| CAP | `parsers/cap.ts` | Inject mission/group metadata from build catalog |
| HTML | Inline | Escape dangerous HTML; preserve allowed tags |

### Safety: HTML Escaping

- HTML outside code fences is escaped (prevents XSS in rendered tutorials)
- Allowed tags preserved: `TutorialStep`, `OptionTabs`, `template`
- Component tag balancing: missing closing tags auto-added

---

## Phase 3: Build (Hugo)

Standard Hugo static site generation.

```bash
npm run build:hugo  # → hugo/public/tutorials/*/index.html
```

Output: One `index.html` per tutorial slug in `hugo/public/tutorials/`.

---

## Phase 4: Publish (`scripts/publish-content.ts`)

Delta-aware upload of changed tutorial HTML to SAP HANA Cloud.

### Delta Detection Algorithm

```text
1. Scan hugo/public/tutorials/ for index.html files
2. Compute SHA-256 hash of each local file
3. GET /content/hashes → { slug: remoteHash }
4. Compare:
   - slug in local but not remote     → NEW (publish)
   - local hash != remote hash        → MODIFIED (publish)
   - local hash == remote hash        → UNCHANGED (skip)
5. If /content/hashes unreachable     → publish ALL (fail-open)
```

### Payload Construction

For each changed slug:
1. Read HTML file
2. Gzip compress
3. Base64 encode
4. Include `__nav__` special entry (navigation metadata)

```text
POST /content/publish
Authorization: Bearer <CONTENT_API_KEY>
Content-Type: application/json

{
  "trigger": "ci@<commit-sha>",
  "hugoVersion": "0.139.0",
  "files": {
    "tutorial-slug-1": "<base64-gzipped-html>",
    "tutorial-slug-2": "<base64-gzipped-html>",
    "__nav__": "<base64-gzipped-json>"
  }
}
```

### CLI Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Show what would change without uploading |
| `--force` | Skip delta detection, republish all files |
| `--verbose` | Extra logging of hash comparisons |

### Exception Handling

| Failure | Behavior |
|---------|----------|
| `/content/hashes` returns 503 | Treat all files as changed (publish all) |
| Network error on POST | Script exits with non-zero code |
| 401 Unauthorized | Missing/wrong `CONTENT_API_KEY` |
| 409 Conflict | Another publish in progress (retry later) |

---

## Phase 5: Content Store (`srv/lib/content-store.js`)

Server-side persistence, versioning, and serving layer.

### Database Schema

```text
┌─────────────────────────────────┐    ┌───────────────────────────────────┐
│       ContentManifest            │    │          ContentFiles              │
├─────────────────────────────────┤    ├───────────────────────────────────┤
│ PK version: Integer              │    │ PK slug: String(255)              │
│    status: Enum                  │◀──▶│ PK version: Integer               │
│    trigger: String(500)          │    │    content: LargeBinary (gzip)    │
│    fileCount: Integer            │    │    contentHash: String(64)        │
│    totalSizeBytes: Int64         │    │    sizeBytes: Integer             │
│    changedSlugs: LargeString     │    │    compressedBytes: Integer       │
│    hugoVersion: String(20)       │    │    mimeType: String(100)          │
│    publishDurationMs: Integer    │    │    created_at: Timestamp          │
│    created_at: Timestamp         │    └───────────────────────────────────┘
│    updated_at: Timestamp         │
└─────────────────────────────────┘

ContentManifest.status:
  PUBLISHING  → in-progress write (transient)
  ACTIVE      → currently served to users
  SUPERSEDED  → replaced by newer version
  ROLLED_BACK → explicitly reverted
```

### Publish Handler (`POST /content/publish`)

```text
┌─ Acquire distributed lock (content-publish, 120s TTL) ─────────────────┐
│                                                                          │
│  1. Create manifest (status: PUBLISHING, version: max+1)                │
│  2. For each file in payload:                                            │
│     - Decode base64 → gzipped buffer                                    │
│     - Decompress → compute SHA-256                                       │
│     - Record: slug, version, content, hash, sizes                       │
│  3. Batch INSERT ContentFiles (groups of 50)                             │
│  4. Mark previous ACTIVE manifest → SUPERSEDED                          │
│  5. Update current manifest → ACTIVE + stats                            │
│  6. Invalidate LRU cache                                                 │
│  7. Log to PipelineLog                                                   │
│                                                                          │
└─ Release lock ──────────────────────────────────────────────────────────┘

Response 201:
{
  "version": 42,
  "filesWritten": 5,
  "totalSizeBytes": 1234567,
  "durationMs": 3200
}
```

### Concurrency Control

- **Distributed lock** via `JobLocks` table (expiry-based claiming)
- Lock key: `content-publish`
- TTL: 120 seconds (auto-expires if process crashes)
- Conflict response: `409 Conflict` with retry guidance

### Serve Handler (`GET /content/tutorials/:slug`)

```text
Request: GET /content/tutorials/abap-dev-create-table
         If-None-Match: "abc123..."

┌──────────────────────────────────────────────────────────┐
│ 1. Resolve active version from ContentManifest            │
│ 2. Check LRU cache (key: slug@version)                    │
│    ├─ HIT + ETag match → 304 Not Modified                │
│    ├─ HIT             → 200 (X-Content-Source: cache)    │
│    └─ MISS            → continue to DB                    │
│ 3. Query ContentFiles (slug + active version)             │
│    ├─ HANA: raw SQL (avoids LOB locator expiry bug)      │
│    └─ SQLite: CDS QL (unit tests)                        │
│ 4. Decompress gzip → HTML                                │
│ 5. Store in LRU cache                                     │
│ 6. Return 200 (X-Content-Source: db)                     │
│                                                           │
│ Headers:                                                  │
│   ETag: <contentHash>                                     │
│   Cache-Control: public, max-age=300                      │
│   Content-Type: text/html; charset=utf-8                  │
└──────────────────────────────────────────────────────────┘
```

### LRU Cache Details

| Parameter | Value |
|-----------|-------|
| Max size | 50 MB |
| Eviction | Least-recently-used |
| Invalidation | Full flush on publish or rollback |
| Key format | `{slug}@{version}` |

### HANA LOB Workaround

HANA BLOB columns return `Readable` streams with locators that expire before consumption when selected alongside non-BLOB columns in CDS QL. The content store uses **raw SQL** (`cds.run(sql)`) for BLOB retrieval on HANA, bypassing the CDS QL layer. SQLite (used in unit tests) uses standard CDS QL since it doesn't have this limitation.

---

## Phase 6: Rollback (`POST /content/rollback`)

Reverts to a previous content version without re-publishing.

```text
POST /content/rollback
Authorization: Bearer <CONTENT_API_KEY>
Body: { "targetVersion": 41 }  (optional — defaults to most recent SUPERSEDED)

Steps:
  1. Find target version (must be SUPERSEDED status)
  2. Current ACTIVE → ROLLED_BACK
  3. Target → ACTIVE
  4. Flush LRU cache
  5. Return new active version info
```

Rollback is instantaneous since all version data persists in `ContentFiles`.

---

## Phase 7: Garbage Collection (`srv/jobs/cleanup.js`)

Scheduled daily at 03:00 UTC by the job scheduler.

### Content Version Pruning

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `keepCount` | 3 | Minimum superseded versions retained for rollback |
| `olderThanDays` | 7 | Only prune versions older than this |

```text
Candidates = ContentManifest WHERE
  status IN ('SUPERSEDED', 'ROLLED_BACK')
  AND created_at < (now - 7 days)

Candidates sorted by version DESC → skip first 3 (keepCount)
For remaining: DELETE ContentFiles + DELETE ContentManifest
```

**Safety**: Never touches `ACTIVE` or `PUBLISHING` manifests.

### Other Cleanup Tasks

| Task | Retention | Schedule |
|------|-----------|----------|
| Content version pruning | 3 versions / 7 days | Daily 03:00 |
| PipelineLog entries | 30 days | Daily 03:00 |
| StepFailures records | 90 days | Daily 03:00 |
| Unused tags | Immediate | Daily 03:00 |

---

## Tracking & Observability

### ContentManifest (Version History)

Each publish creates a manifest row tracking:
- Version number (monotonically increasing)
- Status lifecycle: `PUBLISHING → ACTIVE → SUPERSEDED`
- Trigger source (e.g., `ci@abc123`, `manual`)
- File count and total size
- List of all changed slugs (JSON array in `changedSlugs`)
- Hugo version used
- Server-side publish duration

### PipelineLog

Records all pipeline events (publishes, rollbacks) with timestamps, initiator, and outcome. Retained for 30 days.

### Response Headers (Serve)

| Header | Purpose |
|--------|---------|
| `X-Content-Source` | `cache` or `db` — indicates whether LRU cache was hit |
| `X-Content-Version` | Active manifest version number |
| `ETag` | SHA-256 hash of content (enables 304 responses) |
| `Cache-Control` | `public, max-age=300` (5-minute browser cache) |

### Error Surfaces

| Endpoint | Error | HTTP Code | Meaning |
|----------|-------|-----------|---------|
| `/content/publish` | Lock held | 409 | Another publish in progress |
| `/content/publish` | Bad token | 401 | Missing/invalid `CONTENT_API_KEY` |
| `/content/tutorials/:slug` | No active version | 503 | No content published yet |
| `/content/tutorials/:slug` | Slug not found | 404 | Tutorial not in active manifest |
| `/content/rollback` | No target | 404 | No SUPERSEDED version available |
| `/content/hashes` | No active version | 503 | No content published yet |

---

## End-to-End Flow (CI/CD)

```text
┌─ CI Pipeline ───────────────────────────────────────────────────────────┐
│                                                                          │
│  1. npm install                                                          │
│  2. npm run fetch-tutorials          ← GitHub → .tutorial-cache/        │
│  3. npm run build:all                ← Hugo → hugo/public/              │
│  4. npm run publish-content          ← Delta → HANA (ContentFiles)      │
│     └─ CONTENT_API_KEY required                                          │
│     └─ CAP_BASE_URL points to deployed srv                               │
│  5. npm run test:smoke               ← Verify /tutorials/* responds     │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Environment Variables

| Variable | Required By | Purpose |
|----------|-------------|---------|
| `GITHUB_TOKEN` | fetch | Avoid GitHub API rate limits |
| `CONTENT_API_KEY` | publish, rollback | Bearer token for write operations |
| `CAP_BASE_URL` | fetch (catalog), publish | Target CAP server URL |
| `SMOKE_BASE_URL` | smoke tests | AppRouter URL for integration tests |

---

## Request Routing (Production)

```text
Browser → AppRouter (xs-app.json)
  /tutorials/(.*)  →  rewrite to /content/tutorials/$1  →  CAP srv
                                                              │
                                                              ▼
                                                    content-store.js
                                                              │
                                                    ┌─────────┴─────────┐
                                                    │   LRU Cache Hit?   │
                                                    └─────────┬─────────┘
                                                         yes / no
                                                        /       \
                                                   200          HANA query
                                                              (raw SQL)
                                                                │
                                                            decompress
                                                                │
                                                            200 + cache
```

Tutorial HTML is served exclusively from HANA BLOBs. There is no static file fallback — if no content has been published, `/tutorials/*` returns 404.

---

## Resilience: AppRouter Restage / Filesystem Loss

Cloud Foundry containers are ephemeral — a restage, restart, or crash recovery destroys the local filesystem. This section documents the impact on content serving.

### What the AppRouter filesystem contains

The AppRouter's `approuter/static/` directory holds:
- Hugo-built static assets (CSS, JS, images, landing pages)
- **NOT tutorials** — explicitly removed during build (`rm -rf approuter/static/tutorials`)

### What happens on restage

```text
┌─ AppRouter restaged ────────────────────────────────────────────────────┐
│                                                                          │
│  Lost:                                                                   │
│    • Static assets (CSS, JS, images)                                    │
│    • Landing pages, mission pages, group pages                          │
│                                                                          │
│  NOT lost (never on filesystem):                                         │
│    • Tutorial HTML content (lives in HANA)                              │
│    • Content manifests and version history (HANA)                       │
│    • Navigation metadata (HANA)                                          │
│                                                                          │
│  Temporarily lost (rebuilt on first request):                            │
│    • CAP srv in-memory LRU cache (50MB) — cold start, repopulates      │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Impact by component

| Component | Storage | Restage Impact | Recovery |
|-----------|---------|----------------|----------|
| Tutorial HTML | HANA BLOBs | **None** — never on AppRouter filesystem | Immediate |
| Content versions | HANA (ContentManifest) | **None** | Immediate |
| LRU cache (CAP srv) | In-memory (srv process) | Lost if srv also restaged | Auto-rebuilds on requests |
| Static assets (CSS/JS) | AppRouter filesystem | **Lost** — must redeploy | MTA deploy restores from build artifact |
| Hugo landing pages | AppRouter filesystem | **Lost** — must redeploy | MTA deploy restores from build artifact |

### Why tutorials survive

The architectural decision to store tutorials in HANA rather than as static files was made specifically for this reason:

1. **Decoupled lifecycle** — Content publishes independently of app deploys. A new tutorial can go live without redeploying the AppRouter.
2. **Restage-proof** — CF container recreation doesn't affect content availability. The AppRouter is a stateless proxy for `/tutorials/*`.
3. **Rollback without redeploy** — `POST /content/rollback` reverts content instantly without touching CF at all.

### The request path after restage

```text
Browser: GET /tutorials/abap-dev-create-table

AppRouter (freshly restaged, empty filesystem):
  1. xs-app.json route: /tutorials/(.*) → destination "srv-api", path /content/tutorials/$1
  2. AppRouter does NOT look for /tutorials/ on its own filesystem
  3. Proxies to CAP srv

CAP srv:
  4. content-store.js resolves active ContentManifest version
  5. LRU cache miss (cold start) → query HANA
  6. Decompress BLOB → return HTML
  7. Populate LRU cache for subsequent requests

Result: 200 OK — user sees tutorial content as normal
```

### Recovery scenarios

| Scenario | Tutorial Content | Static Assets | Action Required |
|----------|-----------------|---------------|-----------------|
| AppRouter restage only | Unaffected | Lost | Redeploy MTA (or just approuter module) |
| CAP srv restage only | Unaffected (HANA) | Unaffected | None — LRU cache rebuilds automatically |
| Both restaged | Unaffected (HANA) | Lost | Redeploy MTA |
| HANA Cloud restart | Temporarily unavailable | Unaffected | Wait for HANA recovery; content intact |
| Full MTA redeploy | Unaffected (HANA) | Restored from build | None |

### Edge case: First deploy (no content in HANA)

If the AppRouter is deployed before any content has been published to HANA, `/tutorials/*` returns 404. This is the expected "empty state." Run `npm run publish-content` against the deployed CAP srv to populate content.
