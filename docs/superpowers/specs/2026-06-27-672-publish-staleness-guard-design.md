# #672 — Publish staleness guard: design

**Date:** 2026-06-27
**Issue:** [sap-tutorials/tutorials-ims#672](https://github.com/sap-tutorials/tutorials-ims/issues/672)
**Status:** Design approved; implementation plan to follow.

## Context

The daily content-drift workflow on 2026-06-27 ([run 28280011633](https://github.com/sap-tutorials/tutorials-ims/actions/runs/28280011633)) reported 10 slugs with source-markdown drift. All 10 were verified as **real upstream content regressions on the server** — not false positives. The mechanism, traced via `ContentFiles` row history:

| version | when | trigger | hugoVersion | sourceHash for `abap-env-ddls-extend` |
|---|---|---|---|---|
| v82 | 2026-06-24 18:09 | `ci/workflow_dispatch` | `0.147.7` | `219282e7…` (NEW, matches upstream) |
| v83 | 2026-06-24 18:35 | `ci/workflow_dispatch` | `0.147.7` | `219282e7…` (NEW) |
| **v84** | **2026-06-25 01:42** | **`manual@local`** | **empty** | **`b42dd9b8…` (OLD — regressed)** |
| v85 | 2026-06-26 19:00 | `manual@local` | empty | `b42dd9b8…` |
| v86 (ACTIVE) | 2026-06-27 01:58 | `manual@local` | empty | `b42dd9b8…` |

CI runs at v82/v83 correctly published fresh upstream content. A workstation `npm run publish-content` at v84 overwrote it with stale bytes from a stale `.tutorial-cache/`. Subsequent `manual@local` publishes carried the staleness forward.

PR #591 made drift _detection_ clean (no more volatile Hugo/Shiki/recs-rail noise). But the _publish path_ never gained a matching guard: `scripts/publish-content.ts:643-662` computes the delta as `local HTML hash ≠ remote HTML hash` and uploads any difference in either direction. A stale client wins every time. The server-side `commitHandler` accepts whatever `sourceHash` the client sends.

A secondary observation: every `manual@local` row has `createdBy = 'anonymous'` and `PipelineLog.initiator = NULL`. We cannot attribute a publish to a person or machine, so the interim "stop running it from a workstation" rule is unenforceable — we can't tell whether it's being followed.

## Goals

1. **Prevent silent content regressions.** A publish that would overwrite an active slug with bytes the server has previously seen and superseded must not succeed.
2. **Optimize the common case.** A client whose `.tutorial-cache/` matches the server should detect that locally and skip the upload, not fall through to a no-op HTML re-render and full payload.
3. **Make publishes attributable.** Every publish records who issued it (`user@hostname` for a workstation, `ci/<run-id>` for CI).

## Non-goals

- Live-upstream comparison on every commit (rejected as Section 2 option 2: introduces GitHub as a hot-path dependency, adds latency, fails open on rate limits). Reopen if the no-revert guard misses a real failure.
- Backfilling historical `initiator` values. Pre-guard rows stay `NULL` — honest signal.
- Drift-workflow alert on `ContentManifest.createdBy != 'ci/*'`. Defer until attribution data has accumulated; we don't yet know what real values look like.
- Admin UI for "show all rejected reverts in last N days." `PipelineLog.metadata` carries the data; query it when someone needs it.

## Architecture overview

Three layers, each independently useful:

1. **Server guard (authoritative).** [srv/lib/content-publish-session.js](../../../srv/lib/content-publish-session.js) `commitPublishSession`. Per-slug no-revert check; reverted slugs carry-forward instead of committing. Runs unconditionally — `--force` does not bypass it.
2. **Client short-circuit (optimization).** [scripts/publish-content.ts](../../../scripts/publish-content.ts) `computePublishPlan` pre-step. In delta mode only, drop slugs whose local `sourceHash` matches the server's. `--force` and `--heal` skip this layer.
3. **Attribution (forensics).** New `ContentManifest.initiator : String(255)` column. CLI auto-stamps `${os.userInfo().username}@${os.hostname()}`, overridable via `--initiator <value>` or `INITIATOR` env var. Begin-handler writes it to both `ContentManifest.initiator` and `PipelineLog.initiator`.

The server guard is the line that must hold; clients can be misconfigured, bypassed, or absent. The client short-circuit is a courtesy — it never decides whether content is safe to publish, only whether we can skip an upload round-trip. Attribution closes the loop on "is the workstation-publish rule being followed" — answerable now via a one-row SELECT against `ContentManifest`.

## Server guard

**Location.** `commitPublishSession` in [srv/lib/content-publish-session.js](../../../srv/lib/content-publish-session.js), inserted between line 225 (`freshSlugs` capture) and line 230 (`carryForwardUnchanged` call).

**Algorithm.** Two SQL round-trips total (not per-slug). The append-phase has already INSERTed the in-flight rows for `$newVersion`; the guard reads them back rather than threading the in-memory `entries[]` from `appendToSession` through to commit:

1. `SELECT slug, sourceHash FROM ContentFiles WHERE version = $newVersion AND slug IN (...freshSlugs) AND sourceHash IS NOT NULL` — the incoming `(slug, sourceHash)` pairs that have a hash to check. Slugs without a `sourceHash` (e.g. pre-PR#591 legacy rows or special slugs `__shell__`, `__nav__`, `__404__`) are skipped: there's nothing to compare against.

2. `SELECT slug, sourceHash, version FROM ContentFiles WHERE slug IN (...freshSlugsWithSrc) AND version < $newVersion AND sourceHash IS NOT NULL ORDER BY slug, version DESC` — every prior `(slug, sourceHash, version)` for those slugs.

3. In JS: for each slug, walk its prior versions newest-first. Find the **most recent prior `sourceHash` that differs from the incoming one** — call this version `V_div`. If the incoming hash appears in **any version older than `V_div`**, classify it as a revert.

4. For each reverted slug: `DELETE FROM ContentFiles WHERE version = $newVersion AND slug = $slug`. The existing `carryForwardUnchanged` step then re-pulls the current ACTIVE row for that slug. Result: the slug's ACTIVE content is unchanged.

5. Collect the rejected slug list. Pass it through the commit response and stamp into `PipelineLog.metadata`.

**Why "appears in any version older than `V_div`" rather than "matches any prior hash":**

A legitimate flap is `A → B → A`: an author makes an edit, reverts it themselves, republishes. The current upstream IS `A`, so we don't want to refuse the second `A`. The walk catches "we had this content, moved past it, and now you're trying to move back to it" while permitting "current upstream just happens to be a hash we've seen before."

**SQLite parity.** Both queries are vanilla SQL. No HANA-specific features. Works on the in-memory SQLite path used by unit tests. Hybrid test (below) covers the HANA path.

**Performance.** Bounded by `freshSlugs` count (typically ≤50 in delta publishes, ~1400 in full). The history scan is the same row-count order of magnitude as the existing `carryForwardUnchanged` step — negligible relative to the publish's existing work.

**Concurrency.** Already serialized by the existing `acquireLock(LOCK_NAME, ...)` at session-begin. Guard runs inside that critical section.

**Response shape.** Existing commit response gets one new field:

```json
{
  "version": 87,
  "fileCount": 1406,
  "totalSizeBytes": 176019355,
  "durationMs": 1335,
  "carriedForward": 1356,
  "rejectedReverts": ["abap-env-ddls-extend", "hana-cloud-alerts"]
}
```

`rejectedReverts` is always present — `[]` when no reverts. Clients can rely on the field.

**Audit trail.** Rejected slugs go into `PipelineLog.metadata` as `{ rejectedReverts: [...] }` so the admin Pipeline Log Object Page surfaces them under the existing Metadata facet. The commit `summary` text gets a suffix: `"Published v87: 50 new + 1356 carried = 1406 slugs in 1335ms (2 reverts rejected)"`.

**Intentional revert escape hatch.** Use `/content/rollback`. `--force` does **not** bypass the server guard — it remains a client-side performance shortcut only (skips the `/content/hashes` round-trip; uploads everything). If `/content/rollback` is insufficient for a specific case, set `sourceHash = NULL` on the offending prior version via direct SQL so the guard treats the slug as novel.

## Client short-circuit

**Location.** [scripts/publish-content.ts](../../../scripts/publish-content.ts), between line 639 (`computeLocalHashes`) and line 657 (`computePublishPlan`).

**Algorithm.**

1. Refactor `buildSourcePayload` so its hash-computation half is callable independently as `computeLocalSourceHashes(slugs, cacheDir)`. `buildSourcePayload` calls this internally — no duplicated logic.
2. After `computeLocalHashes(tutorials)` (HTML hashes), also call `computeLocalSourceHashes(tutorials.keys(), cacheDir)`.
3. In delta mode only, in addition to fetching `/content/hashes`, also fetch `/content/source-hashes` (existing `fetchRemoteSourceHashes`).
4. Drop from `targetSlugs` any slug where local `sourceHash === server sourceHash`. Log `"Short-circuited N of M slugs (source-hash match) — local cache is in sync"`.
5. If `targetSlugs.length === 0` after the short-circuit, fall through to the existing "No changes detected. Nothing to publish." exit.

**Why it's safe.** The short-circuit drops slugs whose source markdown is byte-identical between client and server. Server-side, those slugs would have been carry-forwarded anyway (their `sourceHash` matches current ACTIVE). Skipping the upload saves a round-trip; it cannot cause divergence.

**Mode interaction.**

| Mode | `/content/hashes`? | `/content/source-hashes`? | Short-circuit? |
|---|---|---|---|
| `delta` (default) | yes | **yes (new)** | yes |
| `force` | no | no | no — `--force` means "upload everything" |
| `heal` | yes | no | no — `--heal` exists to fix slugs the client thinks are in sync |

Server guard runs in all three modes regardless.

**Special slugs.** `__shell__`, `__nav__`, `__404__` have no `.tutorial-cache/<slug>.md`. `computeLocalSourceHashes` skips them; they never short-circuit; they always upload. Existing behavior unchanged.

**Failure handling.** If `/content/source-hashes` 404s or times out, fall through to existing behavior (skip the short-circuit, publish via HTML-hash delta). Log a warning naming the disengaged layer. The endpoint legitimately returns 0 hashes on a fresh deploy — that case must not block publishes.

## Attribution

**Schema change.** Add to `ContentManifestAspect` in [db/_content-shape.cds](../../../db/_content-shape.cds):

```cds
aspect ContentManifestAspect : managed {
  key version               : Integer;
  status                    : String(20) enum { PUBLISHING; ACTIVE; SUPERSEDED; ROLLED_BACK; FAILED; };
  trigger                   : String(500);
  initiator                 : String(255);  // NEW — "user@hostname" or "ci/<run_id>"
  fileCount                 : Integer;
  // ... rest unchanged
}
```

Nullable, additive. HANA HDI deploy emits `ALTER TABLE ADD COLUMN initiator NVARCHAR(255)` — idempotent. Existing rows get `NULL`; no backfill.

**Client.** Three pieces in [scripts/publish-content.ts](../../../scripts/publish-content.ts):

1. New `--initiator <value>` CLI flag, with `INITIATOR` env var fallback. Default: `${os.userInfo().username}@${os.hostname()}` computed at startup.
2. CI workflow [`rebuild-content.yml`](../../../.github/workflows/rebuild-content.yml) passes `--initiator "ci/${GITHUB_RUN_ID}"` explicitly — same pattern as `--hugo-version`. Same for `rebuild-content-qa.yml`.
3. Sent in the `/content/publish/begin` body alongside `trigger` and `hugoVersion`.

**Server.** `beginPublishSession` accepts the new `initiator` arg, writes it to `ContentManifest.initiator` at the INSERT block (around line 44 of [srv/lib/content-publish-session.js](../../../srv/lib/content-publish-session.js)), *and* passes it to `logPipelineStart` so `PipelineLog.initiator` (existing column, currently null) is populated symmetrically. One value, two columns, one source.

**Admin UI.** No new app. Two annotation additions:
- [srv/admin-service.cds](../../../srv/admin-service.cds) exposes `ContentManifest.initiator` (it already exposes the entity).
- Operations Object Page annotations add `initiator` to the LineItem and FieldGroup.

PipelineLog tile already shows `initiator` — once `beginPublishSession` fills it, attribution appears there with no UI change.

**No backfill.** Historical `manual@local` rows stay `NULL`. Pretending to know who did them would be dishonest.

## Docs

[CLAUDE.md](../../../CLAUDE.md) "Content Publishing" section:

- A warning callout at the top: `npm run publish-content` is **emergency-only**; canonical publish path is `gh workflow run rebuild-content.yml`. Until #672, a stale workstation cache regressed live content.
- Flag documentation: `--initiator` added (with auto-default explained); `rejectedReverts` field added to response shape example.
- New "Reverting content intentionally" subsection: use `/content/rollback`, not `--force`. `--force` no longer overrides the server's revert guard.

[docs/developers/operations/rebuild-content-workflow.md](../../../docs/developers/operations/rebuild-content-workflow.md):

- Same workstation-publish warning at the top.
- New "Drift attribution" subsection pointing at `ContentManifest.initiator` and the admin Pipeline Log tile.

## Tests

**Unit ([test/unit/content-publish-guard.test.js](../../../test/unit/content-publish-guard.test.js), new).** SQLite, fast. Five cases:

1. `commit detects revert when incoming sourceHash matches a superseded version` — write v1=hash `A`, v2=hash `B` (active), attempt v3=hash `A` → expect `rejectedReverts: ['slug']`, ACTIVE still has v2's content.
2. `commit allows legitimate flap A → B → A → C` — v1=A, v2=B, v3=A rejected; subsequent v3=C accepted normally.
3. `commit allows novel content` — v1=A, v2=B accepted (no revert).
4. `commit ignores slugs with null sourceHash` — pre-PR#591 rows don't false-positive.
5. `initiator written to ContentManifest and PipelineLog symmetrically` — begin with `initiator: 'bob@laptop'`, verify both columns.

**Hybrid ([test/hybrid/content-publish-guard.test.js](../../../test/hybrid/content-publish-guard.test.js), new).** Real HANA. Behind the existing `ALLOW_HYBRID_WRITES` write-safety guard, with `__TEST__` slug prefix and `afterAll` cleanup matching the pattern in [test/hybrid/content-publish-chunked.test.js](../../../test/hybrid/content-publish-chunked.test.js) — copy that file's `beforeAll`/`afterAll` harness verbatim, the slug-prefix cleanup is non-obvious. Two cases:

1. **Canonical regression.** Three sequential begin/append/commit cycles in one test (same pattern as `'runs begin → 3 parallel appends → commit'` in the chunked-publish test). First: v=N, slug `__TEST__-drift-672`, sourceHash `H1`. Second: same slug, sourceHash `H2`. Third: same slug, sourceHash `H1` (the revert) → assert `rejectedReverts` contains the slug AND the active row retains `H2`.
2. **Initiator round-trip.** Begin with `initiator: '__TEST__-bob@laptop'`, commit, verify both `ContentManifest.initiator` and `PipelineLog.initiator` are `'__TEST__-bob@laptop'`.

No client unit test for the short-circuit beyond what `computePublishPlan` already covers — the short-circuit is a thin filter; the integration is exercised end-to-end by the hybrid chunked-publish test.

## Rollout

Three commits, **one PR**. Splitting would leave a confusing intermediate where CI runs are still anonymous.

1. **Server guard + schema column + unit tests.** Backward-compatible: clients that don't send `initiator` get `NULL`; clients without the short-circuit still work. Without an updated client, the guard catches reverts immediately. Schema change is additive nullable.
2. **Client short-circuit + `--initiator` + hybrid test.** `publish-content.ts` adds the source-hash short-circuit and the `--initiator` flag/default. `rebuild-content.yml` and `rebuild-content-qa.yml` pass `--initiator "ci/$GITHUB_RUN_ID"`. Hybrid test covers canonical regression + initiator round-trip.
3. **Docs.** `CLAUDE.md` and `rebuild-content-workflow.md`. Doc-only.

Verification post-deploy: the next daily drift workflow run (05:44 UTC) should report **0 drifted slugs** (the slug-targeted repair run, kicked off after issue #672 was filed, will have cleared the 10 current drifts). If a workstation publish lands between deploy and next drift check, the `ContentManifest.initiator` column should show its hostname.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| "Most-recent-prior-differing-hash" walk has an edge case we didn't think of. | Unit test cases #1 and #2 (revert; legitimate flap) plus the hybrid test cover the obvious shapes. False-positive failure mode is "operator sees `rejectedReverts: [slug]` on a legitimate publish." Verify against upstream and use `/content/rollback`, or null out the offending prior `sourceHash` via SQL so the slug appears novel. Document in `rebuild-content-workflow.md`. |
| `os.userInfo().username` returns runner-UID on some CI environments. | CI explicitly overrides with `--initiator "ci/$GITHUB_RUN_ID"`; the auto-default never runs in CI. Documented in runbook. |
| `/content/source-hashes` 404s on QA or fresh deploy → short-circuit silently disables. | Acceptable. Optimization-only; server guard still runs. Warn-log names the disengaged layer. |
| HANA schema migration fails mid-deploy. | Additive nullable column = idempotent `ALTER TABLE ADD COLUMN`. CAP handles missing columns gracefully on managed-entity INSERTs, so a partial deploy still boots. |
| `schema-drift-check.yml` failure when prod/QA artifacts diverge. | Schema is shared between `srv` and `srv-qa` (aspect lives in `db/_content-shape.cds`). [`.github/workflows/schema-drift-check.yml`](../../../.github/workflows/schema-drift-check.yml) is currently scoped to `JobLocks` (per CLAUDE.md note), so ContentManifest changes don't trip it. Verify the workflow's narrowing pattern still excludes ContentManifest before submitting. |
| Long-tail: incident response after a future regression that the guard *correctly* blocks but operator wants to override. | `/content/rollback` is the supported path. As a last resort, `UPDATE com_sap_developers_ims_contentfiles SET sourceHash = NULL WHERE version=<X> AND slug=<Y>` makes the guard treat the next publish of that slug as novel. Document both. |
