# Publish Content Hardening — Chunked Protocol Design

**Date:** 2026-05-29
**Status:** Approved (awaiting spec review + implementation plan)
**Owner:** Tom Jung
**Related memory:** `project_publish_content_hardening_followup.md`
**Tracking issue:** TBD

## Background

On 2026-05-29 a full DEV deploy ran `npm run publish-content -- --force`. The
client exited with `Fatal: fetch failed` after the 53.4 MB POST to
`/content/publish`. The server-side log told a different story:

- `POST /content/publish` returned **HTTP 201**.
- `response_time:340.542260` (5 minutes 40 seconds).
- `Upserted metadata for 1397 tutorials`.
- `Upserted body text for 1398 tutorials`.
- `/content/hashes` reported all 1398 slugs.
- AppRouter routes served tutorials at HTTP 200.

The publish actually succeeded. The CF gorouter / AppRouter request idle
timeout (~300 s) closed the TCP socket before the server's response made it
back to the client's `fetch`. The script then exited non-zero, and any CI
step branching on the exit code would falsely mark the deploy "failed."

The client today does a single huge POST in [scripts/publish-content.ts:467](../../scripts/publish-content.ts#L467)
with no chunking, no retry, and no post-flight verification. The error log
prints only `Fatal: fetch failed` — no `err.cause`, no `err.code`, no context.

## Goals

1. Eliminate transport-layer false negatives on the publish path.
2. Cut wall-clock time on full publishes from 5+ min to ≤ 90 s.
3. Make every failure log diagnosable without grepping `cf logs`.
4. Provide read-only verification (`--verify-only`) and targeted re-publish
   (`--heal`) modes so ops can confirm or repair state without re-running
   a full publish.
5. Keep the legacy `POST /content/publish` endpoint working unchanged for one
   release cycle to avoid breaking out-of-tree callers.

## Non-Goals

- Cross-invocation resumability (a `--resume` flag that picks up where the
  previous run was killed). YAGNI for now — the publish lock + per-batch
  retry handles 95% of real failures, and CI re-running from scratch is
  acceptable for the rest.
- Streaming / chunked-transfer-encoding HTTP. Doesn't fix the underlying
  AppRouter idle-timeout problem — connection still has to stay open.
- HTTP/2 multiplexing. Out of scope; current AppRouter HTTP/1.1 is fine
  once we chunk into many small requests.
- Webhook-style asynchronous publish completion notification. The client
  is fine to block on `commit` because `commit` is now fast (~5–10 s).

## Approach

Replace the single-shot POST with a **chunked publish protocol** of three new
endpoints (`begin` / `append` / `commit`), plus a fourth (`abort`) for explicit
session teardown. The client splits the slug list into batches of 50 and sends
them through `append` with 6-way parallelism and per-batch retry. The legacy
`POST /content/publish` stays as a frozen-deprecated fallback.

### Architecture

```
Client (publish-content.ts)              Server (srv/lib/content-store.js)
─────────────────────────────────        ────────────────────────────────
1. Compute local hashes
2. POST /content/publish/begin    ─────► Acquire lock, allocate version,
                                         create PUBLISHING manifest,
   ◄─────────────────────────────────── return { sessionId, version }

3. Split changed slugs into batches of 50
4. POST /content/publish/append   ─┐
   POST /content/publish/append    ├──► Per batch: decompress, hash,
   POST /content/publish/append    │    INSERT ContentFiles rows, upsert
   POST /content/publish/append   ─┘    Tutorials + Steps metadata, upsert
   (6 in parallel; per-batch retry      body text. NO progress recompute,
   3× with exp backoff)                 NO carry-forward yet.
   ◄─────────────────────────────────── { batchHash, slugsAccepted }

5. POST /content/publish/commit   ─────► Carry forward unchanged slugs,
                                         recompute TUTORIAL TaskRecords
                                         progress, mark new manifest
                                         ACTIVE, mark previous SUPERSEDED,
   ◄─────────────────────────────────── invalidate cache, release lock.

6. Auto-verify: GET /content/hashes
   diff against local; exit non-zero
   if mismatch.
```

**Key invariants:**

- Each `append` is independent — primary key `(slug, version)` prevents
  collisions between concurrent batches.
- `commit` is the *only* step that activates the manifest. A session left
  uncommitted leaves the manifest in `PUBLISHING` and is reaped by GC after
  30 minutes.
- Carry-forward and progress recompute live in `commit` to keep `append`
  truly disjoint by primary key.
- `--verify-only` and `--heal` use the same `GET /content/hashes` semantic.

### Endpoints

| Endpoint | Request body | Server action | Response |
|---|---|---|---|
| `POST /content/publish/begin` | `{ trigger, hugoVersion, expectedSlugCount }` | Acquire `content-publish` lock; allocate next version; INSERT `ContentManifest { version, status: 'PUBLISHING', sessionId, lastAppendAt: now }` | `201 { sessionId, version, expiresAt }` |
| `POST /content/publish/append` | `{ sessionId, files: { slug: base64gzip }, metadata: { slug: TutorialMeta }, bodyTexts: { slug: text } }` | Verify session is `PUBLISHING` and not expired; per-slug: decompress, hash, INSERT `ContentFiles`; upsert `Tutorials` + `Steps`; upsert body text. Update `lastAppendAt`. | `202 { batchHash, slugsAccepted, totalSizeBytes }` |
| `POST /content/publish/commit` | `{ sessionId }` | Verify session is `PUBLISHING`; carry forward unchanged slugs from previous `ACTIVE`; recompute `TaskRecords` progress for affected tutorials; flip new manifest to `ACTIVE`; flip previous to `SUPERSEDED`; release lock; invalidate cache; trigger embedding job. | `200 { version, fileCount, totalSizeBytes, durationMs }` |
| `POST /content/publish/abort` | `{ sessionId, reason? }` | Mark manifest `FAILED`; release lock. ContentFiles rows orphaned and reaped by GC. | `200 { aborted: true }` |
| `POST /content/publish` | (existing) | Existing single-shot logic. Logs deprecation warning. **Frozen — no behavior changes.** | `200 { ... }` |

All four new endpoints require the bearer token (`CONTENT_API_KEY` /
`CONTENT_API_KEY_QA` for QA), same auth model as the legacy endpoint.

The wire shape of `files` matches the existing legacy endpoint exactly —
`{ slug: base64gzip }` where the value is a gzip-compressed HTML buffer
encoded as base64. `metadata` and `bodyTexts` follow the same shape as
the existing legacy payload's same-named fields.

`--heal` mode uses the same `begin → append → commit` flow as a normal
publish — the only difference is the input slug list (just the diff
against `/content/hashes`, not the full set). It does **not** patch the
active manifest in place; carry-forward at commit time picks up the rest
of the slugs from the previous `ACTIVE` version, same as any other publish.

### State Machine

```
                    ┌────────────────────┐
   POST /begin ────►│   PUBLISHING       │
                    │  (sessionId: ...)  │
                    └──┬──────────┬──────┘
                       │          │
        POST /commit   │          │  POST /abort  OR  GC reaps (>30 min)
                       ▼          ▼
                    ┌────────┐  ┌──────────┐
                    │ ACTIVE │  │  FAILED  │
                    └───┬────┘  └──────────┘
                        │
                   next /commit supersedes it
                        ▼
                    ┌─────────────┐
                    │ SUPERSEDED  │ (existing 7-day GC retains last 3)
                    └─────────────┘

   POST /content/rollback (existing)
                    ┌──────────────┐
                    │ ROLLED_BACK  │
                    └──────────────┘
```

### Idempotency contract

- `begin` is **not** idempotent — allocates a new version each call. Client
  must not retry transparently.
- `append` is idempotent for a `(sessionId, slug)` tuple — server does
  INSERT-or-UPDATE on `ContentFiles` keyed by `(slug, version)`.
- `commit` is idempotent — calling against a manifest already `ACTIVE`
  returns the activation result without re-running carry-forward. **This is
  what closes the original 2026-05-29 false-negative bug at the protocol
  level.**
- `abort` is idempotent — aborting a `FAILED` manifest is a no-op.

### Client orchestration

```ts
// scripts/publish-content.ts (sketch)

if (force && heal) exit(3, '--force and --heal are mutually exclusive');

const localHashes = computeLocalHashes(tutorials);

if (verifyOnly) {
  const remote = await fetch(`${baseUrl}/content/hashes`).then(r => r.json());
  const diff   = computeDiff(localHashes, remote);
  exit(diff.length === 0 ? 0 : 2, formatDiff(diff));
}

const targetSlugs = force
  ? [...localHashes.keys()]
  : computeDiff(localHashes, await fetchRemoteHashes());

if (targetSlugs.length === 0) exit(0, 'No changes detected.');

const { sessionId, version } = await beginSession({ trigger, hugoVersion });
try {
  await batcher({
    items: targetSlugs,
    batchSize: 50,
    concurrency: 6,
    perBatch: (batch) => withRetry(
      () => appendBatch({ sessionId, slugs: batch, payload, metadata, bodyTexts }),
      { attempts: 3, backoffMs: [1000, 3000, 9000] }
    ),
  });
  await withRetry(
    () => commitSession({ sessionId }),
    { attempts: 3, backoffMs: [1000, 3000, 9000] }
  );
} catch (err) {
  await abortSession({ sessionId, reason: err.message });
  throw err;
}

const verifyDiff = await verifyAgainstServer(localHashes, baseUrl);
if (verifyDiff.length > 0) exit(2, 'Publish reported success but verification failed');
```

### Failure modes & recovery

| Failure | Detection | Recovery |
|---|---|---|
| `begin` fails (lock held) | Server returns 409 | Client exits 1 with "another publish in progress" message. |
| `append` transient (5xx, network) | Per-batch retry 3× with 1 s / 3 s / 9 s backoff; `err.cause` + `err.code` captured | If retries succeed → continue. If exhausted → `abort` then exit 1. |
| `append` permanent (400, 401) | No retry; immediate fail | `abort` then exit 1. |
| `commit` fails | Server 5xx, manifest still `PUBLISHING` | Retry commit 3×. If still failing → leave for GC; exit 1 with version in error. |
| Process killed mid-publish | Manifest stays `PUBLISHING`, lock held | GC reaps after 30 min: marks `FAILED`, releases lock. Next publish proceeds normally. |
| Auto-verify mismatch | `GET /content/hashes` diff after commit | Exit 2 with diff. |
| Transport false negative on commit | Client `fetch` errors but server returned 200 | Client retries commit; idempotent — second call sees `ACTIVE`, returns success. |

### Error categorization (client)

```ts
type FailureClass = 'transient' | 'permanent' | 'verification';

// Transient — retry
//   - fetch threw (TypeError 'fetch failed', AbortError, ECONNRESET, ETIMEDOUT, EPIPE)
//   - HTTP 5xx (502, 503, 504), 408, 429
// Permanent — do not retry
//   - HTTP 4xx except 408/429 (400, 401, 409, 413)
// Verification — exit 2
//   - publish landed but local≠server post-flight
```

Every failure log walks `err.cause` recursively, captures `err.code`,
`err.errno`, `err.syscall`, and the response status if any.

### Exit codes

| Code | Meaning | When |
|---|---|---|
| 0 | Success | Publish + auto-verify both passed |
| 1 | Protocol failure | begin/append/commit failed permanently after retries; or `--verify-only` failed to reach server |
| 2 | Verification failure | Commit succeeded but post-flight `/content/hashes` diff is non-empty |
| 3 | Configuration failure | Mutex violation, missing API key, no tutorials found, dev artifacts in build |

CI workflows can branch on exit code 2 — that's the "publish lied" signal
worth alerting a human about, distinct from "transport failed, retry the
workflow" (exit 1).

### Server-side instrumentation

Extends the existing `PipelineLog` table (already used by
`logPipelineStart` on [srv/lib/content-store.js:269](../../srv/lib/content-store.js#L269)):

| Event | When | Fields |
|---|---|---|
| `CONTENT_PUBLISH_BEGIN` | begin handler accepts | sessionId, version, trigger, expectedSlugCount |
| `CONTENT_PUBLISH_APPEND` | each append batch completes | sessionId, batchSize, durationMs, totalSizeBytes |
| `CONTENT_PUBLISH_COMMIT` | commit completes | sessionId, version, fileCount, durationMs, carriedForward |
| `CONTENT_PUBLISH_ABORT` | abort handler accepts | sessionId, version, reason |
| `CONTENT_PUBLISH_GC_REAP` | GC reaps stale PUBLISHING | sessionId, version, ageMinutes |

## Components

### New files

| File | Purpose |
|---|---|
| `scripts/lib/publish-client.ts` | Pure functions for the chunked protocol: `beginSession`, `appendBatch`, `commitSession`, `abortSession`, `verifyAgainstServer`. No `process.exit`. Unit-testable. |
| `scripts/lib/publish-retry.ts` | Bounded retry with exponential backoff (1 s / 3 s / 9 s). Captures `err.cause`, `err.code`. Returns structured error with attempt count and final cause. |
| `scripts/lib/publish-batcher.ts` | Splits slug list into batches of size B; runs through configurable concurrency pool (default 6). Pure function, unit-testable. |
| `srv/lib/content-publish-session.js` | Server-side session helpers: `beginPublishSession`, `appendToSession`, `commitSession`, `abortSession`. Owns lock + manifest lifecycle. |

### Modified files

| File | Changes |
|---|---|
| `scripts/publish-content.ts` | Orchestrates new flow. Adds `--verify-only`, `--heal`, `--concurrency`, `--batch-size` flags. Mutex on `--force` vs `--heal`. New exit codes. |
| `srv/lib/content-store.js` | Adds `beginHandler`, `appendHandler`, `commitHandler`, `abortHandler`. Existing `publishHandler` left in place; logs deprecation warning. Metadata-upsert + body-text-upsert logic moved into session helpers so it can run per-batch. |
| `srv/server.js` | Registers `POST /content/publish/begin`, `/append`, `/commit`, `/abort` routes with `contentAuthMiddleware`. |
| `srv/jobs/cleanup.js` | Extends content-GC to reap `PUBLISHING` manifests. **A new high-frequency reaper runs every 5 minutes** (separate from the existing daily 03:00 SUPERSEDED-pruning job, which keeps its schedule). The 5-minute reaper marks any `PUBLISHING` manifest with `lastAppendAt` older than 30 minutes as `FAILED` and releases its job lock. This frequency is required to honor acceptance criterion #5 ("reaped within 30 min"); the daily cron alone cannot. |
| `db/schema.cds` | Adds nullable `sessionId : String(36)` and `lastAppendAt : Timestamp` columns to `ContentManifest`. Legacy single-shot publishes during the deprecation window leave both columns NULL — the new reaper ignores rows with `sessionId IS NULL`, so there's no chance of misclassifying a legacy publish as a stale session. |
| `docs/developers/operations/testing-endpoints.md` | Documents new endpoints; marks legacy deprecated. |
| `CLAUDE.md` | Updates Content Publishing section. Removes the `--force` recommendation from the npm reminder. Updates the "publish-content.ts delta detection" Gotcha. |

### Deleted files

| File | Why |
|---|---|
| `~/.claude/projects/d--projects-tutorials-poc/memory/feedback_publish_content_force.md` | Obsolete after this lands. The new chunked protocol fixes the underlying client-server contract mismatch (commit explicitly does carry-forward, so any subset is a valid input). `--force` becomes purely a performance flag. Update `MEMORY.md` index accordingly. |

## Testing strategy

### Unit tests (in-memory, fast — `npm test`)

| Test file | Coverage |
|---|---|
| `scripts/__tests__/publish-batcher.test.ts` | Concurrency cap honored; all batches eventually run; one failing batch doesn't starve the pool. Fake timers. |
| `scripts/__tests__/publish-retry.test.ts` | Backoff sequence is `1 s, 3 s, 9 s`; `err.cause` walked recursively; max-attempts boundary; permanent-class errors don't retry. Fake timers. |
| `scripts/__tests__/publish-client.test.ts` | begin → append → commit happy path with mocked `fetch`; abort on permanent error; idempotent commit on retry. |
| `scripts/__tests__/publish-content-cli.test.ts` | `--verify-only` is read-only; `--heal` publishes only diff; `--force` + `--heal` rejected with exit 3; missing API key exits 3. |
| `srv/__tests__/lib/content-publish-session.test.js` | Session lifecycle on in-memory SQLite; abort marks `FAILED`; commit on already-`ACTIVE` is no-op-success; carry-forward semantics; lock contention returns 409. |
| `srv/__tests__/lib/content-store-deprecated.test.js` | Legacy single-shot endpoint still works; emits deprecation warning. Regression guard until removal. |

### Hybrid tests (real HANA — `npm run test:hybrid`)

| Test file | Coverage |
|---|---|
| `test/hybrid/content-publish-chunked.test.js` | Full begin/3-parallel-append/commit on real HANA; abort path leaves `FAILED`; concurrent appends don't corrupt PK; carry-forward picks up unchanged slugs; GC reaps stale `PUBLISHING` after simulated age. Gated by `ALLOW_HYBRID_WRITES=true`. Test data prefixed `__TEST__`. |

### Smoke tests

Intentionally **not** added to `test/smoke/`. Would require coordinating DEV
credentials and the cost/value isn't there — the hybrid suite already
exercises the same code path against real HANA.

### Manual verification checklist (pre-merge)

1. `npm run dev:hybrid` + `npm run publish-content -- --verbose` — observe
   parallel append batches in logs.
2. Kill `publish-content` mid-append (Ctrl+C) — confirm manifest stays
   `PUBLISHING`. Manually UPDATE `lastAppendAt` to be >30 min ago and
   confirm GC marks it `FAILED`.
3. `--verify-only` against fresh-publish state — exit 0.
4. UPDATE one row's `contentHash` to garbage, rerun `--verify-only` —
   exit 2 with diff.
5. DELETE 3 rows from `ContentFiles` for the active version, run
   `--heal` — confirm exactly those 3 are republished.

## Acceptance criteria

1. A simulated AppRouter idle-timeout (server sleeps 320 s before responding
   to one batch) produces zero false-negative exits — client retries the
   affected batch and succeeds.
2. The 2026-05-29 reproducer (full publish, ~53 MB, 1398 slugs) completes in
   ≤ 90 s wall-clock with default concurrency=6.
3. `--verify-only` exits 0 against a known-good DEV deployment and 2 against
   an artificially mutated one.
4. `--heal` against a deployment missing 5 random slugs publishes exactly
   those 5 and no others.
5. Killing the script mid-`append` leaves `ContentManifest.status='PUBLISHING'`;
   the GC job reaps it within 30 min and the next publish succeeds.
6. All failure logs include `err.cause`, `err.code`, attempt count.
7. Hybrid tests pass on real HANA; unit tests cover all retry/batcher paths.

## Configuration

New CLI flags on `scripts/publish-content.ts`:

| Flag | Default | Meaning |
|---|---|---|
| `--verify-only` | off | Read-only diff against `/content/hashes`. Exit 0 match, 2 mismatch. |
| `--heal` | off | Publish only the diff (slugs missing or mismatched on server). Mutex with `--force`. |
| `--concurrency N` | 6 | Parallel append batches. |
| `--batch-size N` | 50 | Slugs per append batch. |
| `--force` (existing) | off | Skip delta detection. |
| `--dry-run` (existing) | off | Print would-publish list, exit 0. |
| `--verbose` (existing) | off | Verbose logging. |

## Backward compatibility

- Legacy `POST /content/publish` endpoint **frozen** for one release cycle.
  Logs a deprecation warning on each call.
- `db/schema.cds` columns added are nullable — no migration risk for
  existing `ContentManifest` rows.
- CI workflow `.github/workflows/rebuild-content.yml` needs no changes;
  `npm run publish-content` orchestrates the new flow internally.
- After ~2 weeks of new flow being stable in DEV + production, a follow-up
  PR removes the legacy endpoint.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Parallel `append` exhausts HANA connection pool | Concurrency=6 well below CAP's default ~10. Configurable via `--concurrency`. |
| `commit` itself slow enough to hit timeout | Carry-forward + ACTIVE flip is bounded work; expected 5–10 s. If it ever creeps up, it can be split into its own background phase (Section 1 Question 3 Option C). |
| Stale `PUBLISHING` manifests accumulate if GC never runs | Cleanup job is part of existing daily cron and is well-tested. Acceptance test #5 verifies the path. |
| Two CI runs racing | Existing `content-publish` distributed lock acquired in `begin` returns 409 to the second runner. Same behavior as today. |
| Legacy endpoint silently rotted | `srv/__tests__/lib/content-store-deprecated.test.js` regression-guards it for the deprecation window. |

## Open questions

None — all six clarifying questions answered during brainstorm. Captured
above.

## Related work

- `project_publish_content_hardening_followup.md` (this design's origin)
- `feedback_publish_content_force.md` (obsolete after this lands; delete)
- `feedback_deploy_cds_build_freshness.md` (separate concern; unaffected)
- `project_folder_vs_repo_name.md` (informational; unaffected)
