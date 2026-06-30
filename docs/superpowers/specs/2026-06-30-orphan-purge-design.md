# Orphan-Purge Mode for `publish-content` — Design

**Status:** Proposed
**Date:** 2026-06-30
**Author:** Tom Jung (with Claude Code)
**Related:** PR #795 (drift-count grep fix); run [28422871998](https://github.com/sap-tutorials/tutorials-ims/actions/runs/28422871998) (drift report that surfaced the 24 ghosts); [docs/developers/operations/rebuild-content-workflow.md](../../developers/operations/rebuild-content-workflow.md)

## Terminology

- **Orphan** — a tutorial whose `ContentFiles` row exists in the ACTIVE manifest but whose source markdown is no longer present in any upstream repo. Detected as a slug in `serverSlugs` but not in `localSlugs` after a `full`-mode `fetch-tutorials`. This is what `--purge-orphans` acts on.
- **Phantom ContentFiles row** — a `ContentFiles` row whose `slug` has no matching `Tutorials` parent row. NOT an orphan in the sense above; landed via a publish-path bug or hand-SQL. Reported in `notFound[]` and requires investigation, not auto-cleanup.
- **Missing-locally** — the broader label used by the daily drift report; in `full`-mode it equals "orphan", in `slug-targeted`/`catalog-only` it's an artifact of partial fetch (which is exactly why `--purge-orphans` is `full`-mode-only).

## Problem

The daily [content-drift-check](../../../.github/workflows/content-drift-check.yml) workflow reports two signals from `scripts/publish-content.ts --verify-only`:

1. **Drifted slugs** — local hash ≠ server hash → fix with `--heal` or a rebuild.
2. **Missing-locally slugs** — server has hashes, local cache doesn't → no built-in cleanup path.

Run 28422871998 reported 24 missing-locally slugs at DEV. The full list breaks into:

- 3 slugs still in `discovery-baseline.json` whose source `.md` was deleted from the upstream repo (`btp-ea-onboard-04-subm`, `btp-ea-onboard-06-abapm`, `rbrainey-sandbox-1`).
- 21 slugs not in baseline at all — orphans from removed/renamed/private-without-allowlisted repos (`appgyver-*` × 5, `codejam-*` × 16).

