# Scaling playbook

> **Forward-looking reference.** Each row in the playbook below documents a known scaling constraint, what breaks under load, the fix path, rough effort, and dependencies on other rows. The doc is the menu, not the implementation plan — individual scaling concerns become their own PRs as traffic or operational need forces them.

## Background

As of 2026-06-29 the platform is pinned to `instances: 1` across both `tutorials-srv` and `tutorials-approuter`. The pin on srv is enforced by three documented in-process rate limiters (covered in [mta-deployment.md § Scaling Constraints](../operations/mta-deployment.md#scaling-constraints)). The pin on the approuter is implicit (no documented reason) and is the target of phase-1 in #749.

This doc enumerates every known scaling constraint so each subsequent scaling PR has a known shape and we don't re-derive the analysis from scratch.

## Recommended sequence

The cheapest path to ~5x current traffic without the bigger Redis/replica work:

1. **Row #1 — AppRouter auto-scaling** (this PR / #749). Pure deploy-config, zero code risk.
2. **Row #3 — Cron separation** (same-binary, env-flag-gated). `JobLocks` already covers correctness at the lock level; pre-flight audit needed for caller-side acquire-before-side-effect ordering.
3. **Row #2 — Replace in-process rate limiters** with HANA-backed `RateLimitBuckets`. Unlocks `tutorials-srv` auto-scaling.
4. **Row #4 — WebSocket sticky sessions** (only if Socket.IO traffic justifies it).
5. Others as traffic forces them.

## The 15 constraints

| # | Constraint | Current pin | Fix path | Effort |
|---|---|---|---|---|
| 1 | **AppRouter sessions** | `instances: 1` (deploy default) | **#749 (this PR)** — CF Autoscaler + `instances: 1..4`. XSUAA cookie-based, stateless. | Hours |
| 2 | **In-process rate limiters** (feedback, search, chat) | Documented in [mta-deployment.md § Scaling Constraints](../operations/mta-deployment.md#scaling-constraints) | HANA-backed `RateLimitBuckets` entity (the "option 2" already recommended). | 2-3 days |
| 3 | **Scheduled cron jobs** | All run inside `tutorials-srv` instance 0; safe-by-lock via `JobLocks` but couples web latency to cron load | **Same-binary, env-flag-gated separation** — new `tutorials-cron` MTA module reuses `path: gen/srv`. One-line guard `if (process.env.ENABLE_CRON === 'true') registerJobs()`. `JobLocks` covers correctness at the LOCK level, but each job must `acquireLock()` BEFORE non-idempotent side effects (email send, GitHub dispatch). **Pre-flight: audit all 16 `srv/jobs/*.js` files for acquire-then-side-effect ordering.** Not a codebase split. | 1-2 days (longer if audit surfaces non-idempotent ordering) |
| 4 | **WebSocket sticky sessions** | Socket.IO transport in `tutorials-srv` requires sticky sessions at N>1 srv | Three options: (a) approuter sticky-session config, (b) Socket.IO Redis adapter, (c) pin srv to 1 and only scale srv if WebSocket is removed (last resort). | 1-3 days |
| 5 | **Per-instance in-memory caches** (content BLOBs, advocate photos, alerts, admin docs, generic TTL) | Multiple module-level caches across `srv/lib/` each hold per-instance state: `srv/lib/content-store.js` (50MB BLOB LRU), `srv/lib/advocate-photo-store.js` (bounded photo LRU), `srv/lib/alerts-cache.js` (60s TTL — alerts freshness budget per CLAUDE.md), `srv/lib/admin-docs-index.js` (module-level `_cache`), `srv/lib/ttl-cache.js` + `srv/lib/khoros-cache.js` (generic helpers). At N>1 srv each instance has its own copy → 2× memory, cold cache on each new instance, AND inconsistent TTL behavior (a 60s alerts TTL becomes "up to 60s per instance, observed inconsistently"). | At-scale fix: shared Redis or accept 2-3× memory per added instance. For our traffic profile probably acceptable until 4+ srv instances. Audit each cache for "inconsistency tolerable?" — alerts and admin-docs are tolerable; advocate photos and content BLOBs are bounded memory; nothing in this list breaks correctness. | Decision deferred to post-#2 |
| 6 | **Content publish race** | `POST /content/publish` at N>1 srv could race concurrent publishes | Transaction-level advisory lock or `UPDATE ... WHERE version = $expected` optimistic concurrency. | 2-3 days |
| 7 | **HANA connection pool** | `@sap/hana-client` defaults; not tuned for high concurrency | Document settings + levers (`max`, `min`, `idleTimeoutMillis`); runtime probe in `/health/db`. | 1-2 days |
| 8 | **Sequence generators** (`legacyId`) | `srv/lib/legacy-id.js` uses HANA sequence — already cluster-safe | No-op. Documented as "already scales." | 0 |
| 9 | **YouTube / Discovery / blog fetchers** | Quota-bound external APIs; one fetch per cron tick today | Already correctly placed in cron, moves with #3. Add fetcher-side per-tick caching. | Within #3 |
| 10 | **Hugo build pipeline** | Runs in GitHub Actions, not on CF | Documentation-only. Build is the bottleneck for "how fast does an edit appear" but unrelated to runtime scaling. | 0 |
| 11 | **Akamai CDN / caching strategy** | No CDN today; HANA-served BLOBs via approuter with `Cache-Control` headers | Forward-looking: when traffic justifies it, add Akamai or CloudFront in front of approuter. | Doc + cost model |
| 12 | **Database read replicas** | Single HANA instance handles read + write | HANA Cloud read replicas via BTP plan upgrade. Connection-string-aware routing in CDS. | Plan upgrade + routing config |
| 13 | **Audit-log service throughput** | `@cap-js/audit-logging` writes synchronously through the `tutorials-audit-log` managed-service binding (`mta.yaml:264`). At N>1 srv all instances compete for the same audit-log service quota | Document the per-second cap and add a `/health/audit-log` probe that reports recent emit-rate vs quota. Async-emit upgrade is a future-future option if we hit the cap, but our current emit volume is low (SecurityEvent on anonymize, secret reads, seed jobs). | 1-2 days (doc + probe) |
| 14 | **AI Core quota** (chat, embeddings, code-check, AI-authored quizzes) | All AI Core calls funnel through a single service binding with a shared quota. At N>1 srv each instance independently retries on rate-limit, multiplying quota burn. Cron jobs (embedding-reconciliation, AI-authored quizzes seed) compound | Cluster-aware retry: switch retry-counter from in-process memory to a HANA-backed `AiCoreRetryBuckets` entity. Lower priority — current quota is generous and we'd need 4-5× srv instances before this bites. | 2-3 days |
| 15 | **Credstore round-trips on cold start** | Every srv instance decrypts secrets from credstore on boot. At N>1 srv with frequent scale-up/down, cold-start quota usage multiplies | Probably fine — credstore is sized for high read throughput. Document as "fine" with a watch-out if we ever hit >10 cold starts/min sustained. | 0 (documented only) |

## Per-row prose

### Row #1 — AppRouter auto-scaling (shipped in #749)

The AppRouter is the front door for every request hitting the platform. It terminates TLS, validates XSUAA cookies, rewrites routes, forwards to srv. It holds no server-side session state — XSUAA tokens are cookie-based and survive instance-hopping. Static assets are read from disk, which is per-instance but identical across instances after the MTA deploy.

**Phase-1 (this issue's #749 PR):** `mta.yaml` and `.deploy/mta.yaml` get a `tutorials-autoscaler` managed-service resource. The autoscaler is bound to the `tutorials-approuter` module with an inline policy under `requires[*].parameters.config`. Range `1..4`, scale up at CPU≥70% for 2 min, scale down at CPU<30% for 5 min. Memory metric not included — approuter is CPU-bound.

**Future-future:** if the 4-instance ceiling is ever hit sustained, raise to `instance_max_count: 8` (no other change needed). Watch for: TLS handshake latency at >8 instances (CF Router becomes the bottleneck before the app does).

### Row #2 — Rate limiters (next priority after #749)

Three in-process Maps in `tutorials-srv` keep per-IP / per-user counters. At N>1 srv instances, the effective ceiling becomes N× the configured limit because each instance has its own counter. Already documented in detail at [mta-deployment.md § Scaling Constraints](../operations/mta-deployment.md#scaling-constraints).

The HANA-backed `RateLimitBuckets` entity is the right replacement — reuses existing HANA binding, no new managed service needed. Schema sketch:

```cds
entity RateLimitBuckets : cuid {
  bucketKey : String(200) @assert.unique;  // e.g. "feedback:1.2.3.4:2026-06-29T15"
  hits      : Integer default 0;
  expiresAt : Timestamp;
}
```

Per-request: `SELECT … FOR UPDATE` → check / increment / unlock. Daily cleanup cron deletes expired rows.

### Row #3 — Cron separation (post-#2 priority)

The current `srv/jobs/scheduler.js` registers ~25 cron jobs that all run inside the `tutorials-srv` process. Most call `runWithLock(jobName, durationMs, fn)` which uses `srv/jobs/job-lock.js` → HANA `JobLocks` table. The lock primitive itself is cluster-safe.

The split: a new `tutorials-cron` module in `mta.yaml` reuses `path: gen/srv` (same deployed bundle as `tutorials-srv`), with `ENABLE_CRON: 'true'` in its properties. The web module gets `ENABLE_CRON: 'false'`. `srv/server.js` gains a one-line guard around `registerJobs()`.

**Pre-flight audit (mandatory before splitting):** walk `srv/jobs/*.js` (16 files) and confirm every job calls `acquireLock()` BEFORE any non-idempotent side effect. The `instances: 1` pin masks any acquire-after-side-effect ordering today. Once split, two instances of the same code (web + cron) both register schedulers — if `ENABLE_CRON` is mis-set or both happen to be true, the lock catches duplicates, but only if the lock acquisition runs before the side effect. Skip the audit and risk double-sends on email, double-dispatches on GitHub rebuild triggers, etc.

### Row #4 — WebSocket sticky sessions

`tutorials-srv` uses Socket.IO via `@cap-js-community/websocket`. The `DisplayService` and `EventStreamService` emit CDS events to clients on the `/ws/display` and `/ws/event-stream` namespaces. At N>1 srv, a client's WebSocket connection lands on one instance and must STAY on that instance — Socket.IO state lives in process memory.

The three fix options:
- **(a) Approuter sticky-session config.** Cheapest. Approuter routes the same client (by cookie or source IP) to the same backend instance. Risk: harder to balance load if a few users have long-lived display sessions.
- **(b) Socket.IO Redis adapter.** Textbook. Bind a BTP managed Redis service; configure `@socket.io/redis-adapter`. State shared across instances. Best architecturally; adds a service dependency for one feature.
- **(c) Pin srv to 1.** Last resort. Acceptable until WebSocket traffic is a meaningful share of overall load.

### Row #5 — Per-instance in-memory caches

Six caches across `srv/lib/`:

- `content-store.js` — 50MB LRU of decompressed tutorial HTML. At N=2, 100MB memory. Cold cache on each new instance = first request per slug per instance hits HANA. Acceptable.
- `advocate-photo-store.js` — bounded LRU of WebP photos. Same pattern, smaller memory.
- `alerts-cache.js` — 60s TTL. CLAUDE.md explicitly says "up-to-60 s delay between admin save and visitor seeing the new state is expected." At N=2 instances, that becomes "up to 60s per instance, observed inconsistently" — a visitor might see the new alert on instance 1 but the old state on instance 2 for up to 60s. Probably tolerable for alerts.
- `admin-docs-index.js` — module-level `_cache`. Read-only at runtime; staleness only at deploy boundary.
- `ttl-cache.js` / `khoros-cache.js` — generic helpers used by several modules.

None of these break correctness at N>1. The decision when to fix is bounded by memory cost (predictable: 2-3× per added instance) and TTL inconsistency tolerance.

### Row #6 — Content publish race

`POST /content/publish` reads the current `ContentManifest` version, computes the next version, inserts the new manifest + content rows in a transaction. At N=1 srv this is serialized by `instances: 1`. At N>1, two concurrent publishes could both read version=42, both compute version=43, both insert — last write wins, and the loser's content rows are orphaned.

Fix options: (a) transaction-level advisory lock on a known key, (b) `UPDATE ContentManifest SET ... WHERE version = $expected` optimistic concurrency with retry. (b) is cleaner.

The risk window is narrow — publishes are admin-triggered, not user-driven — but the fix is small enough to be worth doing when row #2 lands.

### Row #7 — HANA connection pool

`@sap/hana-client` has its own pool with configurable `max` / `min` / `idleTimeoutMillis`. At high concurrency, pool exhaustion shows up as "Connection acquire timeout" errors. We haven't tuned this for our workload yet.

Two actions: (a) document the current defaults and the levers in [mta-deployment.md § Scaling Constraints](../operations/mta-deployment.md#scaling-constraints); (b) add a runtime probe in `/health/db` that reports pool size, idle, active, queued — so dashboards can surface exhaustion before users see errors.

### Row #8 — Sequence generators (already scales)

`srv/lib/legacy-id.js` uses a HANA sequence (`CREATE SEQUENCE` + `seq.NEXTVAL`). Cluster-safe by HANA semantics. Documented as "already scales."

### Row #9 — External-API fetcher quota

YouTube Data API, BTP Discovery Center, blog-post fetchers all run in cron. They live in `srv/jobs/fetch-*-job.js`. Once row #3 separates cron, these naturally move with it. Each fetcher should add per-tick caching (avoid double-billing across cron cycles).

### Row #10 — Hugo build pipeline (already scales)

Runs in GitHub Actions, separate from CF. Wall-clock bounds (~10 min full rebuild) are the bottleneck for "how fast does an edit appear" but unrelated to runtime scaling.

### Row #11 — Akamai CDN / caching strategy

Forward-looking. Today tutorial HTML is served from HANA via approuter with `Cache-Control` headers. Akamai (or CloudFront) in front of approuter would cut HANA load substantially for the high-traffic public read path.

Decision deferred until we measure real cache-hit ratios under production traffic. A back-of-envelope cost model belongs in the future Akamai PR's spec.

### Row #12 — Database read replicas

HANA Cloud supports read replicas via BTP service plan upgrade. CDS-level read-write routing would need to bind two HDI containers (primary read-write, replica read-only) and route reads to the replica. Defer until HANA CPU becomes a measurable constraint.

### Row #13 — Audit-log service throughput

`@cap-js/audit-logging` writes synchronously via the `tutorials-audit-log` managed-service binding (`mta.yaml:264`). Our audit-log emit volume is low today — `SecurityEvent` on `anonymize`, secret reads, seed jobs. Worth documenting the per-second cap (BTP audit-log standard plan: ~100 events/sec per instance) and adding a runtime probe.

If we ever hit the cap, async-emit is the upgrade path — buffer events, batch-write. Out of scope for the moment.

### Row #14 — AI Core quota

AI Core calls (Joule chat, embedding generation, code-check, AI-authored quizzes) share a single binding's quota. At N>1 srv, each instance maintains its own retry-counter for rate-limited responses. Two instances both retrying the same throttled call burn quota faster than needed.

The fix: move the retry-counter to a HANA-backed `AiCoreRetryBuckets` entity. Lower priority — current quota is generous and we'd need 4-5× srv instances before this bites.

### Row #15 — Credstore round-trips on cold start

Every srv instance decrypts secrets on boot via the `tutorials-credstore` binding. At N>1 srv with frequent scale-up/down, cold-start quota usage multiplies. Probably fine — credstore is sized for high read throughput. Watch-out if we ever hit >10 cold starts/min sustained.

---

**Last updated:** 2026-06-29 (#749 PR). When you crack off a row, update its status here and link to the implementing PR.
