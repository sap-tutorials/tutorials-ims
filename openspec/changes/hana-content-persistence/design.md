# Design: HANA Content Persistence

## Data Model

### CDS Entities

```cds
namespace com.sap.developers.ims;

entity ContentFiles : managed {
  key slug        : String(255);   // tutorial slug (e.g. "abap-environment-create-service")
  key version     : Integer;       // manifest version this file belongs to
  content         : LargeBinary;   // gzipped HTML
  contentHash     : String(64);    // SHA-256 of uncompressed content
  sizeBytes       : Integer;       // uncompressed size
  compressedBytes : Integer;       // stored size
  mimeType        : String(100) default 'text/html';
}

entity ContentManifest : managed {
  key version      : Integer;              // monotonically increasing
  status           : String(20) enum {
    PUBLISHING;    // write in progress
    ACTIVE;        // currently serving
    SUPERSEDED;    // replaced by newer version
    ROLLED_BACK;   // manually reverted
  };
  trigger          : String(500);          // what caused this publish (repo, commit SHA)
  fileCount        : Integer;              // total files in this version
  totalSizeBytes   : Integer64;            // total uncompressed size
  changedSlugs     : LargeString;          // JSON array of slugs changed in this version
  hugoVersion      : String(20);
  publishDurationMs: Integer;              // how long the publish took
}
```

### Storage Strategy

- Only **changed files** get new rows per version. Unchanged files are served from their last-written version.
- `GET /content/:slug` resolves to: `SELECT content FROM ContentFiles WHERE slug = :slug AND version = (SELECT MAX(version) FROM ContentFiles WHERE slug = :slug AND version <= :activeVersion)`
- This means a delta publish of 3 tutorials creates only 3 new `ContentFiles` rows, not 1378.

### Garbage Collection

Superseded versions older than 7 days can be pruned (scheduled job). Keep at least the 3 most recent versions for rollback.

## API Design

### POST /content/publish

Accepts a multipart payload or JSON with base64-encoded content:

```
POST /content/publish
Authorization: Bearer <REBUILD_API_KEY>
Content-Type: application/json

{
  "trigger": "sap-tutorials/abap-environment-create-service@a1b2c3d",
  "hugoVersion": "0.147.0",
  "files": [
    {
      "slug": "abap-environment-create-service",
      "hash": "sha256:abc123...",
      "content": "<base64-gzipped-html>",
      "sizeBytes": 45230
    }
  ]
}
```

Response:
```json
{
  "version": 42,
  "filesWritten": 1,
  "durationMs": 1230
}
```

### GET /content/:slug

```
GET /content/tutorials/abap-environment-create-service/index.html
Accept-Encoding: gzip

→ 200 OK
  Content-Type: text/html
  Content-Encoding: gzip
  ETag: "sha256:abc123..."
  Cache-Control: public, max-age=300
  <gzipped HTML body>
```

If client sends `If-None-Match: "sha256:abc123..."` and hash matches → `304 Not Modified`.

### GET /content/nav

Replaces the static `_nav.json`. Returns the navigation catalog dynamically from DB:

```json
{
  "version": 42,
  "tutorials": [
    { "slug": "abap-environment-create-service", "title": "...", "group": "..." }
  ]
}
```

### POST /content/rollback

```
POST /content/rollback
Authorization: Bearer <REBUILD_API_KEY>
Content-Type: application/json

{ "targetVersion": 41 }
```

Marks current as `ROLLED_BACK`, marks target as `ACTIVE`. Instant (no data copy).

## Concurrency Control

```
┌─────────────────────────────────────────────────────────┐
│              PUBLISH SERIALIZATION                       │
│                                                         │
│  1. BEGIN TRANSACTION                                   │
│  2. SELECT version FROM ContentManifest                 │
│     WHERE status = 'ACTIVE'                             │
│     FOR UPDATE                          ← blocks here   │
│  3. newVersion = activeVersion + 1                      │
│  4. INSERT ContentManifest (PUBLISHING)                 │
│  5. UPSERT ContentFiles (batch)                         │
│  6. UPDATE ContentManifest SET status = 'ACTIVE'        │
│  7. UPDATE old manifest SET status = 'SUPERSEDED'       │
│  8. COMMIT                              ← releases lock │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

If a second publish arrives while one is in progress, it blocks at step 2 until the first commits. This guarantees:
- No lost updates
- Monotonically increasing versions
- Each publish sees the latest state

Timeout: 30 seconds. If lock held longer, the transaction is rolled back and the publish retried by CI.

## AppRouter Integration

### Route Change (xs-app.json)

```json
{
  "source": "^/tutorials/(.+)",
  "target": "/content/tutorials/$1",
  "destination": "srv-api",
  "authenticationType": "none"
}
```

Tutorial requests route through the BTP Destination to CAP, which serves from HANA. The existing `approuter/static/` directory becomes a fallback for non-tutorial static assets (CSS, JS, images, root pages).

### Caching Layer

The AppRouter can optionally cache responses in-memory (LRU, bounded) to avoid repeated HANA reads for hot tutorials. The `ETag` + `Cache-Control: max-age=300` headers allow browser caching and conditional requests.

## CI Pipeline Changes

The existing `.github/workflows/rebuild-content.yml` changes from:

```
fetch ALL → Hugo build ALL → tar.gz 77MB → POST to approuter
```

To:

```
fetch CHANGED (SHA diff) → Hugo build CHANGED → POST delta JSON to CAP
```

### Delta Detection in CI

```bash
# Get list of changed tutorials from the dispatch event payload
CHANGED_SLUGS=$(echo "${{ github.event.client_payload.slugs }}" | jq -r '.[]')

# Or: compare SHAs against manifest
CURRENT_HASHES=$(curl -s $CAP_URL/content/hashes)
# ... diff against local build output
```

### Full Rebuild (fallback)

A manual trigger or scheduled nightly job can still do a full rebuild:
```bash
npm run fetch-tutorials && npm run build:hugo
# Then POST all files to /content/publish
```

## Migration Path

1. **Phase 1**: Deploy new CDS entities + publish/serve endpoints. Run full publish to seed HANA.
2. **Phase 2**: Add AppRouter route for `/tutorials/*` → CAP. Keep `static/tutorials/` as fallback (feature flag via env var).
3. **Phase 3**: Remove `static/tutorials/` from AppRouter. Delta CI pipeline becomes primary.
4. **Phase 4**: Remove `rebuildHandler` from `approuter/server.js` (the tar.gz endpoint).

Each phase is independently deployable and rollback-safe.