These tutorials remain alive on HANA because [`carryForwardUnchanged`](../../../srv/lib/content-publish-session.js#L832) preserves every prior-version slug into every new manifest unless the publish payload explicitly replaces them. Soft-deleting one-by-one via the Tutorials Fiori app at `/admin-ui/#tutorials-display` works but doesn't scale to 24 (let alone the larger number that will accumulate over time).

We need a CI-only mode that batches the same soft-delete operation the admin app performs, driven by "the upstream repo no longer contains this slug."

## Non-Goals

- **Hard-delete of `Tutorials` rows or historic `ContentFiles` rows.** Soft-delete via `status = 'INACTIVE'` is the canonical pattern ([srv/admin-service.js:826-834](../../../srv/admin-service.js#L826-L834)); the existing content-GC cron handles physical cleanup on its own schedule.
- **Workstation-runnable purge.** The [Never run publish-content from workstation](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_never_run_publish_content_from_workstation.md) feedback already documents how a stale workstation cache can regress live content. This operation is strictly more destructive; CI-only is non-negotiable.
- **Scheduled (cron) purge.** A quarterly auto-purge masks fetch regressions — if `fetch-tutorials` silently drops a repo, a cron would happily soft-delete 50 tutorials before anyone notices. Manual dispatch forces a human to look at the count first. Can be added later if it ever becomes a recurring chore.
- **Cleanup of phantom `ContentFiles` rows that lack a matching `Tutorials` row.** Reported in the response's `notFound[]` array for visibility; physical cleanup is a separate concern handled by the existing GC cron once `status` is set.

## Architecture

Three changes, smallest-blast-radius first:

### 1. Server-side: filter INACTIVE from `/content/source-hashes`

[srv/lib/content-store.js](../../../srv/lib/content-store.js) — the `GET /content/source-hashes` handler around line 1091.

Today it returns `{ slug: sourceHash }` for every row in the ACTIVE manifest. Add a filter:

```js
// Exclude soft-deleted tutorials. The carry-forward path keeps INACTIVE
// rows in the manifest for snapshot consistency, but external consumers
// (drift workflow, --verify-only) should not see them — otherwise the
// daily drift report keeps re-reporting them as "missing locally" forever.
//
// See "Pre-deploy data check" below for the OR-NULL clause decision.
```

Implementation shape: the existing SELECT joins `ContentFiles` ⨯ `ContentManifest`. Add a LEFT JOIN to `Tutorials` on `LOWER(slug)` (since [Tutorial slugs are lowercase canonical](../../../CLAUDE.md) — joins must lower-case both sides) and a `WHERE status != 'INACTIVE'` clause.

> **Pre-deploy data check (HIGH from review round 1, issue #9):** before relying on `WHERE status != 'INACTIVE'`, the implementation plan must verify the answer to `SELECT COUNT(*) FROM Tutorials WHERE status IS NULL` against DEV and PROD. The `Tutorials.status` column is `TaskStatus` enum with `@assert.range` ([db/schema.cds:24](../../../db/schema.cds#L24)) — new rows can't be NULL — but pre-existing rows from before the column was added may be. Two outcomes:
>
> - **Count = 0** → no defensive `OR status IS NULL` clause needed; ship the plain `!= 'INACTIVE'` filter. This is the design's preferred branch.
> - **Count > 0** → one-shot DB migration script seeds the orphans to `'ACTIVE'` (`UPDATE Tutorials SET status='ACTIVE' WHERE status IS NULL`) before the filter ships, so the filter's semantics are unambiguous.
>
> Picking the branch is a plan-time decision, not a spec-time one. The serve handler already treats NULL as not-INACTIVE ([content-store.js:978](../../../srv/lib/content-store.js#L978)); the new filter must match that semantics on whichever data state lands in the DB.

**Companion benefit:** once a slug flips to INACTIVE via the new endpoint (or via the admin Fiori app), the drift workflow stops re-reporting it the next day — without this filter, the cleanup would be invisible and would keep generating noise.

### 2. New admin endpoint: `POST /admin/orphan-purge`

Routed through `AdminService` (not the bare-Express layer that hosts `/content/publish`) so it inherits:

- `@cap-js/audit-logging` `@PersonalData` annotations on `Tutorials` (existing).
- `@cap-js/change-tracking` row-level diff records on `Tutorials.status` (existing).
- XSUAA scope check (existing on every AdminService action).

**Request body:**

```json
{
  "slugs": ["appgyver-fetch-data", "codejam-0-prerequisites", "..."]
}
```

The `initiator` field is **not** in the body. Operator attribution is captured in a `PipelineLog` row (see "Initiator persistence" below) symmetric with how `/content/publish` records initiator. The `dryRun` flag from earlier drafts is removed — dry-run is handled client-side by `--dry-run`, which gates the POST call entirely. No untested server-side branch.

**Response body:**

```json
{
  "purged":          ["appgyver-fetch-data", "..."],
  "alreadyInactive": ["btp-ea-onboard-04-subm"],
  "notFound":        [],
  "redirected":      [],
  "totalAttempted":  24,
  "totalPurged":     21,
  "version":         218
}
```

**Per-slug behavior:**

| Condition | Bucket | Server action |
|---|---|---|
| Slug missing from `Tutorials` (phantom row — see Terminology) | `notFound[]` | None — **operator action required** (not auto-remediated). Indicates a publish-path bug or hand-SQL; file an issue. |
| `Tutorials.status` already `INACTIVE` | `alreadyInactive[]` | None (idempotent re-run) |
| `Tutorials.redirectTo` is set | `redirected[]` | None — admin set up redirect deliberately; honor intent |
| Otherwise | `purged[]` | `UPDATE Tutorials SET status='INACTIVE' WHERE ID = ?` |

**Initiator persistence:** the endpoint receives the bearer token's identity as `req.user.id`, which for a CI caller is the technical SAP user that backs `CONTENT_API_KEY` — same value for every CI run. To preserve per-run attribution (so two CI runs in the same minute are distinguishable in audit), the endpoint wraps its work in [`logPipeline(...)`](../../../srv/lib/pipeline-log.js#L55) — the existing helper that handles start+end+error symmetrically. Arguments:

- `pipelineType = 'GITHUB_DISPATCH'` (the existing enum value closest to "CI-driven workflow_dispatch"; the enum is closed at [db/schema.cds:519-533](../../../db/schema.cds#L519-L533) so this avoids a schema change)
- `initiator = req.headers['x-initiator']` (set by the CLI from `INITIATOR` env var, default `ci/$GITHUB_RUN_ID`)
- `metadata = { stage: 'purge-orphans', slugCount, runId }` — `stage` is the discriminator the rollback queries use (via `JSON_VALUE(metadata, '$.stage')`) because `pipelineType` is over-broad

This mirrors how `/content/publish/commit` records initiator on `ContentManifest.initiator` and `PipelineLog` ([srv/lib/content-publish-session.js:62-75](../../../srv/lib/content-publish-session.js#L62-L75) is the canonical example).

**Change-tracking interaction:** `Tutorials` is `@changelog`-tracked through AdminService ([db/change-tracking.cds:37](../../../db/change-tracking.cds#L37)). Each `UPDATE Tutorials SET status='INACTIVE'` writes a row to `sap.changelog.Changes` with `entity = 'AdminService.Tutorials'` (the projection name, per [db/views.cds:373-378](../../../db/views.cds#L373-L378)), `attribute = 'status'`, `valueChangedTo = 'INACTIVE'`, `createdAt = <ts>`, `createdBy = <ci-technical-user>`. The `createdBy` is the technical user, NOT the `initiator` string — for run-level attribution, join `Changes` against `PipelineLog` on `createdAt`-window + `stage='purge-orphans'`. See the Rollback section for the canonical join.

**Transaction scope:** each slug's UPDATE runs in its own implicit CAP transaction. Partial failure is reported in the response; one failure doesn't roll back the whole batch. Matches the existing batch-admin shape (e.g. `cleanupAutotestData`).

**Server-side cap (defense in depth):** reject 400 if `slugs.length > 100`. The client should already have refused at the absolute cap (50 by default); this protects against a future CLI version loosening its own cap. See "Cap design" under CLI mode for the relationship between the percent cap, the absolute cap, and this server ceiling.

**Returned `version`:** the current ACTIVE `ContentManifest.version` at the time of the call. The manifest is **not** bumped by purge — only `Tutorials.status` flips. Included so the operator knows which publish state the purge ran against. The version may be SUPERSEDED by a concurrent publish by the time the operator reads it; the purge's effect on `Tutorials.status` is independent of manifest version per the concurrent-publish race entry in the Risks table.

### 3. CLI mode + workflow input

[scripts/publish-content.ts](../../../scripts/publish-content.ts) — new `--purge-orphans` flag, added to the mutually-exclusive-flags validator at line 438 alongside `--force` / `--heal` / `--verify-only`.

[.github/workflows/rebuild-content.yml](../../../.github/workflows/rebuild-content.yml) — new optional `purge-orphans` workflow input (default `false`); when true, adds a post-commit step gated on `effective_mode == 'full' && publish.outcome == 'success'`.

Details for both in **CLI mode** and **Workflow integration** sections below.

## CLI mode

### Flags

| Flag | Env var | Default | Purpose |
|---|---|---|---|
| `--purge-orphans` | — | off | Activates this mode |
| `--purge-cap-abs N` | `PURGE_CAP_ABS` | `50` | Refuse if orphans > N (absolute) |
| `--dry-run` | — | (existing) | Print what would happen, don't call the endpoint |
| `--initiator <value>` | `INITIATOR` | `${user}@${hostname}` | (existing) — workflow passes `ci/$GITHUB_RUN_ID`; sent as `x-initiator` header |

`--purge-orphans` is mutually exclusive with `--force`, `--heal`, `--verify-only`.

### Cap design

**Round 1 of this spec had two caps (5% percent + 50 absolute, both must pass).** Spec review (HIGH issue #4) flagged that a percent cap is redundant once an absolute cap is set: for any realistic catalog size, 50 is already small enough to catch "fetch dropped half the catalog" (50/1396 = 3.6%). On a 5000-slug catalog the percent cap would let 250 through, exceeding the server's 100-slug ceiling — so the percent cap doesn't add safety, it adds confusing edge cases.

**Resolved design: absolute cap only.** Default `PURGE_CAP_ABS=50`. The relationship between client and server caps:

| Cap | Default | Purpose |
|---|---|---|
| Client `--purge-cap-abs` | 50 | First gate — refuses the call before any HTTP traffic |
| Server hardcoded ceiling | 100 | Last-resort gate — protects against future CLI versions that loosen their own cap |

If an operator deliberately raises `--purge-cap-abs` above 100 (e.g. after a known one-time bulk cleanup), the server rejects with `400 "batch too large; orphan purge enforces a 100-slug ceiling per call"`. The operator splits the work into multiple calls, or files a separate change to raise the server ceiling.

### Execution flow

```text
1. CI-only guard
   if (!process.env.GITHUB_ACTIONS) exit 1 with:
     "purge-orphans is CI-only; run via:
      gh workflow run rebuild-content.yml -f mode=full -f purge-orphans=true"

2. Load local hashes from .tutorial-cache/*.md
   (same readdir as --verify-only at scripts/publish-content.ts:645-655)

3. Fetch /content/source-hashes
   (same call as --verify-only at scripts/publish-content.ts:661)

4. Compute orphans = serverSlugs.filter(s => !localHashes.has(s))
   (set membership, NOT hash equality — a slug appearing in BOTH sets is
    never an orphan even if local hash is corrupted/empty)

5. Cap check
   if (orphans.length > capAbs) {
     log error: "Orphan count <N> exceeds cap (<N> > <capAbs> abs).
                 Investigate fetch output before raising --purge-cap-abs."
     log first 20 orphans
     exit 1
   }

6. Print summary (slug count, % of catalog informational only, sample of 10)

7. If --dry-run → write $GITHUB_STEP_SUMMARY block with "would have purged"
   counts, exit 0

8. POST /admin/orphan-purge
   - Body: { slugs }
   - Headers:
       Authorization: Bearer ${CONTENT_API_KEY}
       x-initiator:   ${INITIATOR}
       Content-Type:  application/json

9. Error handling (always writes $GITHUB_STEP_SUMMARY, even on failure):
   - Non-2xx → log response body + status, write summary marking step
     as failed, exit 1 (distinct exit codes for clarity):
       401/403 → "Auth failure — check CONTENT_API_KEY secret for $env"
       400     → "Server rejected payload — see response body"
       5xx     → "Server error — retry once with same INITIATOR; idempotent"
   - Network error (DNS, timeout) → "Connectivity error — verify CAP_BASE_URL", exit 1

10. On 2xx response, sanity check:
    assert purged + alreadyInactive + notFound + redirected == totalAttempted
    Mismatch → exit 1 (malformed response; do NOT silently treat as success)

11. Print response summary:
    - purged: N
    - alreadyInactive: N
    - notFound: N (REQUIRES OPERATOR ACTION if > 0 — phantom rows;
                   list all slugs in output, file an issue per slug)
    - redirected: N (sample of redirected slugs)
    - manifest version: V

12. Write $GITHUB_STEP_SUMMARY block (see "Run summary" under Workflow integration)

13. Exit 0
```

### Output

```text
[purge-orphans] Fetched 1396 server slugs, 1374 local slugs
[purge-orphans] Computed 22 orphans (1.6% of server — informational)
[purge-orphans] Cap check: 22 < 50 abs → passes
[purge-orphans] Sample orphans: appgyver-configure-camera,
                  appgyver-connect-publicapi, btp-ea-onboard-04-subm,
                  codejam-0-prerequisites, ... (+18 more)
[purge-orphans] POST /admin/orphan-purge (24 slugs, initiator=ci/28442602262)
[purge-orphans] Response:
  purged:          21
  alreadyInactive: 0
  notFound:        0
  redirected:      3 (preserved: btp-ea-onboard-04-subm, ...)
  manifest version: 218
[purge-orphans] Done — 21 slugs soft-deleted; next /build/catalog refresh will reflect changes
```

### File location

Kept in `publish-content.ts` (not a new script) because:

- It reuses all four building blocks already there: `fetchRemoteSourceHashes`, the slug-cache reader, `validateFlagCombo`, initiator-resolution.
- The CI workflow already runs `npx tsx scripts/publish-content.ts` with the env wired up; a new script would need parallel wiring.
- The added code is ~80 lines, well under the threshold where a split helps.

## Workflow integration

### New input

```yaml
purge-orphans:
  description: 'After publish, soft-delete tutorials no longer present in any upstream repo. CI-only, 50-slug safety cap (override via PURGE_CAP_ABS env).'
  required: false
  type: boolean
  default: false
```

### Mode interaction

`purge-orphans` only runs after a `full` rebuild:

- `slug-targeted` / `catalog-only` runs deliberately do NOT fetch the entire catalog — they fetch only what's needed. The cache after a `slug-targeted` run contains 1-4 slugs; 1392+ slugs would falsely appear as orphans. That's exactly the failure mode the cap is meant to catch.
- `full` mode runs the same `discoverAllTutorials()` → `fetch-tutorials` flow the daily drift workflow consumes. Same provenance = trustworthy orphan set.

If `purge-orphans=true` is passed with `mode=slug-targeted` (or any mode that auto-infers away from `full`), the workflow's existing `Determine effective rebuild mode` step emits a `::error::` annotation and fails the run:

```text
::error title=purge-orphans requires mode=full::Got effective_mode=slug-targeted.
Re-run with -f mode=full -f purge-orphans=true.
```

No silent override.

### New step

Runs after the existing `Publish tutorial content to HANA` step ([rebuild-content.yml:300](../../../.github/workflows/rebuild-content.yml#L300)). **The plan must add `id: publish` to that existing step** — it has no id today, so `steps.publish.outcome` would evaluate empty without this change. The CAP srv URL is exposed by `steps.srv.outputs.srv_url` ([rebuild-content.yml:158](../../../.github/workflows/rebuild-content.yml#L158)), NOT `steps.env.outputs`. Secrets are referenced directly:

```yaml
- name: Purge orphan tutorials
  id: purge
  if: |
    inputs.purge-orphans == true &&
    steps.mode.outputs.effective_mode == 'full' &&
    steps.publish.outcome == 'success'
  env:
    CAP_BASE_URL:    ${{ steps.srv.outputs.srv_url }}
    CONTENT_API_KEY: ${{ secrets.CONTENT_API_KEY }}
    PURGE_CAP_ABS:   '50'
    INITIATOR:       "ci/${{ github.run_id }}"
  run: npx tsx scripts/publish-content.ts --purge-orphans
```

The `effective_mode` is published by the existing `id: mode` step ([rebuild-content.yml:124](../../../.github/workflows/rebuild-content.yml#L124)). The secret name `CONTENT_API_KEY` is correct for `dev`/`prod`; the plan must thread `CONTENT_API_KEY_QA` for the QA environment if it's ever invoked there (today this workflow's QA sibling is `rebuild-content-qa.yml`, so this concern is theoretical, but cover it in the plan).

**Why gated on `steps.publish.outcome == 'success'`:** if the publish failed (network blip, validator error), the server's `/content/source-hashes` might be in a transient state. Don't compound a failure with a destructive operation. Operator reruns with `purge-orphans=true` after the publish issue is fixed.

**Why three-conjunct `if:` and not one:** a simpler `if: inputs.purge-orphans == true` would let a `catalog-only` run with `purge-orphans=true` start the purge step, get blocked by the CLI's own mode check, and exit non-zero — turning a misconfiguration into a *failed CI run*. The three-conjunct gate makes the step *cleanly skip* when modes don't align (not fail), with a clear annotation in the run summary. Failure vs. skip carries very different operational meaning.

### Run summary

The workflow's existing `$GITHUB_STEP_SUMMARY` block gains:

```markdown
### 🧹 Orphan purge — full mode

- Server slugs scanned: 1396
- Orphans detected:     24 (1.7%)
- Soft-deleted:         21
- Preserved (redirect): 3 — btp-ea-onboard-04-subm, ...
- Manifest version:     218
```

— so it lands in the email digest the same way the existing drift report does.

### Permissions

No change. The workflow already has the API key for `/content/publish`; the same secret works for `/admin/orphan-purge` because both routes use the same XSUAA bearer.

## Testing

### Unit (in-memory SQLite, fast — runs with `npm test`)

| File | Coverage |
|---|---|
| [test/unit/purge-orphans-cap.test.js](../../../test/unit/purge-orphans-cap.test.js) | Absolute cap pass/fail; edge cases (0 server slugs, 0 local slugs, exactly-at-threshold, capAbs=0 special-case). Pure math — no HTTP, no DB. |
| [test/unit/purge-orphans-cli-guard.test.js](../../../test/unit/purge-orphans-cli-guard.test.js) | `GITHUB_ACTIONS` unset → exit 1; set → proceeds. Mutual exclusion vs `--force`/`--heal`/`--verify-only`. |
| [test/unit/orphan-purge-endpoint.test.js](../../../test/unit/orphan-purge-endpoint.test.js) | `AdminService.orphanPurge` against in-memory SQLite seeded with `ACTIVE` + `INACTIVE` + `redirectTo`-set + missing rows. Asserts the four bucket arrays. |

### Hybrid (real HANA, requires `cds bind` + `ALLOW_HYBRID_WRITES=true`)

| File | Coverage |
|---|---|
| [test/hybrid/orphan-purge.test.js](../../../test/hybrid/orphan-purge.test.js) | E2E against HANA. Seed two `__TEST__purge-orphan-*` rows with `status=ACTIVE`, POST `/admin/orphan-purge`, assert both flip to `INACTIVE`, assert `/content/source-hashes` no longer lists them, assert `/build/catalog` no longer lists them. `afterAll` cleans the test rows. |
| [test/hybrid/source-hashes-filters-inactive.test.js](../../../test/hybrid/source-hashes-filters-inactive.test.js) | Companion-fix coverage: seed an `INACTIVE` row, assert it's absent from `/content/source-hashes` and re-fetched `--verify-only` reports no drift for it. |

### Smoke (HTTP against deployed)

Add `/admin/orphan-purge` auth-enforcement to the existing admin-auth smoke file: 401 without bearer. No data write in smoke — just the auth gate.

## Rollout

### Phase 1 — server + companion fix (own PR, deploys first)

1. `/content/source-hashes` `INACTIVE` filter.
2. `AdminService.orphanPurge` action + tests.
3. Deploy to DEV via the canonical local-deploy path:
   ```
   npm run build:all
   cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
   ```
4. Smoke-verify the endpoint rejects unauthenticated calls.
5. Drift workflow next day should still report the same 24 orphans — the filter is wired but inert until something flips them to INACTIVE. Confirms it's not over-filtering.

### Phase 2 — CLI + workflow input (separate PR, after Phase 1 is in DEV)

1. `--purge-orphans` mode + cap logic.
2. Workflow input + gated step.
3. Manual dispatch against DEV:
   ```
   gh workflow run rebuild-content.yml -f mode=full -f purge-orphans=true
   ```
   Expected outcome: 21 purged, 3 preserved (redirected), step summary lands in run UI.
4. Re-run drift workflow same day. Expected outcome: server slugs 1396 → 1375, "missing locally" drops from 24 to 3 (the `redirectTo`-preserved ones).

### Phase 3 — PROD rollout (no code; operational)

1. Same Phase 2 dispatch against PROD after ≥24 h of DEV soak.
2. Confirm count is in the ballpark (~24 ± 5); investigate before raising caps if it's wildly different.
3. Update [docs/developers/operations/rebuild-content-workflow.md](../../developers/operations/rebuild-content-workflow.md) with the new flag and a "When to run purge-orphans" section.

## Rollback

If a Phase 2 dispatch mis-purges:

1. **Single row:** flip `status` back from `INACTIVE → ACTIVE` in the Tutorials Fiori app at `/admin-ui/#tutorials-display`.
2. **Bulk (>5 rows):** one-off `UPDATE Tutorials SET status='ACTIVE' WHERE ID IN (...)` via `cds bind --exec` against DEV — same shape as the existing `setup-dev-data.cjs` script.
3. **Reconstructing the "before" set:** the `@cap-js/change-tracking` table records every `status` flip. Two queries — pick by what you have:

   **(a) If you have the CI `run_id`** — join `Changes` against `PipelineLog` on the time window, filtered by the stage discriminator in `metadata` and the matching initiator:

   ```sql
   SELECT c.entityKey, c.createdAt
     FROM "sap.changelog.Changes" AS c
     INNER JOIN com_sap_developers_ims_pipelinelog AS p
       ON c.createdAt >= p.startedAt
      AND c.createdAt <= COALESCE(p.finishedAt, CURRENT_TIMESTAMP)
    WHERE c.entity     = 'AdminService.Tutorials'
      AND c.attribute  = 'status'
      AND c.valueChangedTo = 'INACTIVE'
      AND p.pipelineType = 'GITHUB_DISPATCH'
      AND JSON_VALUE(p.metadata, '$.stage') = 'purge-orphans'
      AND p.initiator  = 'ci/<run_id>';
   ```

   The `COALESCE(finishedAt, CURRENT_TIMESTAMP)` guards against an in-flight or crashed run where `finishedAt` is still NULL — the join still produces a usable row instead of all-NULLs filtering everything out. `JSON_VALUE` is the HANA function for extracting JSON fields; on SQLite use `json_extract(metadata, '$.stage')`.

   **(b) Time-window only** (no PipelineLog dependency):

   ```sql
   SELECT entityKey, createdAt, createdBy
     FROM "sap.changelog.Changes"
    WHERE entity     = 'AdminService.Tutorials'   -- projection name, not DB entity
      AND attribute  = 'status'
      AND valueChangedTo = 'INACTIVE'
      AND createdAt > '<ci-run-start-iso>';
   ```

   The `entity` filter is `'AdminService.Tutorials'` (the projection name) — `@cap-js/change-tracking` records the source service projection on each row ([db/views.cds:371-378](../../../db/views.cds#L371-L378) is the working precedent). The schema uses `createdAt`/`createdBy`, NOT `modifiedAt` ([node_modules/@cap-js/change-tracking/index.cds:207](../../../node_modules/@cap-js/change-tracking/index.cds#L207)).

4. **Re-activate:** feed the `entityKey` list from query (a) or (b) into the bulk UPDATE in step 2.

> **When reconstructing what happened:** start with `PipelineLog.metadata` for the run-level audit (who, when, why, how many slugs). Use the `version` returned by the purge response only if you need to correlate the purge with a specific publish snapshot for diff purposes — the version is informational, not authoritative.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Fetch-tutorials silently drops a repo → mass purge | 50-slug client absolute cap; 100-slug server cap as defense in depth |
| Operator runs from workstation against stale cache | `GITHUB_ACTIONS` hard-block in CLI |
| Operator runs with `slug-targeted` mode by mistake | Workflow `if:` skips cleanly (not fails); CLI errors with explicit redo command |
| Soft-delete hits a slug with a deliberate redirect | Per-slug `redirectTo` check skips; reports in `redirected[]` |
| Purge endpoint abused (mass soft-delete by non-CI) | Same XSUAA bearer as `/content/publish`; server-side 100-slug ceiling |
| `Tutorials.status` has NULL rows from legacy data | Pre-deploy data check (see Architecture §1); if any NULL rows exist, plan seeds them to `'ACTIVE'` as a one-shot migration step before the filter ships |
| Server returns malformed response (bucket sum ≠ total) | CLI sanity check at step 10 exits 1 instead of silently treating as success |
| Concurrent publish during purge race | Benign by design. Sequence: purge flips `Tutorials.status='INACTIVE'`. A mid-flight publish's `carryForwardUnchanged` copies the ContentFiles row into manifest V+1 (manifests are ContentFiles snapshots, not Tutorials snapshots), but the new `/content/source-hashes` filter checks `Tutorials.status` at read time, so the purged slug stays suppressed. Serve handler enforces the same INACTIVE filter ([content-store.js:978](../../../srv/lib/content-store.js#L978)). The status flag wins because it's on `Tutorials`, not on `ContentFiles`. No locking needed. |
| Corrupted/empty local hash causes false-positive orphan | Cannot happen by construction — orphan detection is SET MEMBERSHIP (`serverSlugs.filter(s => !localHashes.has(s))`), NOT hash equality. A slug present in BOTH sets is never an orphan regardless of hash value. Drift slugs go through `--heal`, not `--purge-orphans`. |
| Operator sees `notFound[]` and assumes auto-cleanup | Per-slug behavior table explicitly says "operator action required". CLI step 11 prints all `notFound[]` slugs (not a sample) and instructs the operator to file an issue. |
| CONTENT_API_KEY rotation drift between publish + purge | Both routes use the same secret. Publish step would fail first; gated `if: steps.publish.outcome == 'success'` skips purge. Purge-only auth failure → distinct CLI exit message (see Execution flow step 9). |

## Open questions

None at design freeze. The implementation plan will surface any during writing-plans.

## Appendix: the 24 missing-locally slugs from run 28422871998 (DEV)

For reference; this is the set Phase 2's first dispatch will operate on. Re-run drift to refresh before going to PROD.

### Bucket A — 3 slugs still in `discovery-baseline.json` (repo exists, file gone)

| slug | repo |
|---|---|
| `btp-ea-onboard-04-subm` | `sap-tutorials/btp-onboarding` |
| `btp-ea-onboard-06-abapm` | `sap-tutorials/btp-onboarding` |
| `rbrainey-sandbox-1` | `sap-tutorials/sandbox` (repo 404) |

### Bucket B — 21 slugs not in baseline (orphans)

- `appgyver-configure-camera`, `appgyver-connect-publicapi`, `appgyver-create-application`, `appgyver-display-information`, `appgyver-fetch-data`
- `codejam-0-prerequisites`, `codejam-01-homepage`, `codejam-02-product-detail-page`, `codejam-03-cart-page`, `codejam-04-spa-empty-process`, `codejam-05-spa-approval-flow`, `codejam-06-connect-app-process`, `codejam-07-build-deploy-app`, `codejam-08-work-zone-app`, `codejam-09-action-get`, `codejam-10-action-post`, `codejam-11-spa-rework`, `codejam-12-scan-barcode`, `codejam-13-filtering`, `codejam-14-spinner`, `codejam-15-conditional-formatting`
