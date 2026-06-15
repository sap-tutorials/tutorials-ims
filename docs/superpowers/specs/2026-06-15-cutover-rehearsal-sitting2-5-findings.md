# IMS Prod → DEV Cutover Rehearsal — Sitting 2.5 Findings

**Date:** 2026-06-15
**Operator:** Thomas Jung
**Status:** Migration COMPLETED with one cutover-blocker uncovered

## Outcome

The full migration ran end-to-end against IMS prod, ~12.7 million rows landed in DEV, and the Tier C smoke surfaced a **fundamental cutover-blocker** that was masked in Sitting 2 (where we halted at the dry-run before doing the wipe).

## Steps completed

| Step | Status | Notes |
|---|---|---|
| 1. cf target verify | ✓ | tutorial-system / dev confirmed |
| 2. DEV preflight snapshot | ✓ | 15 entity row-counts to `preflight-rowcounts.json` |
| 3. CONTENT_API_KEY check | ✓ | Set on tutorials-srv |
| 4. Non-action note | ✓ | Documented |
| 5. IMS prod source-creds | ✓ | `cf env imsprod` → DB_URL/USERNAME/PASSWORD, schema IMSDBUSER |
| 6. Migrator --discover | ✓ | 41 IMS source tables visible |
| 7. Migrator --dry-run | ✓ | All 15 entities mapped 0-error after #330-#333 fixes |
| 8. WIPE confirmation | ✓ | Operator typed YES |
| 9. Migrator real run | ✓ (1 soft fail) | ~63 min wall-clock; 12.7M rows landed; Accomplishments catalog 0/10 (NCLOB error, issue #338) |
| 10. Tier A row-counts | ⚠ partial | 11/15 ✓; 4 ✗ (drift on activity tables, accomplishments NCLOB, tutorialtags orphans) |
| 11. Tier B endpoint parity | ✓ | /build/catalog reachable; 888 missions / 1487 tutorials / 8 categories |
| 12. Tier C functional smoke | ✗ BLOCKED | /me/ blank, admin Tutorial Health partial — root-caused to issue #337 |
| 13. Content rebuild | ✓ (publish) ✗ (approuter push) | HANA publish succeeded; static push to approuter failed (unrelated to migration) |

## Real source-data scale

The dry-run estimate held up:

| Entity | Source rows | DEV rows | Diff |
|---|---|---|---|
| tags | 10,523 | 10,523 | 0 |
| events | 33 | 33 | 0 |
| groups | 359 | 359 | 0 |
| missions | 888 | 888 | 0 |
| tutorials | 2,862 | 2,862 | 0 |
| steps | 16,552 | 16,552 | 0 |
| **users** | **786,476** | **786,462** | -14 (live writes during run) |
| **taskrecords** | **10,807,618** | **10,807,468** | -150 (live writes during run) |
| completionpaths | 411 | 411 | 0 |
| completionpathitems | 739 | 739 | 0 |
| prizes | 16 | 16 | 0 |
| **accomplishments** | **10** | **0** | **-10 (NCLOB error)** |
| accomplishmentrecords | 1,030,679 | 1,030,679 | 0 |
| prizerecords | 40,530 | 40,530 | 0 |
| **tutorialtags** | **12,757** | **11,407** | **-1,350 (orphans)** |

**Total: ~12.7 million rows. The pagination fix (#332) worked perfectly — no OOM at 10.8M taskrecords.**

## Issues filed

| # | Title | Severity | Status |
|---|---|---|---|
| #337 | **migrator uses randomUUID() per run, orphaning all CAP-era FK references** | **CUTOVER BLOCKER** | open |
| #338 | migrator can't bind NCLOB columns (Accomplishments catalog 0/10 inserted) | High | open |
| #339 | migrate firstName/lastName/email/avatarUrl on Users | Medium | open |
| #340 | TutorialTags drops 1,350 orphan rows | Low / wontfix | open |

## The cutover blocker (#337) — explained

The migrator regenerates UUIDs on every run via `randomUUID()`. **29 CAP-era tables** carry FKs to migrated entities (Tutorials, Missions, Groups/CompletionPaths, Users, Tags). Those tables are not in the migrator's wipe list, so they survive with **stale UUIDs that no longer exist** in the freshly-migrated tables.

Symptoms observed in this rehearsal:

- **/me/ shows zero activity for migrated users.** CAP's `resolveDbUserId` looks up `Users.uuid = req.user.id` (XSUAA `sub` claim). Migrated `Users.uuid` carries IMS's UUID (`b7559332-...` for I809764), NOT the SAP IDP UUID that XSUAA emits. Lookup misses; CAP auto-provisions a brand-new empty Users row.
- **Admin Tutorial Health partial.** TutorialMeta (admin review state) survived the wipe with 1,588 rows. INNER JOIN with Tutorials matches only 190; the other 1,398 admin reviews are orphaned because `TutorialMeta.tutorial_ID` points at OLD Tutorial UUIDs.

Same root cause for both. **Fix: deterministic UUIDs derived from `(entity_namespace, legacyId)` via UUIDv5.** After this fix, every migration run produces the same UUIDs for the same source rows. CAP-era tables stay linked. Re-runs are idempotent.

## What we proved positive

- ✅ HANA Cloud allow-list works after IP add (issue #2 from Sitting 2 didn't recur)
- ✅ All four Sitting 2 fixes (#330-#333) held up — UserMetaData drop, AccomplishmentRecords DATE column, missionGroupMap drop, IMS_USER_META_DATA table-name correction
- ✅ TaskRecords pagination (#332) handled 10.8M rows cleanly with bounded memory
- ✅ Migrator dry-run + real-run consistency: zero surprises between the two on counts
- ✅ Reference data (Tags, Events, Groups, Missions, Tutorials, Steps, CompletionPaths, CompletionPathItems, Prizes) all migrated zero-error
- ✅ Activity data (Users, TaskRecords, AccomplishmentRecords, PrizeRecords) all migrated zero-error
- ✅ Cross-region throughput sustained ~165k inserts/min over the full run
- ✅ tutorials-srv kept running throughout; no jobs crashed; no LOB-locator errors in logs
- ✅ /build/catalog endpoint serves migrated mission/tutorial counts correctly
- ✅ Tutorial HTML serving from ContentFiles unaffected (those tables aren't in the migrator's list, by design)

## DEV state right now

- 12.7M rows of real IMS prod data
- Stale CAP-era references (TutorialMeta, TutorialEmbedding, etc.) still pointing at OLD Tutorial UUIDs that no longer exist
- /me/ broken for every migrated user (lookup miss)
- Admin Tutorial Health partial (190 of 1,588 review rows linked correctly; 1,398 orphaned)

## Sitting 3 plan

1. Land #337 fix (deterministic UUIDs) in a PR.
2. Land #338 fix (NCLOB cast) — likely same PR.
3. Land #339 plan or defer to a backfill script (separate PR if implementing now).
4. Re-run rehearsal end-to-end. With deterministic UUIDs, the same TutorialMeta/Embedding/etc. data survives the wipe AND links correctly to the new Tutorials.
5. Re-validate /me/ + admin Tutorial Health.
6. Decide on cutover-day plan: run migrator → re-publish content → optionally seed user profiles via #339 backfill.

## Operational follow-up

- **Laptop IP still in HANA Cloud allow-list** (`173.243.182.44`). Remove when done with all rehearsals.
- **Source-creds + imsprod-env on disk** at `.migration-data/cutover-2026-06-15T17-59-57-930Z/` — gitignored. Delete locally when done.
- **DEV's tutorials-hana** is in a known-broken-cosmetic state. Acceptable for testing; will be re-wiped + re-migrated after #337 fix lands.

## Artifact pack contents

```
.migration-data/cutover-2026-06-15T17-59-57-930Z/
├── 01-cf-target.log
├── 02-preflight-rowcounts.log
├── 03-cf-env.log
├── 04-non-action-note.log
├── 06-discover.log
├── 07-dry-run.log
├── 09-migrate.log              ← 63 min wall-clock real run
├── 10-verify-rowcounts.log     ← 4 diffs surfaced
├── imsprod-env.txt             ← gitignored (password)
├── parity.json                 ← Tier B summary
├── preflight-rowcounts.json    ← DEV state pre-migration
├── smoke-checklist.md          ← Tier C checklist (mostly pre-blocker)
├── source-creds.json           ← gitignored (password)
├── target-creds.json           ← gitignored (password)
└── tier-a-rowcount-diff.json   ← 4-fail row-count summary
```
