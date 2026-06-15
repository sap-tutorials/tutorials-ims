# IMS Prod → DEV Cutover Rehearsal — Sitting 2 Findings

**Date:** 2026-06-15
**Operator:** Thomas Jung
**Status:** Halted at Step 7 (dry-run) — 4 cutover-blocking issues surfaced; nothing was wiped on DEV

## Outcome

The rehearsal pre-flight (Steps 1-7 dry-run) caught **four real cutover-blocking defects** before any wipe of `tutorials-hana`. This is exactly the spec's intended behavior — the dry-run did its job.

## Steps completed

| Step | Status | Notes |
|---|---|---|
| 1. cf target verify | ✓ | tutorial-system / dev confirmed |
| 2. DEV preflight snapshot | ✓ | 16 entity row-counts captured to `preflight-rowcounts.json` |
| 3. CONTENT_API_KEY check | ✓ | Set on tutorials-srv |
| 4. Non-action note | ✓ | Documented |
| 5. IMS prod source-creds | ✓ | But: NOT the HDI service-key — the actual tables live in `IMSDBUSER` schema, accessed via `cf env imsprod` → `DB_URL`/`DB_USERNAME`/`DB_PASSWORD` (memory `reference_hana_migration_creds.md` was correct) |
| 6. Migrator --discover | ✓ | After credential correction; 41 IMS source tables visible |
| 7. Migrator --dry-run | **FAIL** | Surfaced 4 issues. Halted before Step 8. |

Steps 8-13 not attempted.

## Issues surfaced (all filed as GitHub issues)

### #330 — Drop UserMetaData entity from migrator

The CAP `UserMetaData` entity models a key/value store. The IMS source `IMS_USER_META_DATA` is a visitor-ID tracking table — completely different schema. The CDS entity is a v2 design that IMS never used; nothing to migrate. Drop the migration block entirely.

### #331 — AccomplishmentRecords source column is `DATE`, not `AWARDED_AT`

One-line column-name fix in mapRow.

### #332 — Migrator OOMs on TaskRecords at IMS prod scale

`scripts/migrate-from-hana.js` accumulates the entire result set into a JS array per entity. With 786,445 users and likely 10M+ TaskRecords, Node's 4 GB heap overflows. Three fix options proposed in the issue: increase heap, paginate by ID range on TaskRecords specifically, or full streaming refactor.

This is the highest-severity issue. Cheap workaround (option 1: `--max-old-space-size=12288`) plus per-entity pagination on TaskRecords (option 3) is the recommended Sitting 2.5 path.

### #333 — Mission-to-group join returns 0 rows

The migrator's `missionGroupMap` query joins `IMS_TASK_TO_PARENT` filtering CHILD=MISSION + PARENT=GROUP, but found zero links. Hypothesis: hierarchy direction is inverted in IMS — groups may be children of missions, not parents. Probe and fix before next dry-run.

### #334 — Source-table name fix (likely superseded by #330)

`IMS_USER_METADATA` (migrator) vs actual `IMS_USER_META_DATA` (source). Superseded if #330 is implemented.

## What we proved positive

