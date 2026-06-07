---
title: HDI Data-Loss Incident — 2026-06-05
date: 2026-06-05
status: Resolved (Option E accepted)
severity: P0
environment: DEV
related: [#257, #263, #258, #259, #264, #266, #268]
---

# HDI Data-Loss Incident — 2026-06-05

## Summary

On 2026-06-05 a series of HDI deploy iterations on the `tutorials-hana` (DEV) container wiped relational catalog data — Missions, Groups, CompletionPaths, Events, TutorialTags, MissionTags, and Accomplishments — while sparing Tutorials, TutorialMeta, ContentFiles, Steps, Users, and TaskRecords. Production was unaffected. Detection was a user-report path, not automated; MTTR from wipe confirmation to substantive recovery was ~4 hours. Five preventive/recovery PRs landed within 24 hours (#258, #259, #264, #266, #268). The residual gap — 1356 of 1397 `TUTORIALS.LEGACYID` rows holding synthetic placeholder values — is accepted under Option E (the 3% IMS-reconciliation ceiling is a data-shape limit, not effort-limited).

## Impact

- **Affected environment:** DEV (`tutorials-hana` HDI container, EU10).
- **Production:** Unaffected.
- **User-visible symptoms:** `/browse/` showed "All 0 items"; navigator returned 0 missions. Tutorial pages still rendered (served from intact `ContentFiles` BLOBs and Hugo-baked `_nav.json`).
- **Data wiped:** `Missions` (0 from thousands), `Groups` (1 stub from thousands), `CompletionPaths` (0 from thousands), `TutorialTags` (0 from tens of thousands), `Events` (1 from 30+), plus `MissionTags` and `Accomplishments`.
- **Data intact:** `Tutorials` (1397), `TutorialMeta` (1398), `ContentFiles` (1398 BLOBs), `Steps`, `Users` (3 DEV-only test users), `TaskRecords` (36 DEV-only).
- **MTTR:** ~4 hours from wipe detection (≈22:25 UTC) to substantive recovery (`migrate-from-hana` + `setup-dev-data` + autotest cleanup + Hugo rebuild + redeploy).

## Timeline (UTC)

Reconstructed from git commit timestamps, PR merge timestamps, and the issue body itself. Where exact deploy times are not recoverable (CF retains only ~30 min of `cf logs --recent`), entries are marked with `~` and explained in the "Sources & precision" note at the end.

| Time (UTC) | Event | Source |
|---|---|---|
| 2026-06-05 03:03 | Commit `794367d` "feat(db): real .hdbindex DDL for UIEvent (closes #227)" | git |
| 2026-06-05 03:14 | Commit `ac7203d` "chore(db): commit auto-regenerated HDI migration tables (#204)" | git |
| 2026-06-05 21:13 | Commit `62d6619` "fix(db): revert UIEvent .hdbindex DDL; add hdbindex plugin to .hdiconfig" | git |
| 2026-06-05 21:27 | Commit `449acc2` "fix(db): reintroduce UIEvent indexes using @sql.append for compatibility" | git |
| 2026-06-05 21:33 | Commit `584e878` "fix(db): re-add UIEvent .hdbindex files with correct HDI syntax (closes #227)" | git |
| 2026-06-05 ~21:35 | Bad deploy (exact timestamp lost; deployer log aged out) | inferred |
| 2026-06-05 ~22:25 | Wipe confirmed via direct HANA query against `tutorials-hana` | issue body |
| 2026-06-05 22:29 | Issue [#257](https://github.com/sap-tutorials/tutorials-ims/issues/257) filed | gh API |
| 2026-06-05 ~22:30 | Recovery start: `migrate-from-hana` from cached IMS prod creds | issue body |
| 2026-06-05 ~22:50 | `setup-dev-data.cjs` assigns slugs + autotest cleanup | issue body |
| 2026-06-05 ~23:00 | Hand cleanup: 376 deleted MISSIONS rows, 21,175 deleted GROUPS rows | issue body |
| 2026-06-06 00:29 | PR [#258](https://github.com/sap-tutorials/tutorials-ims/pull/258) merged: HDI tripwire scripts shipped | gh API |
| 2026-06-06 00:57 | PR [#259](https://github.com/sap-tutorials/tutorials-ims/pull/259) merged: CI integration of guards | gh API |
| 2026-06-06 12:45 | Issue [#263](https://github.com/sap-tutorials/tutorials-ims/issues/263) filed (3% ceiling acknowledged) | gh API |
| 2026-06-06 19:26 | PR [#264](https://github.com/sap-tutorials/tutorials-ims/pull/264) merged: IMS slug-based reconciliation (41/1397) | gh API |
| 2026-06-06 19:35 | PR [#266](https://github.com/sap-tutorials/tutorials-ims/pull/266) merged: auto-comment HDI findings on PRs | gh API |
| 2026-06-06 20:33 | PR [#268](https://github.com/sap-tutorials/tutorials-ims/pull/268) merged: Cloud Logging retention | gh API |

**Sources & precision note:** Commit timestamps are local commit times (Eastern, UTC-4), converted to UTC. They reflect when the change was authored, not when `cf deploy` actually ran. The bad-deploy and recovery timestamps marked `~` are inferred from the surrounding evidence; the deployer log that would have given exact times had aged out before forensic capture. PR #268 specifically ships ~30-day Cloud Logging retention to close this gap going forward.

## Root Cause Analysis

Framed as a chain — necessary cause × sufficient cause:

**Necessary cause: HDI hash-mismatch TABLE_REPLACE behavior.**
When a `.hdbmigrationtable` migration version's content hash changes after deploy, HDI's recovery path can fall back to TABLE_REPLACE (drop + recreate) for affected tables. The `@sql.append` annotation in `db/schema-ext.cds` was iterated 4× across commits `62d6619`, `449acc2`, `584e878`, regenerating the migration table hashes between deploys. This is a property of HDI we can't change; we have to detect and survive it.

**Sufficient cause: absence of a row-count tripwire.**
Before 2026-06-05, no automated guardrail compared row counts before/after deploy. The "WARNING: deleted files not in undeploy.json" pattern was firing in deployer logs and being ignored. The wipe went undetected for hours until a user reported "All 0 items" on `/browse/`. This is the cause we *could* and *did* fix — PRs #258/#259/#266 wired in the guardrails after the fact.

### Five Whys (kept honest about confidence)

1. **Why did Missions get wiped?** HDI's recovery path treated the table as a re-creation candidate.
2. **Why did HDI choose re-creation?** *Suspected:* a migration version's content hash changed mid-day after a prior deploy had already recorded a different hash. **Confidence: medium.** Not directly confirmed because the deployer log aged out.
3. **Why did the migration version's hash change?** `@sql.append` content was iterated 4× in `db/schema-ext.cds` (commits `62d6619` → `449acc2` → `584e878`).
4. **Why was that allowed to deploy 4×?** No automated guardrail blocked iterative HDI deploys; the team's convention "validate locally first" was followed in good faith but local validation didn't surface the hash-change risk.
5. **Why did no guardrail exist?** The team had not previously hit this failure mode; it surfaced for the first time on 2026-06-05. **PR #258 / #259 added the guardrails after the fact — this is the load-bearing fix.**

### Unexplained asymmetry (open question)

Missions, Groups, CompletionPaths, Events, TutorialTags, MissionTags, and Accomplishments were wiped. Tutorials, TutorialMeta, ContentFiles, Steps, Users, and TaskRecords were intact. Two plausible hypotheses, **both unconfirmed**:

1. **Scoped TABLE_REPLACE.** HDI may have scoped the recovery to only those tables whose `.hdbmigrationtable` files were regenerated by the `@sql.append` chain.
2. **Partial container rebuild.** HDI may have run a partial rebuild that propagated to entities sharing `schema-ext.cds` dependencies but stopped at entities defined in older, unchanged `.hdbmigrationtable` files.

The deployer log that would have distinguished these aged out. PR #268's Cloud Logging retention (~30-day window) closes this forensic gap for any future incident.

## Recovery

Step-by-step record of what was done on 2026-06-05 evening + 2026-06-06:

1. `migrate-from-hana` from cached IMS prod creds in `.migration-data/ims-creds.json` — restored Missions, Groups, CompletionPaths, Tags, Events, Prizes (excluding Tutorials/Steps/Users/TaskRecords to avoid clobbering intact data).
2. `setup-dev-data.cjs` — assigned slugs from `.migration-data/slug-mapping.json`, deleted autotest_*-titled rows.
3. Hand cleanup of `STATUS = 'DELETED'` rows from MISSIONS (376) and GROUPS (21,175). (These were `STATUS = 'DELETED'` audit rows imported from IMS prod, not live data wiped on 2026-06-05; IMS retains soft-deleted rows indefinitely.)
4. Hugo rebuild + redeploy — refreshed the `/browse/` baked data file.
5. PR [#258](https://github.com/sap-tutorials/tutorials-ims/pull/258) — HDI tripwire scripts (`hana:rowcounts`, `hana:scrape-deployer-log`) + checklist doc.
6. PR [#259](https://github.com/sap-tutorials/tutorials-ims/pull/259) — CI integration of guards in `.github/workflows/deploy.yml`.
7. PR [#264](https://github.com/sap-tutorials/tutorials-ims/pull/264) — IMS slug-based reconciliation script (41/1397 = 3%; ceiling reached).
8. PR [#266](https://github.com/sap-tutorials/tutorials-ims/pull/266) — auto-comment HDI tripwire findings on the merge PR.
9. PR [#268](https://github.com/sap-tutorials/tutorials-ims/pull/268) — forensic log retention via Cloud Logging on db-deployers (~30-day window).

## What Went Well

- Recovery began within minutes of detection; cached IMS prod creds were available and the migrate-from-hana script worked end-to-end.
- The five prevention/recovery PRs landed inside 24 hours of the incident.
- Production was never affected; blast radius stayed in DEV.
- The team documented the residual gap honestly (issue #263) rather than claiming full recovery.

## What Went Poorly

- **No row-count tripwire** — the load-bearing process gap. Fixed in PR #258.
- **Deployer log aged out before forensic capture** — `cf logs --recent` is a 30-minute ring buffer. Fixed in PR #268.
- **`undeploy.json` was stale** — five `.hdbview` / `.hdbtable` warnings had been firing for weeks and were ignored. Cleaned up in PR #259.
- **Iterative HDI deploys (4× in one day)** were treated as a normal debugging cadence; each retry was an opportunity for the failure to compound. New convention documented in `hdi-deploy-checklist.md` rule 2.
- **MTTR was hours, not minutes** because detection was a user-report path, not an automated one.

## Action Items

| # | Action item | Status | Delivered by | Notes |
|---|---|---|---|---|
| 1 | Verify HANA Cloud PITR + retention on `tutorials-hana` | **Open** | — | Owned by BTP admin team; tracked outside GitHub |
| 2 | Pre/post-deploy row-count snapshots | Done | PR [#258](https://github.com/sap-tutorials/tutorials-ims/pull/258) | `npm run hana:rowcounts --snapshot/--diff` |
| 3 | Forbid mid-iteration deploys (convention) | Done | PR [#258](https://github.com/sap-tutorials/tutorials-ims/pull/258) | `docs/developers/operations/hdi-deploy-checklist.md` rule 2 |
| 4 | Surface TABLE_REPLACE / undeploy warnings from deployer log | Done | PR [#258](https://github.com/sap-tutorials/tutorials-ims/pull/258) | `npm run hana:scrape-deployer-log` |
| 5 | CI integration of guards | Done | PR [#259](https://github.com/sap-tutorials/tutorials-ims/pull/259) | `.github/workflows/deploy.yml` |
| 6 | Auto-comment HDI tripwire findings on merge PR | Done | PR [#266](https://github.com/sap-tutorials/tutorials-ims/pull/266) | Surfaces findings to reviewers |
| 7 | Forensic log retention (~30 days) | Done | PR [#268](https://github.com/sap-tutorials/tutorials-ims/pull/268) | `tutorials-cloud-logging` binding |
| 8 | Recovery: backfill TUTORIALS.LEGACYID from IMS | **Partial** (3%, 41/1397) | PR [#264](https://github.com/sap-tutorials/tutorials-ims/pull/264) | Ceiling reached; rest accepted under Option E |

## Residual Gap & Decision

**What's not recovered:**
1356 of 1397 DEV `TUTORIALS.LEGACYID` rows still hold synthetic placeholder values (20000–21396). `/build/navigator` reports `tutorialMappings: 21` instead of ~1397. Many `CompletionPathItems` rows have NULL `TUTORIAL_ID`. Visible to authenticated admins via the Navigator screen; not surfaced to end users (Hugo's `_nav.json` and per-tutorial frontmatter cover the public catalog).

**Why Option E (accept partial state) is acceptable:**

1. Blast radius is DEV-only; production data is intact.
2. The 3% ceiling reflects IMS data shape (96% of IMS task URLs are non-canonical autotest/personal-fork URLs); no amount of additional reconciliation script work can close it.
3. DEV's purpose is testing, not data fidelity. The 41 reconciled tutorials cover enough catalog paths for navigator/catalog smoke tests.
4. Option D (rebuild from canonical Hugo source) is ~3 days of work and requires a CDS schema change (NavigatorCatalog joining on slug not legacyId). No current use case justifies the investment.
5. Option A (PITR) remains a future possibility if/when BTP admin enables it, and would supersede any partial reconciliation anyway.

**Triggers to revisit (Option E becomes wrong if any of these become true):**

- A new feature requires accurate `tutorialMappings` on DEV (e.g., end-to-end navigator test asserting mapping count).
- BTP admin confirms PITR is available on `tutorials-hana` retroactively for 2026-06-05.
- A second HDI incident wipes a different DEV table set; recovery investment becomes amortizable.
- The team decides to harmonize DEV with PROD data and budgets the 3-day Option D effort.

## Lessons Learned

The single load-bearing insight from this incident:

> **HDI's data-preservation guarantees are weaker than the documentation implies when migration content is iterated mid-day. Row-count snapshots are the only way to detect this from outside the container.**

Secondary lessons:

- **`cf logs --recent` is not a forensic source.** A ~30-minute ring buffer is unsuitable for post-incident analysis; persistent log retention (Cloud Logging, ELK, etc.) is mandatory for production-data services.
- **Stale warnings compound.** The "deleted files not in undeploy.json" pattern was visible for weeks before it bit us. Treat warnings as future incidents.
- **Recovery posture beats prevention posture.** No prevention measure is perfect; recovery quality (cached creds, idempotent migration scripts, soft-delete-friendly schemas) determines MTTR when prevention fails.

## See Also

- Issue [#257](https://github.com/sap-tutorials/tutorials-ims/issues/257) — the data-loss event this postmortem responds to
- Issue [#263](https://github.com/sap-tutorials/tutorials-ims/issues/263) — recovery completeness tracker (closed under Option E with this postmortem)
- [HDI deploy checklist](../developers/operations/hdi-deploy-checklist.md) — the operational checklist born from this incident
- [`scripts/check-hana-rowcounts.cjs`](../../scripts/check-hana-rowcounts.cjs) — row-count snapshot/diff tool
- [`scripts/scrape-deployer-log.cjs`](../../scripts/scrape-deployer-log.cjs) — deployer log scraper
- [`scripts/migrate-from-hana.js`](../../scripts/migrate-from-hana.js) — IMS-prod-to-DEV recovery tool
- [`scripts/reconcile-tutorials-legacyid.cjs`](../../scripts/reconcile-tutorials-legacyid.cjs) — slug-based partial reconciliation (PR #264)
