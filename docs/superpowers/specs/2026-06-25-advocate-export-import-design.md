# Advocate Export/Import Script — Design

**Date:** 2026-06-25
**Status:** Approved, awaiting implementation
**Owner:** Tom

## Problem

Developer Advocate records were set up manually in the DEV subaccount: ~40+ Advocates with photos, social links, topic tags, and (for some) `user_ID` links to `Users`. We want to seed PROD with the same data when PROD goes live (July 2026), and we don't want to lose the DEV setup again if the DB is rebuilt.

There is no current way to ship Advocates between subaccounts. The existing migrators (`migrate-reference-data.js`, `migrate-from-hana.js`) cover tutorials/missions/groups/events/tags and user progress, but not the four Advocate tables added in PR #404 / #618.

## Goals

- Snapshot the Advocate roster from any CAP-bound DB to a single JSON file on disk.
- Restore that snapshot into any CAP-bound DB, idempotently.
- Survive schema-level differences in target: missing `Users` rows or missing `Tags` rows must not block the import of the parent `Advocates` row.
- Carry photos (BLOBs in `AdvocatePhotos`) so the restored roster is visually complete with no manual photo re-upload.

## Non-goals

- Live DEV→PROD sync. This is a manually-triggered batch tool.
- Direct HANA-to-HANA streaming. We always go through an intermediate JSON file (auditable, git-able, replayable).
- Reverse direction (PROD → DEV) — same script works either way because both ends use `cds.connect.to('db')`, but we don't document or recommend it.
- Deletes. If DEV removes an advocate, PROD keeps theirs until manually deleted.

## Data model recap

Four tables in [db/advocates.cds](../../../db/advocates.cds):

| Table | Key | Notes |
|---|---|---|
| `Advocates` | `ID` (UUID), `slug` unique | Parent. `user` association FK to `ims.Users`; `@assert.unique.user` enforces 1:1 |
| `AdvocateTopics` | `ID` (UUID) | Child — `advocate` + `tag` FKs |
| `AdvocateLinks` | `ID` (UUID) | Child — `advocate` FK, kind enum + url + label + sortOrder |
| `AdvocatePhotos` | `advocate` (composite-PK association) | 1:1 with Advocate. Holds `photo256` and `photo64` LargeBinary, mime, sha256, sizeBytes |

`Advocates.slug` is the natural key (unique constraint at DB level) and is what we use to identify advocates across DBs.

## Files

Two new scripts under `scripts/`, plus npm-script aliases:

- **`scripts/export-advocates.js`** — reads from the currently-bound CAP DB, writes `.migration-data/advocates.json`.
- **`scripts/import-advocates.js`** — reads `.migration-data/advocates.json`, writes to the currently-bound CAP DB.

```json
"export:advocates": "cds bind --exec -- node scripts/export-advocates.js",
"import:advocates": "cds bind --exec -- node scripts/import-advocates.js"
```

Both use plain `cds.connect.to('db')` and execute via `cds bind --exec` so the right DB binding is in scope.

## Why raw SQL, not the CAP service layer

The advocate handlers in [srv/handlers/advocate-handlers.js](../../../srv/handlers/advocate-handlers.js) are registered on **AdminService only** and do two distinct things we want to bypass:

1. **`before('CREATE'/'UPDATE', AdvocatePhotos)` → `processPhotoUpload`** — runs uploaded bytes through a sharp/WebP pipeline that re-encodes the image to 256px and 64px variants. If we wrote our exported (already-encoded) BLOBs through this path, the bytes would be decoded and re-encoded — wasteful at best, and a fidelity risk if sharp's defaults change between DEV and PROD deploys.
2. **`after('CREATE'/'UPDATE'/'DELETE', AdvocatePhotos)` and `after('UPDATE', Advocates)`** — maintain the sync invariant `Advocates.hasPhoto` ↔ `Advocates.photoUrl` ↔ presence of an `AdvocatePhotos` row, re-deriving `photoUrl` from `slug` via `urlForSlug()`.

If we wrote through AdminService, every export-then-import round-trip would re-encode photos and re-derive metadata in the target environment. Two consequences:

1. **Fidelity**: handler logic may differ between DEV and PROD at import time (sharp version upgrade, URL format change). The imported state could drift from the exported state.
2. **Speed**: handler invocations serialize per-row, and sharp re-encoding is the slowest step.

Going through `cds.db.run()` (compiled CQN, not REST) gives us:

- Exactly the bytes we exported, no rewrites. `Advocates.photoUrl` is exported and re-inserted verbatim — we trust the source.
- Single-transaction-per-advocate semantics.
- No XSUAA / `@requires` interaction (no auth context needed).
- Sidesteps the Fiori draft layer entirely. `Advocates` is draft-enabled in AdminService; raw writes target the `Advocates` active table, not `Advocates.drafts`, with no draft activation step.