- ✅ HANA Cloud allow-list works after adding the laptop IP (spec Risk #2 firing — caught and resolved)
- ✅ Real source credentials path: `cf env imsprod` → `DB_URL`/`DB_USERNAME`/`DB_PASSWORD`, schema `IMSDBUSER`
- ✅ Reference-data migrations (tags, events, groups, missions, tutorials, steps) all flow cleanly in dry-run
- ✅ Users entity (786,445 rows) loads and maps successfully
- ✅ Orchestrator's Steps 1-4 work end-to-end as designed
- ✅ Verifier's `--target-only` mode works for the preflight DEV snapshot
- ✅ DEV's pre-rehearsal state captured for recovery

## Real source-data scale

Bigger than the spec assumed:

| Entity | Source rows |
|---|---|
| Tags | 10,523 |
| Events | 33 |
| Groups | 359 |
| Missions | 888 |
| Tutorials | 2,862 |
| Steps | 16,552 |
| **Users** | **786,445** |
| CompletionPaths | 411 |
| Prizes | 16 |
| Accomplishments | 10 |

(Spec-day estimate was ~47k users; actual is 786k.)

## Schema gaps documented during probing

`scripts/migrate-from-hana.js` and `scripts/verify-migration-rowcounts.cjs` reference table/column names that don't match the actual IMS source for several entities. Confirmed actual columns via SYS.TABLE_COLUMNS:

```
-- IMS_USER_META_DATA: USER_ID, VISITOR_ID, CREATED_BY, UPDATED_BY, CREATED_AT, UPDATED_AT
-- IMS_ACCOMPLISHMENT: ID, NAME, RULE, DESCRIPTION, CREATED_BY, UPDATED_BY, CREATED_AT, UPDATED_AT
-- IMS_ACCOMPLISHMENT_RECORD: ID, USER_ID, ACCOMPLISHMENT_ID, DATE, PROGRESS, SUBMISSION_ID
-- IMS_PRIZE_RECORD: ID, PRIZE_ID, USER_ID, COMPLETION_PATH_ITEM_ID, EVENT_ID, STATUS, CREATED_BY, UPDATED_BY, CREATED_AT, UPDATED_AT
-- IMS_TAG_TO_TASK: TAG_ID, TASK_ID, CREATED_BY, UPDATED_BY, CREATED_AT, UPDATED_AT
```

`IMS_PRIZE_RECORD.COMPLETION_PATH_ITEM_ID` exists; we currently NULL it in the migrator. If we later want to populate this FK, the lookup map for CompletionPathItems needs to be added.

## DEV state

**No data was wiped.** DEV's `tutorials-hana` is in the same state it was at the start of Sitting 2:

- 3 users, 36 taskrecords, 0 prize/accomplishment records
- 1397 tutorials, 233 missions, 706 completion paths (the seed data from `setup-dev-data.cjs`)
- See `preflight-rowcounts.json` for the full snapshot

`tutorials-srv` is still running normally; XSUAA, scheduler, content-serve all unaffected.

## Operational follow-up

- **Remove laptop IP from HANA Cloud allow-list** when done — was added during Step 6 troubleshooting. Public IP `173.243.182.44`.
- **Source-creds in artifact dir** (`.migration-data/cutover-2026-06-15T16-59-47-874Z/source-creds.json`, `imsprod-env.txt`) contain the IMSDBUSER password and are gitignored. Delete locally when done.

## Sitting 2.5 plan

1. Land issue fixes in PRs against main:
   - #330: drop UserMetaData migration block
   - #331: AccomplishmentRecords AWARDED_AT → DATE
   - #332: TaskRecords memory fix (option 1+3 from the issue)
   - #333: investigate + fix mission-to-group join direction
2. Re-run cutover rehearsal end-to-end after fixes merge
3. Continue with Steps 8-13 (wipe + migrate + verify + smoke + content rebuild)

Estimated Sitting 2.5 time: ~2 hours preparation + ~1.5 hours rehearsal day.

## Artifact pack contents

```
.migration-data/cutover-2026-06-15T16-59-47-874Z/
├── 01-cf-target.log
├── 02-preflight-rowcounts.log
├── 03-cf-env.log
├── 04-non-action-note.log
├── 06-discover.log                 ← initial probe (allow-list rejection)
├── 06-discover-imsdbuser.log       ← successful probe with IMSDBUSER creds
├── 07-dry-run.log                  ← 4 issues surfaced here
├── imsprod-env.txt                 ← IMS prod app env (gitignored, contains password)
├── preflight/                      ← intermediate snapshot dir
├── preflight-rowcounts.json        ← DEV state pre-rehearsal (recovery anchor)
├── source-creds.json               ← gitignored, contains password
└── target-creds.json               ← gitignored, contains password
```

(All inside `.migration-data/` which is gitignored. Only this findings doc lands in the repo.)
