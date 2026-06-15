# IMS Prod → tutorials-poc DEV Cutover Rehearsal — Design

**Date:** 2026-06-15
**Author:** Thomas Jung (decisions) + Claude (design capture)
**Status:** Draft, awaiting spec review

## Context

The Java-era IMS application (Spring Boot, deployed to the `Developer Destination_IMS` BTP subaccount in region `us30` / GCP) is the current production system of record for tutorial completion activity at developers.sap.com. The tutorials-poc CAP rewrite (deployed to `tutorial-system` / DEV in `eu10` / AWS) is the target replacement system. Cutover is approaching.

This design captures the plan for a **production cutover rehearsal**: a dry-run of the full data conversion path from IMS prod into the tutorials-poc DEV environment, exercised end-to-end so we can both prove the conversion works and use the resulting populated DEV environment as a realistic testing surface ahead of go-live.

The rehearsal is not a partial test or a sample — it is the same migration we plan to run on cutover day, against the same code path, just landing in DEV instead of a future tutorials-poc PROD container.

## Goals

1. **Validate the full cutover conversion path** end-to-end: source connection, schema fidelity, entity coverage, FK ordering, slug join integrity, prize claim continuity.
2. **Produce a populated DEV environment** that is realistic enough to be the best testing area available, including real user histories, real prize claim records, and real completion activity.
3. **Surface failure modes early** — missing entities, bad mappings, schema drift, cross-region connectivity gaps — so cutover day is not the first time we see them.
4. **Produce a forensic artifact pack** in `.migration-data/cutover-<timestamp>/` that demonstrates the conversion worked and documents residual issues.

## Non-goals

- This is **not** a production cutover. tutorials-poc PROD does not exist yet.
- This is **not** a PII anonymization exercise. Real names, emails, and S-user IDs are intentionally carried over verbatim.
- This is **not** a load test or performance benchmark. Cross-region throughput is incidental, not measured.
- This is **not** a schema migration. The CAP schema is fixed; we land IMS data into the existing CAP schema as it stands.
- This is **not** a QA-channel exercise. `tutorials-hana-qa` is untouched.

## Decisions (resolved during brainstorming)

