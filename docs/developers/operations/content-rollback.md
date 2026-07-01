# Content rollback

Roll back the live tutorial HTML catalog to a prior `ContentManifest` version.

This is the intentional-revert path — separate from the server's automatic no-revert guard (which blocks stale-cache regressions) and separate from orphan-purge rollback (which reverses a soft-delete purge).

## When to use this

**Use `/content/rollback`** when:

- A content publish went out and needs to be reverted (bad content, broken page, wrong slug set).
- The version you want to revert to is the **immediately-prior manifest** (the one that was `ACTIVE` before the current one, now `SUPERSEDED`).
- Or an older `SUPERSEDED` manifest that hasn't been pruned yet by the daily content GC (kept: last 3 versions AND anything <7 days old).

**Do NOT use** `/content/rollback` when:

- You just want to fix ONE bad slug — publish a corrected version of just that slug via [rebuild-content workflow](rebuild-content-workflow.md) (`-f slug=<bad-slug>`). Faster and doesn't affect other slugs' publish history.
- You want to revert to a version that has already been GC'd. See the [HANA escape hatch](#hana-escape-hatch-last-resort) below.
- The problem is a soft-delete purge misfire — see the [orphan-purge rollback](rebuild-content-workflow.md#rollback) section instead.

## How rollback works

`/content/rollback` swaps two `ContentManifest` rows atomically:

- The current `ACTIVE` manifest → `ROLLED_BACK`
- The target `SUPERSEDED` manifest → `ACTIVE`

**What actually reverts:** the content served by `GET /content/tutorials/:slug` reads the currently-`ACTIVE` manifest's row set, so flipping which manifest is `ACTIVE` changes what visitors see for every slug that appears in the newly-`ACTIVE` manifest.

**What does NOT revert:** the underlying `ContentFiles` BLOB rows (indexed by `(version, slug)`) are untouched. Rollback is a **pointer flip**, not a content replay. If the SUPERSEDED manifest didn't include a slug (because that slug wasn't in the changed-slugs delta at publish time), the rollback leaves that slug's most-recent BLOB in place — the visitor sees whatever the previous carry-forward pointed to.

The in-memory content cache is invalidated after the swap; visitors see the reverted content on their next request.

## Runbook

### 1. Identify the target manifest version

Query `/content/hashes` won't help here — it's read-only for the currently-`ACTIVE` manifest. Instead:

```bash
# List recent manifests + statuses (bearer auth via CONTENT_API_KEY).
export CONTENT_API_KEY=<value-from-credstore-or-CI-secret>
export CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"

curl -sS -H "Authorization: Bearer $CONTENT_API_KEY" \
  "$CAP_BASE_URL/admin/ContentManifest?\$orderby=version%20desc&\$top=10" | \
  jq '.value[] | { version, status, createdAt, initiator, fileCount, trigger }'
```

Expected output for a typical DEV state:

```json
{ "version": 47, "status": "ACTIVE",     "createdAt": "...", "initiator": "ci/28528195252", "fileCount": 1398, "trigger": "hugo-build" }
{ "version": 46, "status": "SUPERSEDED", "createdAt": "...", "initiator": "ci/28528100...",  "fileCount": 1398, "trigger": "hugo-build" }
{ "version": 45, "status": "SUPERSEDED", "createdAt": "...", "initiator": "tom@THINKPAD",    "fileCount": 1398, "trigger": "hugo-build" }
```

Pick the target `SUPERSEDED` version. Default is the newest (version 46 in the example).

### 2. Trigger rollback

**Default (roll back to most recent SUPERSEDED):**

```bash
curl -sS -X POST -H "Authorization: Bearer $CONTENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$CAP_BASE_URL/content/rollback" \
  -d '{}'
```

**Roll back to a specific version:**

```bash
curl -sS -X POST -H "Authorization: Bearer $CONTENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$CAP_BASE_URL/content/rollback" \
  -d '{"targetVersion": 45}'
```

Expected success response:

```json
{ "rolledBackTo": 46, "status": "ACTIVE" }
```

### 3. Verify

```bash
# Confirm the swap
curl -sS -H "Authorization: Bearer $CONTENT_API_KEY" \
  "$CAP_BASE_URL/admin/ContentManifest?\$orderby=version%20desc&\$top=5" | \
  jq '.value[] | { version, status }'

# Expected:
#   { "version": 47, "status": "ROLLED_BACK" }
#   { "version": 46, "status": "ACTIVE" }
#   { "version": 45, "status": "SUPERSEDED" }

# Spot-check a slug that was affected — should now serve the reverted body
curl -sS "$CAP_BASE_URL/content/tutorials/<slug>" | head -c 500
```

## Failure modes

