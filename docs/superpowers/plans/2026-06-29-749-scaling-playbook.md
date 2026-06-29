# Issue #749 — Scaling Playbook + Phase-1 AppRouter Auto-scaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the scaling playbook (forward-looking doc covering 15 constraints) and the phase-1 implementation (AppRouter CF Autoscaler binding, deploy-config-only).

**Architecture:** Two deliverables in one PR. (1) A new architecture doc at `docs/developers/architecture/scaling-playbook.md` enumerating every known scaling constraint with current state, what breaks under load, fix path, effort, and dependencies. (2) `mta.yaml` + `.deploy/mta.yaml` gain a `tutorials-autoscaler` managed-service resource and an inline `requires[*].parameters.config` policy on the `tutorials-approuter` module. Zero code change.

**Tech Stack:** MTA descriptor YAML, VitePress doc, CF Autoscaler service binding.

**Spec:** [`docs/superpowers/specs/2026-06-29-749-scaling-playbook-design.md`](../specs/2026-06-29-749-scaling-playbook-design.md)

---

## File Structure

### Created files (1)

- `docs/developers/architecture/scaling-playbook.md` — the playbook doc. 15-row table + per-row prose sections + recommended sequence.

### Modified files (3)

- `mta.yaml` — add `instances: 1` parameter + `tutorials-autoscaler` requires (with inline policy under `parameters.config`) to the `tutorials-approuter` module; append a new `tutorials-autoscaler` resource block at the end of `resources:`.
- `.deploy/mta.yaml` — identical change in the standalone-approuter variant.
- `docs/.vitepress/config.ts` — register the new playbook page in `themeConfig.sidebar` under the architecture section.
- `docs/developers/operations/mta-deployment.md` — one-line cross-link at the top of the "Scaling Constraints" section pointing to the new playbook.

### NOT modified

- No code under `srv/`, `app/`, `db/`, `hugo/`, or `scripts/` is touched. AppRouter is already stateless (XSUAA cookies). The phase-1 change is deploy-config only.

---

## Task 1: Write the scaling playbook doc

**Files:**
- Create: `docs/developers/architecture/scaling-playbook.md`

This task produces the largest single deliverable — a long-lived reference doc that documents 15 scaling constraints. The full content is below; copy it verbatim into the new file.

- [ ] **Step 1: Create the doc file**

Create `docs/developers/architecture/scaling-playbook.md` with the contents below.

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/developers/architecture/scaling-playbook.md
git -c core.autocrlf=false commit -m "docs(#749): add scaling playbook

Forward-looking architecture doc enumerating 15 known scaling
constraints. For each: current pin, what breaks at N>1 or under
load, fix path, rough effort, dependencies on other rows.

Recommended sequence: #1 AppRouter auto-scaling (this PR) → #3
cron separation → #2 rate limiters → #4 WebSocket sticky → others
as traffic forces. Covers ~5x current traffic without bigger Redis
or read-replica work.