| # | Question | Decision |
|---|---|---|
| 1 | Migration channel | **Direct HDI → HDI** via existing `scripts/migrate-from-hana.js`, using the `hdb` Node.js client over TLS |
| 2 | DEV pre-state | **Wipe `tutorials-hana` first** (per-table DELETE inside the migrator, not a separate step) |
| 3 | Entity scope | **Full set** — all entities IMS prod populates, including Users, TaskRecords, prize claims, accomplishments |
| 4 | PII handling | **Verbatim** — real names, emails, sUserIds copied across to maximize cutover-rehearsal fidelity |
| 5 | Verification depth | **Three tiers** — row counts (scripted), endpoint parity (scripted), functional smoke (manual, ~30 min) |
| 6 | Migrator coverage gap | **Extend** the migrator with two new entities (`AccomplishmentRecords`, `PrizeRecords`) plus the `Accomplishments` catalog. UserMetaData was originally in this list but the IMS source schema turned out to be unrelated to the CAP entity — dropped (issue #330). |
| 7 | Smoke identity | **Thomas Jung's real account** — logs in via SAP IDP, sees own migrated history |
| 8 | Rollback | **Wipe + re-run** — no separate restore path; the migrator's per-table DELETE-then-INSERT is correctness-equivalent to a fresh start |
| 9 | Row-count tolerance | **Zero** on reference tables (missions, groups, tutorials, tags, prizes); **±2** on activity tables (TaskRecords, etc.) to absorb live-write skew during the read window |
| 10 | Tutorial HTML rehydration | Run `rebuild-content.yml` GitHub workflow after migration to re-publish the 1398-slug `ContentFiles` BLOB store that the wipe blew away |
| 11 | `tutorials-srv` during migration | **Keep running** — accept background job noise as part of the rehearsal; do not `cf stop` |
| 12 | Tier B `/api/users` sample selection | **Deterministic** — Thomas Jung + 9 fixed sUserIds, list committed to `parity-allowlist.json` for reproducibility across re-runs |

## Architecture

### Data flow

```text
IMS PROD (Developer Destination_IMS / DEV space, us30 / GCP)
  └─ HDI container (legacy Java IMS schema)
       │  hdb Node client over TLS (port 443)
       │  cf service-key → HDI hdi_user/hdi_password
       ▼
   migrate-from-hana.js (extended: 12 → 15 entities)
       │  read source schema directly with raw SELECT
       │  per-entity: DELETE target → INSERT source rows in batches of 1000
       ▼
tutorials-hana (tutorial-system / dev, eu10 / AWS)
  └─ HDI container, owned by tutorials-db-deployer
       │
       ▼
   verification pipeline
       │  Tier A: scripts/verify-migration-rowcounts.cjs
       │  Tier B: scripts/compare-systems.js  (existing)
       │  Tier C: manual smoke checklist
       │
       ▼
   content rebuild
       gh workflow run rebuild-content.yml
       (re-publishes 1398 tutorial HTML BLOBs to ContentFiles)
```

### Cross-region mechanics

- IMS prod is in `us30` (GCP). DEV is in `eu10` (AWS). Round-trip latency from a developer laptop to either is ~150 ms via TLS to the HANA endpoint.
- With 1000-row INSERT batches, the migration is round-trip-bound, not bandwidth-bound.
- Expected total runtime: **~15-30 minutes**, dominated by `TaskRecords` (~900k rows estimated).

### Privilege model

- Migration runs from a developer laptop (Thomas Jung's machine) with two `cf service-key` outputs:
  - **Source:** `cf service-key` against the IMS prod HDI container in the `Developer Destination_IMS` org. Requires switching `cf target` to that org temporarily.
  - **Target:** `cf service-key` against `tutorials-hana` in `tutorial-system / dev`.
- No app pushes, no `mbt build`, no `cf deploy`, no schema redeploys happen during migration.
- The `tutorials-srv` and `tutorials-dev-approuter` apps remain running throughout. There is a brief window in which `tutorials-srv` serves a partially-wiped DB; since DEV is XSUAA-protected and not user-facing, this is acceptable.

## Components

### Migrator extension — `scripts/migrate-from-hana.js`

Two new entity definitions appended to the existing migration array, in FK-correct order. The pattern follows the existing 12 entries (`name`, `sourceQuery`, `targetTable`, `mapRow`, optional `preInsert`).

1. **`accomplishmentrecords`** — placed after both `users` and `accomplishments`.
   - Source: user-earned badge junction rows. Source column for the awarded timestamp is `DATE` (not `AWARDED_AT`) — caught during the 2026-06-15 dry-run, issue #331.
   - Target: `COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTRECORDS`.
   - mapRow: FK-resolve `user_id` and `accomplishment_id` to the migrated rows' UUIDs.

2. **`prizerecords`** — placed after `users`, `prizes`, and `events`.
   - Source: prize claim junction rows including `claimed`, `claimedAt`, `claimedBy`.
   - Target: `COM_SAP_DEVELOPERS_IMS_PRIZERECORDS`.
   - mapRow: FK-resolve `user_id`, `prize_id`, `event_id`. Carry `claimed` flags verbatim (per Q3 follow-up).

Plus the missing `accomplishments` catalog migration (the existing migrator pre-built `uuidMap.accomplishments` but never inserted into `COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTS`); see the dry-run findings doc for details.

**Originally planned but DROPPED (issue #330):** `usermetadata`. The IMS source `IMS_USER_META_DATA` is a visitor-ID tracking table with completely different columns (USER_ID, VISITOR_ID, CREATED_BY/UPDATED_BY/CREATED_AT/UPDATED_AT — no ID, KEY, or VALUE), unrelated to the CAP `UserMetaData` entity's key/value model. The CDS entity is a v2 design IMS never used.

A new `--list-entities` CLI flag prints the migration order so we can audit it before the real run, separate from `--discover` (which lists source schema tables).

The existing 12 entities and their mapRow logic are not modified.

### Pre-flight runner — `scripts/cutover-rehearsal.cjs`

Single orchestration entry point so the rehearsal-day sequence is repeatable and auditable. Windows-portable (`.cjs`).

```text
1. Verify cf target = tutorial-system / dev. Refuse to run otherwise.
2. Snapshot current DEV row counts → preflight-rowcounts.json
   (per memory feedback_hdi_deploys_can_wipe_data: snapshot first)
3. Preflight env check: confirm CONTENT_API_KEY is still set on
   tutorials-srv via `cf env tutorials-srv | grep CONTENT_API_KEY`.
   Refuse to proceed if missing — content rebuild (step 11) will fail.
4. Document non-action: tutorials-srv is left running throughout. Job
   scheduler noise (cleanup, ngds-retry, account-merge) is accepted as
   part of the rehearsal. Do NOT cf stop tutorials-srv.
5. Prompt for IMS prod org switch; fetch IMS service-key into source-creds.json
6. node scripts/migrate-from-hana.js --discover    (connectivity probe)
7. node scripts/migrate-from-hana.js --dry-run     (mapRow sanity check)
8. Confirmation prompt: type WIPE to overwrite DEV
9. node scripts/migrate-from-hana.js               (the real run)
10. node scripts/verify-migration-rowcounts.cjs    (Tier A)
11. node scripts/compare-systems.js                (Tier B)
12. Print Tier C smoke checklist with URLs
13. Prompt: trigger content rebuild now? (gh workflow run)
```

Every step writes to `.migration-data/cutover-<ISO-timestamp>/`. The runner is recoverable: a failed step leaves a forensic trail; subsequent steps refuse to start until the failure is acknowledged.

### Verifier — `scripts/verify-migration-rowcounts.cjs`

New script. Connects to both HDI containers using the same credential resolution as the migrator. Runs `SELECT COUNT(*) FROM "<schema>"."<table>"` for each of the 15 entities on both sides. Emits a side-by-side report:

```text
entity                  IMS_PROD    DEV       diff   status
tutorials                  1398    1398          0   ✓
missions                     87      87          0   ✓
groups                       66      66          0   ✓
users                     47213   47213          0   ✓
taskrecords              892341  892340         -1   ✓ (within tolerance)
prizerecords               8421    8421          0   ✓
accomplishmentrecords     31204   31204          0   ✓
...
```

Tolerance:
- **Reference tables** (tutorials, missions, groups, tags, events, prizes, completionpaths, completionpathitems, tutorialtags, accomplishments, steps): **zero diff** required.
- **Activity tables** (users, taskrecords, prizerecords, accomplishmentrecords): **±2 diff** tolerated to absorb live writes on IMS prod during the read window.

Exit code 0 on all-pass; exit code 1 on any out-of-tolerance diff. The runner halts on non-zero exit.

### Endpoint parity — `scripts/compare-systems.js` (existing, no changes)

Run with `IMS_BASE_URL=https://imsprod-approuter.cfapps.us30.hana.ondemand.com` and `CAP_BASE_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com`. Output saved to `parity.json` in the rehearsal artifact folder.

Endpoints diffed:
- `/api/missions` — full collection
- `/api/groups` — full collection
- `/api/tutorials` — full collection (sampled if response is too large)
- `/api/events` — full collection
- `/build/catalog` — composite catalog
- `/api/users/<sUserId>` — **deterministic sample** of 10 sUserIds (Thomas Jung + 9 fixed others) committed to `parity-allowlist.json` so re-runs are reproducible.

Field-level whitelist: timestamps may differ in serialization format (e.g. trailing `Z` vs explicit offset). Anything else is a finding.

CAP-era fields not in IMS (e.g. `displayTagSlugs`, AI-quiz-related fields, branch decision fields) are pre-recorded in `.migration-data/cutover-<ts>/parity-allowlist.json` so they are not flagged as unexpected.

### Functional smoke — manual checklist

Tier C is a 14-item walkthrough Thomas drives in a browser, while the migration operator watches `cf logs tutorials-srv` and `cf logs tutorials-dev-approuter` for errors:

```text
[ ] 1. Open https://tutorial-system-dev-tutorials-approuter…/me/
       Log in via SAP IDP.
       Name, avatar, progress count visible.
[ ] 2. /me/ Recent Activity timeline shows ≥3 prior completions.
       Slugs match real history (cross-check vs IMS prod /me/).
[ ] 3. /me/ accomplishments strip renders earned badges.
[ ] 4. /me/ prize-claim history visible if claimed any.
[ ] 5. /browse/ — homepage loads, mission tiles render with NEW badges,
       license icons, category facet.
[ ] 6. Open one mission tile, completion ring shows progress.
[ ] 7. Click into one previously-completed tutorial → green check on
       completed steps, "Continue" lands on the right step.
[ ] 8. Click into one not-yet-completed tutorial, complete one step,
       reload → step persists (TaskRecord write succeeded).
[ ] 9. /admin-ui/#missions-display — Fiori list shows ~87 missions.
[ ] 10. /admin-ui/#users-display — Fiori list shows ~47k users (paged).
[ ] 11. /scanner-ui/ — scan a known account number, prize stats render.
[ ] 12. /admin/analytics — run one canned query, ≥1 row returned.
[ ] 13. cf logs tutorials-dev-approuter --recent — no 5xx, no auth loop.
[ ] 14. cf logs tutorials-srv --recent — no LOB-locator-expiry, no FK
        violations from background jobs.
```

Items 1-12 are user-visible. Items 13-14 are operational. Anything that fails is recorded in `findings.md` within the rehearsal artifact folder.

Item 8 deliberately writes a TaskRecord into DEV. This is acceptable — DEV diverges from prod from that moment on, by design, since DEV is the test surface from this rehearsal forward.

### Impersonation mechanism

No impersonation hack required. XSUAA in `tutorial-system / dev` is bound to the same SAP IDP that IMS prod uses. When Thomas logs into DEV with his SAP credentials, the JWT carries his real `sub` / email / sUserId. The CAP user-resolver matches the JWT to the migrated Users row keyed by those same identifiers, and `/me/` renders his prod history.

The only prerequisite is that DEV's role collection includes Thomas, which it already does.

### Post-migration content rebuild

After verification passes, trigger the GitHub workflow:

```bash
gh workflow run rebuild-content.yml
```

This re-fetches all tutorial markdown from the `sap-tutorials` org, rebuilds Hugo, and publishes the 1398-slug HTML output to `ContentFiles` BLOBs via `POST /content/publish`. Runs in CI (~5-10 min). Without it, every `/tutorials/*` URL on DEV returns 404.

This step is sequenced after migration because the publisher writes `tutorialsTableInfo` keyed on `Tutorials.slug`, and that table needs to exist with prod's slug values first.

### What is NOT changing

- No CDS schema changes. `cds build` is not re-run.
- No `mbt build`, no `cf deploy`. `tutorials-srv` and `tutorials-db-deployer` are not pushed.
- `tutorials-hana-qa` and `tutorials-srv-qa` are untouched. QA continues to serve content-only data from `*-Contribution` repos.
- No anonymization. Real PII lives in DEV until either a future anonymization run or the next rehearsal wipe.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| IMS prod creds expire / not obtainable mid-run | Low | Blocker | Pre-flight step 3 fetches creds first and caches; aborts before touching DEV if `cf service-key` fails |
| us30 ↔ eu10 TLS handshake fails from laptop (corp VPN, firewall) | Med | Blocker | `--discover` mode is step 4 and acts as a connectivity probe; failure surfaces before wipe |
| TaskRecord write skew (rows added on prod during read window) | Med | Low | ±2 tolerance on activity tables; if exceeded, re-run with source quiesced or document |
| FK violation on insert (e.g. orphaned TaskRecord whose User wasn't migrated) | Low | Per-row | Migrator already does row-by-row fallback on batch failure (line 184-192); orphan rows error out and are counted in `errors` |
| HANA disk pressure on tutorials-hana from bulk insert | Low | Service degradation | DEV HANA has spare capacity; ~900k TaskRecords ≈ 200-400 MB. Watch `cf logs tutorials-srv` for OOM/GC during run |
| Schema drift between IMS and CAP breaks `mapRow` for a new entity | Med | Per-entity | Existing 12 entities are hardened; the 2 new ones (AccomplishmentRecords, PrizeRecords) plus the Accomplishments catalog were validated in the 2026-06-15 dry-run after issue #331 fix. UserMetaData was originally in scope but dropped (issue #330 — IMS source schema unrelated to CAP entity). |
| Real PII in DEV persists beyond rehearsal | Med | Compliance | Documented as known state. Either run anonymization cascade post-test or wipe DEV when next rehearsal starts. Tracked, not part of this test plan. |
| `tutorials-srv` serves a half-migrated DB during the run | Cert | Low | DEV is non-public, role-collection scoped. Acceptable. |
| Job scheduler fires mid-migration (cleanup, ngds-retry, account-merge) | Low | Per-job | Worst case: cleanup sees no SUPERSEDED content (wipe just emptied it), no-op. Monitor logs; `cf stop tutorials-srv` for the duration if a job becomes problematic |

## Rollback procedure

Per Tom's decision: **wipe + re-run.** No separate restore path.

```text
1. Don't touch DEV further. Capture current state to
   .migration-data/cutover-<ts>/failure-snapshot.json (row counts).
2. Document the failure in findings.md.
3. Decide: fix in migrator, then re-run from step 4 of the runner.
   The migrator's per-table DELETE-then-INSERT means a re-run is
   correctness-equivalent to a fresh wipe.
4. If migrator changes were needed, commit them so cutover day inherits
   the fix.
```

There is no rollback for `tutorials-hana-qa` (untouched), `tutorials-srv` (never pushed), or IMS prod (read-only access; cannot be damaged).

## Sequencing

Two sittings:

### Sitting 1 — preparation (offline, ~2 hr work + PR review cycle)

| Phase | Duration | Deliverable |
|---|---|---|
| Extend migrator with 3 entities | ~1 hr | `scripts/migrate-from-hana.js` commit |
| Write `cutover-rehearsal.cjs` runner | ~30 min | New script |
| Write `verify-migration-rowcounts.cjs` | ~20 min | New script |
| Dry-run against IMS prod with `--discover` | ~10 min | Confirms creds + entity shape |
| PR up for review | ~1 day cycle | Merged to main before sitting 2 |

### Sitting 2 — rehearsal day (~1.5 hr active)

| Phase | Duration | Active operator |
|---|---|---|
| Preflight: target, snapshot, creds, dry-run | ~10 min | Tom + Claude |
| Wipe + migrate (mostly waiting on TaskRecords) | ~15-30 min | Claude drives, Tom watches |
| Tier A row-count verify | ~30 sec | Scripted |
| Tier B endpoint parity | ~5 min | Scripted |
| Tier C functional smoke (14 items) | ~30 min | Tom drives, Claude observes logs |
| Content rebuild via GitHub Actions | ~5-10 min | Scripted |
| Wrap: compile findings, commit artifacts | ~15 min | Claude |

Sitting 1.5 (ad-hoc) only if dry-run reveals a problem code review missed.

## Deliverable: rehearsal artifact pack

```text
.migration-data/cutover-2026-06-15-1430/
├── preflight-rowcounts.json     ← DEV state before wipe
├── source-discover.txt          ← discovered IMS source schema
├── postflight-rowcounts.json    ← DEV state after migration
├── tier-a-rowcount-diff.json    ← side-by-side counts (Tier A)
├── parity.json                  ← compare-systems output (Tier B)
├── parity-allowlist.json        ← known/expected diffs
├── smoke-checklist.md           ← Tier C results, hand-marked
└── findings.md                  ← anything that didn't pass
```

The folder is the cutover-day artifact pack: it demonstrates the conversion works and surfaces the residual issues to fix before the real cutover.

## Success criteria — recap

The rehearsal is "green" if and only if all four hold:

1. **Bulk fidelity** — Tier A row counts match within tolerance.
2. **Field fidelity** — Tier B endpoint parity reports zero unallowlisted diffs on a sample including Thomas's user record.
3. **Endpoint parity** — `compare-systems.js` succeeds.
4. **Functional smoke** — All 14 Tier C items pass.

Anything less and we wipe + re-run. The rehearsal output is "ready for cutover" only if all four hold.

## Open questions

None. All design questions resolved during brainstorming.

## Appendix: glossary

- **IMS** — Innovative Mission System, the legacy Spring Boot Java application currently serving developers.sap.com tutorial state.
- **HDI container** — HANA Deployment Infrastructure container; the SAP-managed schema-isolation primitive on HANA Cloud.
- **CAP** — Cloud Application Programming model; the Node.js framework `tutorials-srv` is built on.
- **CompletionPaths** — CAP-era name for what IMS calls "Groups" (a tutorial sequence within a Mission).
- **Tier A/B/C** — verification rigor tiers. A = row counts, B = endpoint diff, C = manual functional smoke.