The precedent for `cds.db.run()` against entity-level CQN in this repo is [scripts/migrate-from-hana.js](../../../scripts/migrate-from-hana.js) (raw `INSERT/UPDATE` SQL against HANA tables via a prepared-statement helper). Note that [scripts/migrate-reference-data.js](../../../scripts/migrate-reference-data.js), despite the similar name, is an HTTP migrator that POSTs to `/admin/<Entity>` endpoints — it goes **through** the service stack, not around it, and is NOT the pattern we're following here.

## Photo BLOB retrieval

`Advocates` includes `photo` as a composition association which CDS QL would happily expand, but doing so puts both metadata and `LargeBinary` columns in the same query. That hits the HANA LOB-locator-expiry bug documented in [CLAUDE.md](../../../CLAUDE.md) and worked around in [srv/lib/content-store.js](../../../srv/lib/content-store.js). The locator returned by HANA expires before the stream is consumed in the export script.

Mitigation: BLOBs are pulled in a **separate** query per advocate:

```js
// pseudo-SQL
SELECT photo256, photo64, photoMimeType, sizeBytes, sha256, uploadedAt
FROM com_sap_developers_ims_AdvocatePhotos
WHERE advocate_ID = ?
```

The script reads each BLOB column as a `Buffer`, base64-encodes it for JSON. On SQLite (unit tests, if any) CDS QL with a single SELECT works fine; export gates on `cds.db.kind` to choose.

## Export payload

`.migration-data/advocates.json`:

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-06-25T14:00:00.000Z",
  "sourceDb": "tutorials-db (DEV)",
  "advocateCount": 42,
  "advocates": [
    {
      "slug": "thomas-jung",
      "firstName": "Thomas",
      "lastName": "Jung",
      "title": "Chief Developer Advocate",
      "pronouns": "he/him",
      "location": "Texas, USA",
      "region": "AMERICAS",
      "bio": "...markdown...",
      "isActive": true,
      "sortOverride": null,
      "joinedDate": "2010-01-01",
      "hasPhoto": true,
      "photoUpdatedAt": "2026-06-20T09:00:00.000Z",
      "photoUrl": "/api/advocates/thomas-jung/photo",
      "userEmail": "thomas.jung@sap.com",
      "topics": [
        { "tagSlug": "software-product>sap-build" },
        { "tagSlug": "topic>extensibility" }
      ],
      "links": [
        { "kind": "LinkedIn", "url": "https://linkedin.com/in/...", "label": null, "sortOrder": 100 },
        { "kind": "X",        "url": "https://x.com/...",          "label": null, "sortOrder": 200 }
      ],
      "photo": {
        "photoMimeType": "image/webp",
        "sizeBytes": 12345,
        "sha256": "abc123...",
        "uploadedAt": "2026-06-20T09:00:00.000Z",
        "photo256_b64": "UklGRiQA…",
        "photo64_b64":  "UklGRiQA…"
      }
    }
  ]
}
```

Design choices:

- **UUIDs not carried.** `Advocates.ID`, `AdvocateTopics.ID`, `AdvocateLinks.ID` are stripped. Target gets fresh UUIDs on insert. Avoids any cross-DB UUID collision risk and simplifies the import code (no UUID conflict handling).
- **`userEmail` instead of `user_ID`.** `Users.ID` is environment-specific; `Users.email` is the join key. Resolved at export time with a single LEFT JOIN.
- **`tagSlug` instead of `tag_ID`.** Same reasoning. `Tags.slug` is the stable join key.
- **`photo` is null when `hasPhoto` is false** — omits the BLOB section entirely.
- **`schemaVersion: 1`** — header field so a future incompatible change can be detected and rejected by `import-advocates.js`.

Payload size estimate: 256px WebP ≈ 10-30KB, 64px ≈ 2-5KB; with base64 inflation (×4/3) the average advocate is ~50KB. 100 advocates ≈ 5MB JSON. Comfortably git-able if desired; we'll add `.migration-data/` to `.gitignore` (it already is, per existing migrators).

## Import behavior

For each advocate in the JSON, run inside a single transaction:

1. **Lookup existing row by slug.**
   `SELECT ID, user_ID FROM Advocates WHERE slug = ?`
   → result determines INSERT vs UPDATE.

2. **Resolve `user_ID`.**
   If `userEmail` is set:
   `SELECT ID FROM Users WHERE LOWER(email) = LOWER(?)`
   - Match found → use it.
   - No match → `user_ID = NULL`, log `[<slug>] user FK not resolved: <email> missing in target`.
   - `userEmail` itself null/missing in payload → `user_ID = NULL`, no warning.

3. **Upsert Advocates row.**
   - If row exists: `UPDATE Advocates SET ... WHERE slug = ?`. Preserves the existing `ID` so any external references (none currently, but defensive) stay valid.
   - If not: `INSERT INTO Advocates (ID, slug, ...) VALUES (newuuid(), ?, ...)`.

4. **Replace topics.**
   `DELETE FROM AdvocateTopics WHERE advocate_ID = ?`. Then for each `topics[]` entry:
   `SELECT ID FROM Tags WHERE slug = ?`
   - Match → `INSERT INTO AdvocateTopics (ID, advocate_ID, tag_ID) VALUES (newuuid(), ?, ?)`.
   - No match → skip, log `[<slug>] topic skipped: tag '<tagSlug>' missing in target`.

5. **Replace links.**
   `DELETE FROM AdvocateLinks WHERE advocate_ID = ?`. Then `INSERT` all entries with fresh UUIDs and the carried `kind` / `url` / `label` / `sortOrder` values verbatim.

6. **Replace photo.**
   `DELETE FROM AdvocatePhotos WHERE advocate_ID = ?`. If `photo` is present in the payload, decode the base64 BLOBs and `INSERT INTO AdvocatePhotos (advocate_ID, photo256, photo64, photoMimeType, sizeBytes, sha256, uploadedAt)`.

The replace-not-merge semantics for topics/links/photo make the import safely re-runnable. Re-exporting from DEV after edits and re-importing converges PROD to match.

## Output / observability

End-of-run summary printed to stdout:

```
[advocates-import] Imported 42 advocates: 38 updated, 4 inserted
[advocates-import] FK resolution: 40 users matched, 2 NULLed
                   (john.doe@sap.com, jane.smith@sap.com)
