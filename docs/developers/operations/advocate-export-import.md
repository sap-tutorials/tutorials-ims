# Advocate Export / Import Runbook

Snapshot the Developer Advocate roster (records + topics + links + photos)
from any CAP-bound HANA DB to a JSON file on disk, and restore it
idempotently into any other CAP-bound HANA DB. Use this to seed PROD
from DEV (or re-seed DEV if it gets wiped).

**Spec:** [docs/superpowers/specs/2026-06-25-advocate-export-import-design.md](../../superpowers/specs/2026-06-25-advocate-export-import-design.md)
**Plan:** [docs/superpowers/plans/2026-06-25-advocate-export-import.md](../../superpowers/plans/2026-06-25-advocate-export-import.md)
**Scripts:** [scripts/export-advocates.cjs](../../../scripts/export-advocates.cjs), [scripts/import-advocates.cjs](../../../scripts/import-advocates.cjs)

## When to use

- Seeding a fresh PROD subaccount with DEV's curated advocate roster.
- Restoring DEV after a destructive schema redeploy wipes `Advocates`.
- Snapshotting DEV before a risky change so you can roll back.

## What gets carried

| Carried | Not carried |
| --- | --- |
| All `Advocates` columns (slug, name, bio, region, photoUrl, …) | UUID `ID` (target gets fresh UUIDs on insert) |
| `Advocates.user_ID` re-resolved by `Users.email` | `Users` rows themselves — must already exist in target |
| All `AdvocateTopics` re-resolved by `Tags.slug` | `Tags` rows themselves — missing slugs are skipped with WARN |
| All `AdvocateLinks` (kind/url/label/sortOrder) verbatim | nothing |
| Both photo variants (`photo256`, `photo64`) + `sha256` + `sizeBytes` | nothing |

## How to run

```bash
# 1. Export from source (typically DEV)
cf login   # → DEV subaccount, dev space
npm run export:advocates
# → writes .migration-data/advocates.json

# 2. Import to target (typically PROD)
cf login   # → PROD subaccount, prod space
npm run import:advocates
```

The `.migration-data/` directory is `.gitignore`d. To version a snapshot
in the repo, `git add -f .migration-data/advocates.json`.

## Idempotency

`npm run import:advocates` is safely re-runnable. On second run:

- Advocates with matching slug → UPDATE in place (existing UUID preserved).
- Topics/links/photo for that advocate → fully replaced.
- Advocates in target but not in source → left alone (no deletes).

Edits made in target between runs of the import will be lost on the next
import — DEV is the source of truth.

## Warnings to expect

The import script logs (and continues) on:

- **User FK not resolved** — the advocate's `userEmail` doesn't match any
  `Users` row in target. Advocate is inserted with `user_ID = NULL`.
  Lazy IDP self-heal on next login will populate `Users`; re-running the
  import after that will fill the FK.
- **Topic skipped** — the `tagSlug` doesn't match any `Tags` row in target.
  Edit the `Tags` table in target admin UI to add the tag, then re-run import.

Hard failures (exit 1):

- `.migration-data/advocates.json` missing — run export first.
- `schemaVersion` mismatch — payload was produced by a different version of
  the script. Either re-export from source with the current version or
  upgrade the import script.
- Duplicate `userEmail` in source — two advocates linked to the same User.
  Fix in source admin UI before re-exporting.

## What it bypasses (and why)

The scripts use raw `cds.db.run()` against entity-level CQN, not the
AdminService HTTP endpoints. This intentionally bypasses:

- The `processPhotoUpload` sharp/WebP re-encoder (would re-encode bytes
  we already exported; defeats the snapshot guarantee).
- The `flipHasPhoto` / `photoUrl` after-handlers (would re-derive fields
  we already exported; the exported values are trusted).
- The draft-table layer on the draft-enabled `Advocates` entity (we write
  directly to the active table; no draft activation).

See [the spec](../../superpowers/specs/2026-06-25-advocate-export-import-design.md#why-raw-sql-not-the-cap-service-layer)
for the full rationale.

## SQLite quirk (local dev only)

`@cap-js/sqlite` stores `LargeBinary` columns as base64-encoded text
internally. A raw `SELECT photo256 FROM com_sap_developers_ims_AdvocatePhotos`
on a local SQLite DB returns the base64 string (inflated by ~33%), not
the raw Buffer. Read via CDS QL to get the canonical Buffer/stream:

```javascript
const [row] = await db.run(
  SELECT.one.from('com.sap.developers.ims.AdvocatePhotos')
    .columns('photo256','sha256','sizeBytes')
    .where({ advocate_ID: advId })
);
// row.photo256 is now a Buffer
```

HANA stores `LargeBinary` as a native BLOB and is unaffected.