| Response | Meaning | Fix |
|---|---|---|
| **HTTP 401** | `CONTENT_API_KEY` header missing/wrong | Check the `contentAuthMiddleware` bearer against the srv's `CONTENT_API_KEY` env var (`cf env tutorials-srv \| grep CONTENT_API_KEY`) |
| **HTTP 404** — `"No rollback target found"` | No `SUPERSEDED` manifest exists. Either the srv is at its very first `ACTIVE` publish, OR the daily GC pruned all older versions | Use the [HANA escape hatch](#hana-escape-hatch-last-resort) — either re-publish the desired content OR forge a `SUPERSEDED` row |
| **HTTP 400** — `"Cannot rollback to version with status: FAILED"` | The requested `targetVersion` exists but is `FAILED` / `ROLLED_BACK` / `PUBLISHING` — only `SUPERSEDED` is a valid target | Pick a different version from Step 1's list |
| **HTTP 409** — `"Another operation is in progress"` | Another publish, rollback, or orphan-purge holds `content-lifecycle` lock (`JobLocks` row) | Wait for the other operation to finish; retry |
| **HTTP 500** — `"Rollback failed"` | Server-side error mid-swap. State is either fully rolled back or fully not — the two UPDATEs run in one CDS transaction, so no half-state | Check srv logs (`cf logs tutorials-srv --recent \| grep content/rollback`); retry once |

## Constraints and gotchas

- **7-day / 3-most-recent GC.** The daily `content-gc` cron (03:00 UTC, see [srv/jobs/scheduler.js](../../../srv/jobs/scheduler.js#L118)) prunes `SUPERSEDED` and `ROLLED_BACK` versions older than 7 days, keeping at LEAST the 3 most recent. So rollback targets older than a week may have been pruned. `ACTIVE` and `PUBLISHING` are never touched.
- **Rollback creates a `ROLLED_BACK` row** — this occupies one of the "3 most recent" slots when the next publish creates a new `ACTIVE` and demotes the recovered manifest back to `SUPERSEDED`. Two consecutive rollbacks + a publish can push the earliest target out of the retention window.
- **Rollback is idempotent per target, NOT per source.** Rolling back A→B, then A→B again (via a re-publish that reverses the rollback), then A→B a third time all work fine. But rolling back from A→B → then trying to roll back to A again is a NEW publish, not a rollback API call — because A is now `ROLLED_BACK`, and the endpoint refuses non-`SUPERSEDED` targets.
- **`/content/rollback` does NOT trigger the no-revert guard** — the guard applies to `/content/publish` payloads (which pin `sourceHash` to detect stale-cache regressions). Rollback is a lifecycle operation on manifests already in the DB; it never re-writes `sourceHash`.
- **In-flight publishes block rollback.** The `content-lifecycle` lock is exclusive across publish + rollback + orphan-purge. Attempting rollback during a publish returns 409.
- **Cache invalidation is in-process, per-instance.** Multi-instance srv deployments would need per-instance cache flush; today `tutorials-srv` runs `web: 1/1` so this is not an issue. Watch the instance count if scaling out.

## HANA escape hatch (last resort)

If `/content/rollback` is insufficient — the version you want is GC'd, or the no-revert guard is blocking a legitimate re-publish of an old-known-good `sourceHash` — the HANA escape hatch:

**Case A — re-publish an old `sourceHash` blocked by the no-revert guard.** The guard rejects a slug if its incoming `sourceHash` appears in **any prior manifest version older than the most recent prior hash that differs from incoming** (see [`_no_revert_guard`](../../../srv/lib/content-publish-session.js) implementation). Nulling out the offending prior hash allows the next publish of that slug to appear "novel":

```sql
-- Connect via hana-cli / cds bind --exec, running as HDI runtime user.
UPDATE com_sap_developers_ims_contentfiles
   SET sourceHash = NULL
 WHERE version = <VERSION>
   AND slug = '<SLUG>';
```

Then re-publish (single-slug via `gh workflow run rebuild-content.yml -f slug=<SLUG>` is fastest).

**Case B — forge a `SUPERSEDED` row to give rollback a target.** Rarely needed; only useful when a GC ran while a rollback was queued. Copy the desired historical version's `ContentFiles` rows forward under a new `version`, then insert a `ContentManifest` row with `status = 'SUPERSEDED'`. Then run `/content/rollback` targeting that version. Complex; capture the SQL you ran in a Postmortem.

**Both cases:** log what you did. Escape hatches should be visible in the git history — write the SQL as a one-off script under `scripts/` and commit it with a `-fix` prefix, even if you delete the script after running. Future maintainers debugging a similar issue will thank you.

## Related runbooks

- [rebuild-content-workflow.md](rebuild-content-workflow.md) — how the content-publish pipeline is triggered; the `Rollback` section there covers **orphan-purge** rollback (different meaning — reversing a bad soft-delete purge)
- [testing-endpoints.md](testing-endpoints.md) — endpoint reference including `/content/publish`, `/content/rollback`, `/content/orphan-purge`
- [live-probing.md](live-probing.md) — how to probe deployed content endpoints
- [`docs/superpowers/specs/2026-05-29-publish-content-hardening-design.md`](../../superpowers/specs/2026-05-29-publish-content-hardening-design.md) — the publish-hardening spec that introduced the chunked protocol and the no-revert guard
- [`docs/superpowers/specs/2026-06-30-orphan-purge-design.md`](../../superpowers/specs/2026-06-30-orphan-purge-design.md) — orphan-purge design (its own rollback shape)

## Where this is enforced in code

- Handler: [`srv/lib/content-store.js`](../../../srv/lib/content-store.js) — `rollbackHandler` (search for `--- POST /content/rollback ---`)
- Route mount: [`srv/server.js`](../../../srv/server.js) — `app.post('/content/rollback', ...)` (bare Express + `contentAuthMiddleware`)
- Manifest schema: [`db/_content-shape.cds`](../../../db/_content-shape.cds) — `aspect ContentManifestAspect` with `status enum { PUBLISHING; ACTIVE; SUPERSEDED; ROLLED_BACK; FAILED; }`
- GC job: [`srv/jobs/scheduler.js`](../../../srv/jobs/scheduler.js) — `content-gc` cron, `cleanupContentVersions(keep=3, olderThanDays=7)`
- Lifecycle test: [`test/integration/content-pipeline-lifecycle.test.js`](../../../test/integration/content-pipeline-lifecycle.test.js)