[advocates-import] Topics:  156 matched, 3 skipped
                   (missing tags: foo>bar, baz>qux, deprecated>thing)
[advocates-import] Photos:  39 imported, 3 had no photo
[advocates-import] Done in 4.2s
```

Per-row WARN logs go to stdout as encountered, not buffered. Errors throw and abort the run (no partial commit — each advocate is wrapped in a tx). Exit codes: 0 success (warnings don't fail), 1 hard error.

## Edge cases

- **Empty source DB**: export writes `advocateCount: 0`, valid JSON. Import is a no-op.
- **`Advocates.user` already pointing to a different `Users` row in target** that doesn't match the exported `userEmail`: re-resolve unconditionally. The exported state wins.
- **Target `Users` has two rows with the same email (case-insensitive collision)**: pick the first by `createdAt` ASC, log a warning. Should never happen — `Users.email` is `@assert.unique`.
- **Target `Tags` has the same slug twice**: same fallback. `Tags.slug` is also unique-asserted; only the data-migration scripts that pre-date `@assert.unique` could produce this.
- **`photo256` or `photo64` corrupt / not valid base64**: `Buffer.from(..., 'base64')` is forgiving (no throw on invalid chars), but `sha256` won't match. We do NOT re-verify sha256 on import — that's a separate concern; trust the export.
- **CAP after-handlers running anyway?** They listen on service-level events (READ/CREATE/UPDATE on `AuthorService.Advocates`). Raw `cds.db.run()` against entity-level CQN bypasses them — that's the design and is well-trodden in `migrate-reference-data.js`.
- **`@assert.unique.user` violation in target**: only possible if the exported set has the same `userEmail` twice. Pre-check at export time and refuse (`Two advocates have the same userEmail in source DB`), since the violation would be silent (UPDATE wouldn't fire it, INSERT would). Note that multiple advocates with `userEmail = null` are fine: HANA's UNIQUE on a nullable column treats NULLs as distinct (the schema comment at [db/advocates.cds:46-48](../../../db/advocates.cds#L46) calls this out), so any number of unlinked advocates coexist.

## How to use

```bash
# 1. Export from DEV
cf login   # to DEV subaccount, dev space
npm run export:advocates
# → writes .migration-data/advocates.json

# 2. Import to PROD
cf login   # to PROD subaccount, prod space
npm run import:advocates
# → reads .migration-data/advocates.json, prints summary
```

Optional: `git add -f .migration-data/advocates.json && git commit` if Tom wants a versioned snapshot in the repo. The default `.gitignore` keeps it out unless `-f`-added.

## Testing

- **Manual smoke**: export from DEV → restore into a clean local sqlite DB (`cds deploy --to sqlite::memory:`) → diff record counts and a hand-picked advocate's fields by eye.
- **No automated test** for the round-trip is added in v1. The script is single-purpose and run-on-demand; the cost of mocking a HANA LargeBinary round-trip outweighs the value. If we end up running this multiple times across upgrades, we'll add a hybrid test.

## Out of scope (future work, if needed)

- `--dry-run` flag for import (preview deltas without writing).
- `--delete-missing` flag for import (sync-down: remove advocates in target not in source).
- Diff command (`compare-advocates.js` analogous to `compare-systems.js`) to verify post-import.
- Auto-export on admin save (akin to the `rebuild-content.yml` dispatch trigger).