This doc is the long-lived reference; subsequent scaling PRs each
crack off one row and update the table's status."
```

---

## Task 2: Register the playbook in the VitePress sidebar

**Files:**
- Modify: `docs/.vitepress/config.ts` (around lines 120-137 — the `themeConfig.sidebar` architecture section)

The `predocs:build` script runs `node scripts/check-docs-sidebar.cjs` which fails the build if a `docs/developers/architecture/*.md` file isn't registered in the sidebar. We register the new doc immediately, before running any docs build.

- [ ] **Step 1: Locate the architecture sidebar block**

Run:
```bash
cd D:/projects/tutorials-poc/.claude/worktrees/749-scaling-playbook
sed -n '115,140p' docs/.vitepress/config.ts
```

Expected: shows a block with entries like `{ text: 'Authentication and authorization', link: '/developers/architecture/authentication' }`. The block is a JS array of objects.

- [ ] **Step 2: Add the playbook entry**

The architecture items are alphabetized by `text`. Locate the closest neighbor — `Scaling playbook` should sit between whatever comes alphabetically before and after it. Most likely position: between `'Joule aurora background'` (line ~128) and the next item.

Insert (with the same indentation as siblings):

```ts
          { text: 'Scaling playbook',                link: '/developers/architecture/scaling-playbook' },
```

Match the existing column alignment of `link:` if there's a column-align convention in the file (the surrounding lines use a fixed column for `link:`).

- [ ] **Step 3: Verify the sidebar guard passes**

Run:
```bash
node scripts/check-docs-sidebar.cjs 2>&1 | tail -10
```

Expected: zero "unregistered file" or "dead link" errors. If it complains the file isn't found, the link path was wrong; if it complains the file is unregistered, the entry didn't land in the right block.

- [ ] **Step 4: Optional — verify the docs build itself**

Run:
```bash
npm run docs:build 2>&1 | tail -10
```

Expected: VitePress build succeeds (creates `docs/.vitepress/dist/`). Slow (~30s). Skip if Step 3 passes.

- [ ] **Step 5: Commit**

```bash
git add docs/.vitepress/config.ts
git -c core.autocrlf=false commit -m "docs(#749): register scaling-playbook in VitePress sidebar

The predocs:build sidebar guard (scripts/check-docs-sidebar.cjs)
fails the build if a docs/developers/architecture/*.md file isn't
registered. Adding the entry under the architecture section."
```

---

## Task 3: Cross-link from mta-deployment.md to the new playbook

**Files:**
- Modify: `docs/developers/operations/mta-deployment.md` (the "Scaling Constraints" section header, ~line 150)

Per spec §7, the existing narrow rate-limiter doc gets a one-line pointer to the new broader playbook.

- [ ] **Step 1: Locate the existing section header**

Run:
```bash
grep -n "^## Scaling Constraints" docs/developers/operations/mta-deployment.md
```

Expected: one match around line 150.

- [ ] **Step 2: Edit the file**

Find:
```markdown
## Scaling Constraints

**`tutorials-srv` is pinned to `instances: 1` in both `mta.yaml` and `.deploy/mta.yaml`. Do not raise this without first replacing the in-process rate limiters with a shared store.**
```

Change to:
```markdown
## Scaling Constraints

> **Broader context:** [`docs/developers/architecture/scaling-playbook.md`](../architecture/scaling-playbook.md). This section covers only the three in-process rate limiters (playbook row #2).

**`tutorials-srv` is pinned to `instances: 1` in both `mta.yaml` and `.deploy/mta.yaml`. Do not raise this without first replacing the in-process rate limiters with a shared store.**
```

- [ ] **Step 3: Commit**

```bash
git add docs/developers/operations/mta-deployment.md
git -c core.autocrlf=false commit -m "docs(#749): cross-link mta-deployment to scaling-playbook

The narrow rate-limiter section already lives here; the broader
playbook now exists at architecture/scaling-playbook.md. Anyone
arriving at the rate-limiter doc finds the broader context."
```

---

## Task 4: Add the Autoscaler resource + binding to `mta.yaml`

**Files:**
- Modify: `mta.yaml` (approuter module's `parameters` + `requires` blocks ~lines 186-228; `resources:` section tail ~line 303+)

Two surgical changes:

- [ ] **Step 1: Confirm the current state**

Run:
```bash
grep -n "tutorials-approuter\|tutorials-credstore" mta.yaml | head -5
```

Expected: `tutorials-approuter` declared at line ~186, `tutorials-credstore` at line ~303 (the last resource in the file).

- [ ] **Step 2: Add `instances: 1` to the approuter parameters**

Locate the `tutorials-approuter` parameters block (~lines 193-197):

```yaml
    parameters:
      disk-quota: 2048M
      memory: 512M
      app-name: tutorials-approuter
```

Add `instances: 1` as a new line:

```yaml
    parameters:
      disk-quota: 2048M
      memory: 512M
      app-name: tutorials-approuter
      instances: 1                  # Lower bound; Autoscaler manages up to instance_max_count via binding-level config in requires below (#749)
```

- [ ] **Step 3: Add the autoscaler `requires` entry with inline policy**

Locate the approuter's `requires:` block (~line 217). The last entry currently is:

```yaml
      - name: srv-qa-api
        group: destinations
        properties:
          name: srv-qa-api
          url: ~{srv-url}
          forwardAuthToken: true
```

Append a new requires entry IMMEDIATELY after that block (still inside the approuter module's `requires:` list):

```yaml
      # CF Autoscaler binding (#749 phase-1). Policy is inlined here per
      # SAP BTP convention — putting it on the resource block via path: is
      # silently ignored. Range 1..4, CPU 70% / 30% thresholds. Memory metric
      # not included — approuter is CPU-bound. See scaling-playbook.md row #1.
      - name: tutorials-autoscaler
        parameters:
          config:
            instance_min_count: 1
            instance_max_count: 4
            scaling_rules:
              - metric_type: cpu
                threshold: 70
                operator: ">="
                adjustment: "+1"
                breach_duration_secs: 120
                cool_down_secs: 180
              - metric_type: cpu
                threshold: 30
                operator: "<"
                adjustment: "-1"
                breach_duration_secs: 300
                cool_down_secs: 300
```

Match the existing indentation (6 spaces before `-` for top-level requires entries).

- [ ] **Step 4: Append the `tutorials-autoscaler` resource at the end of `resources:`**

The current last resource is `tutorials-credstore`. Append:

```yaml

  # CF Application Autoscaler (#749 phase-1). Binds to tutorials-approuter
  # with policy inlined at the requires block above. The resource declares
  # ONLY service + plan; policy lives at the binding level. Pre-deploy guard:
  # `cf marketplace | grep -iE 'autoscaler'` must return ≥1 plan.
  - name: tutorials-autoscaler
    type: org.cloudfoundry.managed-service
    parameters:
      service: autoscaler
      service-plan: standard
      service-name: tutorials-autoscaler
```

Use `service: autoscaler` as the placeholder. If `cf marketplace | grep -iE 'autoscaler'` on the target subaccount returns only `application-autoscaler`, switch the value.

- [ ] **Step 5: YAML validity check**

Run:
```bash
node -e "const yaml=require('yaml'); const m=yaml.parse(require('fs').readFileSync('mta.yaml','utf8')); console.log('OK', m.modules.length, 'modules,', m.resources.length, 'resources')"
```

Expected: `OK 5 modules, 12 resources` (or similar — the resource count goes up by 1 from the prior baseline).

- [ ] **Step 6: Spot-check the autoscaler is wired correctly**

Run:
```bash
node -e "
const yaml = require('yaml');
const m = yaml.parse(require('fs').readFileSync('mta.yaml','utf8'));
const approuter = m.modules.find(x => x.name === 'tutorials-approuter');
const requiresAuto = approuter.requires.find(r => r.name === 'tutorials-autoscaler');
console.log('approuter.parameters.instances:', approuter.parameters.instances);
console.log('autoscaler binding config min:', requiresAuto?.parameters?.config?.instance_min_count);
console.log('autoscaler binding config max:', requiresAuto?.parameters?.config?.instance_max_count);
console.log('autoscaler binding config rules:', requiresAuto?.parameters?.config?.scaling_rules?.length);
const autoRes = m.resources.find(r => r.name === 'tutorials-autoscaler');
console.log('autoscaler resource service:', autoRes?.parameters?.service);
console.log('autoscaler resource plan:', autoRes?.parameters?.['service-plan']);
"
```

Expected:
```
approuter.parameters.instances: 1
autoscaler binding config min: 1
autoscaler binding config max: 4
autoscaler binding config rules: 2
autoscaler resource service: autoscaler
autoscaler resource plan: standard
```

- [ ] **Step 7: Commit**

```bash
git add mta.yaml
git -c core.autocrlf=false commit -m "feat(#749): add CF Autoscaler binding to tutorials-approuter (mta.yaml)

Phase-1 of the scaling playbook (row #1). Approuter is already
stateless (XSUAA cookie-based), so this is a deploy-config-only
change. Range 1..4, CPU 70% / 30% thresholds.

The autoscaler policy is INLINED under requires[*].parameters.config
on the tutorials-approuter module — the SAP BTP convention. Putting
the policy on the resource block via path: would be silently ignored
and result in a binding with no scaling rules (verified during spec
review).

Zero code change anywhere. AppRouter scales horizontally on its own
under sustained CPU load."
```

---

## Task 5: Apply the same change to `.deploy/mta.yaml`

**Files:**
- Modify: `.deploy/mta.yaml` (approuter module + `resources:` tail)

The standalone-approuter MTA variant needs symmetric changes. Same shape as Task 4, just different file.

- [ ] **Step 1: Locate the approuter + last resource**

Run:
```bash
grep -n "tutorials-approuter\|tutorials-credstore\|^resources:" .deploy/mta.yaml | head -10
```

Expected: `tutorials-approuter` module at line ~139, `tutorials-credstore` or similar last resource near the end of the file.

- [ ] **Step 2: Add `instances: 1` to the approuter parameters**

Locate the `tutorials-approuter` parameters block. The existing parameters are similar to `mta.yaml`'s. Add `instances: 1` matching the same shape as Task 4 Step 2.

- [ ] **Step 3: Add the autoscaler `requires` entry**

Locate the approuter's `requires:` block. Append the same `tutorials-autoscaler` block (with inline policy) as in Task 4 Step 3 — VERBATIM, including the comment block. This intentional duplication of ~20 lines between the two mta files is acknowledged in the spec (§2.3).

- [ ] **Step 4: Append the `tutorials-autoscaler` resource**

At the end of the `resources:` section, append the same `tutorials-autoscaler` resource block as in Task 4 Step 4.

- [ ] **Step 5: YAML validity check**

Run:
```bash
node -e "const yaml=require('yaml'); const m=yaml.parse(require('fs').readFileSync('.deploy/mta.yaml','utf8')); console.log('OK', m.modules.length, 'modules,', m.resources.length, 'resources')"
```

Expected: `OK` with a resource count one higher than the baseline.

- [ ] **Step 6: Spot-check (same shape as Task 4 Step 6, file path adjusted)**

Run:
```bash
node -e "
const yaml = require('yaml');
const m = yaml.parse(require('fs').readFileSync('.deploy/mta.yaml','utf8'));
const approuter = m.modules.find(x => x.name === 'tutorials-approuter');
const requiresAuto = approuter.requires.find(r => r.name === 'tutorials-autoscaler');
console.log('approuter.parameters.instances:', approuter.parameters.instances);
console.log('autoscaler binding config min:', requiresAuto?.parameters?.config?.instance_min_count);
console.log('autoscaler binding config max:', requiresAuto?.parameters?.config?.instance_max_count);
console.log('autoscaler binding config rules:', requiresAuto?.parameters?.config?.scaling_rules?.length);
const autoRes = m.resources.find(r => r.name === 'tutorials-autoscaler');
console.log('autoscaler resource service:', autoRes?.parameters?.service);
console.log('autoscaler resource plan:', autoRes?.parameters?.['service-plan']);
"
```

Expected: same output as Task 4 Step 6.

- [ ] **Step 7: Commit**

```bash
git add .deploy/mta.yaml
git -c core.autocrlf=false commit -m "feat(#749): add CF Autoscaler binding to tutorials-approuter (.deploy/mta.yaml)

Symmetric change to the standalone-approuter MTA variant. Same
inline policy as mta.yaml — the ~20-line duplication is intentional
(MTA spec doesn't support yaml-anchor sharing across files cleanly).
A future refactor could extract via mtaext; out of scope here."
```

---

## Task 6: Verify CI green

**Files:** none

- [ ] **Step 1: Push the branch**

```bash
git push -u origin 749-scaling-playbook
```

- [ ] **Step 2: Write the PR body file**

```bash
cat > PR_BODY.md << 'PR_BODY_EOF'
Closes #749.

## What

Two deliverables in one PR:

1. **A new architecture doc** at [`docs/developers/architecture/scaling-playbook.md`](docs/developers/architecture/scaling-playbook.md) enumerating 15 scaling constraints with current state, what breaks at N>1 / under load, fix path, rough effort, and dependencies on other rows.

2. **Phase-1 implementation:** AppRouter CF Autoscaler binding. `mta.yaml` and `.deploy/mta.yaml` gain a `tutorials-autoscaler` managed-service resource and an inline policy on the `tutorials-approuter` module. Range 1..4, CPU 70% / 30% thresholds. Zero code change.

## Spec & plan

- Spec: [docs/superpowers/specs/2026-06-29-749-scaling-playbook-design.md](docs/superpowers/specs/2026-06-29-749-scaling-playbook-design.md)
- Plan: [docs/superpowers/plans/2026-06-29-749-scaling-playbook.md](docs/superpowers/plans/2026-06-29-749-scaling-playbook.md)

## Why phase-1 is just AppRouter

The 15 playbook rows fall into three buckets:

- **Already scales** (no work) — sequence generators, Hugo build pipeline, AppRouter sessions after this PR.
- **Bounded effort, well-understood fix** — rate limiters, cron separation, content publish race, HANA pool tuning.
- **Bigger architectural moves** — WebSocket sticky/Redis, BLOB LRU sharing, Akamai/CDN, HANA read replicas.

The recommended sequence: #1 AppRouter (this PR) → #3 cron separation → #2 rate limiters → #4 WebSocket sticky → others as traffic forces. That covers ~5x current traffic without taking on the bigger Redis/replica work.

## How the autoscaler is wired

Policy is INLINED under `requires[*].parameters.config` on the `tutorials-approuter` module. The resource block at the bottom of `resources:` declares only `service: autoscaler` / `service-plan: standard`. **Do not put the policy on the resource block via `path:` — that's silently ignored by SAP BTP Autoscaler and results in a binding with no scaling rules.**

## Tests

No unit tests. No smoke tests. Deploy-config + documentation only.

Pre-deploy guards (run by the deploy task in Task 7, NOT by CI):

- `cf marketplace | grep -iE 'autoscaler'` returns ≥1 plan (service name + entitlement check).
- `mbt build` succeeds (YAML descriptor validation).

CI verifies: VitePress build passes (the sidebar guard); markdown links resolve (predocs:build dead-link checker).

## Rollback

`git revert` + redeploy. Reverts re-pin AppRouter to `instances: 1` implicit and drops the autoscaler binding. No data migration, no schema change.

## Manual smoke after deploy

1. `cf scaling-policy tutorials-approuter` — should report the inline policy (min=1, max=4, two CPU rules).
2. `cf events tutorials-approuter` — Autoscaler service binding event present.
3. Synthetic load: `hyperfine` or `k6` against `/` for 2 min sustained → CPU climbs.
4. `cf app tutorials-approuter` — instance count rises as CPU crosses 70%.
5. After load stops + 5 min cool-down — instance count returns to 1.
PR_BODY_EOF
```

Verify:
```bash
ls -l PR_BODY.md && wc -l PR_BODY.md
```

Expected: non-empty file with ~50 lines.

- [ ] **Step 3: Create the PR**

```bash
gh pr create --base main --head 749-scaling-playbook \
  --title "feat(#749): scaling playbook + phase-1 AppRouter auto-scaling" \
  --body-file ./PR_BODY.md
```

- [ ] **Step 4: Remove the body file (do NOT commit it)**

```bash
rm PR_BODY.md
```

- [ ] **Step 5: Verify CI green**

Watch the standard CI run. Expected: green. VitePress build is the only meaningful check (sidebar guard + dead-link checker). MTA `mbt build` is NOT in CI today — it runs only at deploy time.

If anything fails, address before merging.

---

## Task 7: Post-merge deploy + verify

After PR merge, deploy from `main` in the primary tree (per memory [[feedback_always_deploy_from_main_primary_tree]]).

**This task only runs after Tom explicitly signals he wants the deploy** (memory [[feedback_merge_confirmation_not_deploy_authorization]] / [[feedback_confirm_deploy_scope]]).

- [ ] **Step 1: Confirm deploy scope with Tom**

Ask: "Ready to deploy #749 to DEV? Scope is approuter MTA descriptor only (autoscaler binding + inline policy) — no schema, no srv-runtime, no DB. Anything else queued I should bundle in?" Wait for explicit yes.

- [ ] **Step 2: Confirm the autoscaler service is entitled in the target subaccount**

Run:
```bash
cf marketplace | grep -iE 'autoscaler'
```

Expected: at least one line. Record the exact service name (`autoscaler` or `application-autoscaler` — they vary by region). If the placeholder in `mta.yaml` differs from what `cf marketplace` reports, edit `mta.yaml` + `.deploy/mta.yaml` to match and re-commit (don't deploy with a mismatched service name).

If the grep returns nothing, autoscaler isn't entitled in this subaccount — surface to BTP admin team and STOP. Do not deploy.

- [ ] **Step 3: Switch to primary tree, pull main**

```bash
cd D:/projects/tutorials-poc
git checkout main
git pull --ff-only origin main
```

- [ ] **Step 4: Verify CF target**

```bash
cf target
```

Expected: DEV space. If wrong, surface and STOP.

- [ ] **Step 5: Resolve mtaext placeholders BEFORE `cf deploy`**

Per CLAUDE.md's "Local manual deploy" instruction and memory [[feedback_mtaext_envsubst_empty_quote_required]]:

```bash
cd D:/projects/tutorials-poc
test -n "$CONTENT_API_KEY" || { echo "ERROR: CONTENT_API_KEY not set"; exit 1; }
test -n "$REBUILD_API_KEY" || { echo "ERROR: REBUILD_API_KEY not set"; exit 1; }
test -n "$APPROUTER_URL"   || { echo "ERROR: APPROUTER_URL not set"; exit 1; }
test -n "$GITHUB_DISPATCH_TOKEN" || { echo "ERROR: GITHUB_DISPATCH_TOKEN not set"; exit 1; }

envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
  < deploy/dev.mtaext > deploy/dev.resolved.mtaext

grep -E '\$\{?[A-Z_]+\}?' deploy/dev.resolved.mtaext && \
  { echo "ERROR: unresolved placeholder"; exit 1; } || \
  echo "OK: all placeholders resolved"
```

- [ ] **Step 6: Build + deploy**

```bash
cd D:/projects/tutorials-poc
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f
```

- [ ] **Step 7: Verify autoscaler binding + policy**

```bash
cf scaling-policy tutorials-approuter
```

Expected: shows `instance_min_count: 1`, `instance_max_count: 4`, two scaling rules (CPU>=70 +1, CPU<30 -1). If the command returns "no policy" or "service binding not found", the inline-config wiring is wrong — surface to Tom, do NOT proceed.

```bash
cf events tutorials-approuter | head -10
```

Expected: a recent `audit.service.binding.create` event for `tutorials-autoscaler`.

- [ ] **Step 8: Probe AppRouter health**

```bash
curl -s https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ -o /dev/null -w "homepage status=%{http_code}\n"
```

Expected: 200. The autoscaler binding doesn't disrupt the routing.

- [ ] **Step 9: Optional — synthetic-load smoke**

If Tom wants to verify scaling actually fires, generate sustained load and watch:

```bash
# in one shell:
hyperfine --warmup 3 --runs 50 'curl -s https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/'

# in another, watch:
watch -n 5 'cf app tutorials-approuter | grep -E "instances|state"'
```

Expected: under load, CPU climbs, instance count rises after ~2 min sustained ≥70%. After load stops + 5 min cool-down, drops back to 1.

This step is optional — the autoscaler's correctness is verified by Step 7's policy report; the synthetic-load test only confirms the policy's threshold tuning is reasonable.

- [ ] **Step 10: No commit (deploy step)**

---

## Notes / hazards

- **Inline policy vs. resource path.** The single most important detail in this PR. The policy MUST live under `requires[*].parameters.config` on the `tutorials-approuter` module, not on the autoscaler resource block via `path:`. Wrong placement = silent no-op binding. Verified in spec review (iteration 1).
- **Service-name regional drift.** Pre-deploy `cf marketplace | grep -iE 'autoscaler'` is mandatory. Two known SAP BTP names: `autoscaler` (more common) and `application-autoscaler` (some regions). Mismatched name = deploy fails at MTA validation.
- **The two mta.yaml files duplicate ~20 lines.** Intentional. Out of scope to deduplicate; flagged in spec §2.3.
- **CRLF on Windows.** All commits use `git -c core.autocrlf=false commit` per memory [[feedback_crlf_regression_on_windows]].
- **Work in the worktree; deploy from primary tree.** Tasks 1-6 in `D:/projects/tutorials-poc/.claude/worktrees/749-scaling-playbook`; Task 7 in `D:/projects/tutorials-poc` against `main`.
- **No code change anywhere.** If you find yourself editing `srv/`, `app/`, `db/`, `hugo/`, or `scripts/`, stop — that's scope creep. This PR is config + doc only.
- **Don't crack off other playbook rows in this PR.** The doc describes the rest; future PRs each crack one row. Resist the urge to also wire `RateLimitBuckets` or split cron in this same PR.
