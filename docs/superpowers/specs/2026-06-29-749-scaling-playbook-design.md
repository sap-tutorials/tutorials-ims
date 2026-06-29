# Issue #749 — Scaling Playbook + Phase-1 AppRouter Auto-scaling

- **Status:** Approved (2026-06-29), pending spec-reviewer pass
- **Issue:** [#749](https://github.com/sap-tutorials/tutorials-ims/issues/749)
- **Related runbook section:** `docs/developers/operations/mta-deployment.md § Scaling Constraints` (narrow predecessor — covers only the three in-process rate limiters)

## Summary

The platform is pinned to `instances: 1` across both `tutorials-srv` and `tutorials-approuter`. The pin on srv is enforced by three documented in-process rate limiters; the pin on the approuter is implicit (no documented reason). As we approach taking over the full scope of developers.sap.com, we need to think forward about scaling — not as an immediate code change, but as a documented playbook so each future scaling PR has a known shape.

This spec produces two deliverables in one PR:

1. **A new architecture document** at `docs/developers/architecture/scaling-playbook.md`. Enumerates every known scaling constraint with current state, what breaks under load, fix path, effort estimate, and dependencies.
2. **Phase-1 implementation: AppRouter auto-scaling.** Deploy-config-only change to `mta.yaml` + `.deploy/mta.yaml` adding a CF Autoscaler service binding and an `instances: 1..4` range. Zero code change.

The doc is the long-lived artifact — future scaling PRs each crack off one row in the playbook and link back. Phase-1 is the safest immediate win because AppRouter is the front door and is already stateless (XSUAA cookie-based, no in-memory caches).

## Scope

### In scope

- New file `docs/developers/architecture/scaling-playbook.md` covering 12 scaling constraints (table + per-item prose).
- New file `deploy/autoscaler-policy.json` with a conservative starting policy (1..4 instances, CPU 70%/30% thresholds).
- Modify `mta.yaml`: add `instances: 1` lower bound to `tutorials-approuter`, declare a `tutorials-autoscaler` managed-service resource, add it to the approuter's `requires`.
- Modify `.deploy/mta.yaml`: same Autoscaler binding for the standalone-approuter variant.
- One-line cross-link from `docs/developers/operations/mta-deployment.md § Scaling Constraints` to the new playbook.

### Out of scope

- **`tutorials-srv` auto-scaling.** Blocked on the rate-limiter fix (playbook row #2). The existing comment on `mta.yaml:103-105` stays put.
- **Implementing any other playbook row.** Each row is its own follow-up PR. This PR ships only #1 (AppRouter auto-scaling).
- **Alerting on `instance_count == instance_max_count`.** Out of scope for this PR; flagged in playbook row #1's risks.
- **Akamai / CDN integration** (playbook row #11). Forward-looking, captured in doc, not implemented.
- **HANA read replicas** (playbook row #12). Same — captured, deferred.

## Approach

The phase-1 PR is intentionally tiny: deploy-config only, zero code risk, single deploy-time entitlement check. The playbook documents the rest so subsequent PRs have a known shape and don't need to re-derive the analysis.

The 12 playbook constraints fall into three buckets:

- **Already scales** (no work) — sequence generators, Hugo build pipeline, AppRouter sessions after this PR.
- **Bounded effort, well-understood fix** — rate limiters, cron separation, content publish race, HANA pool tuning.
- **Bigger architectural moves** — WebSocket sticky/Redis, BLOB LRU sharing, Akamai/CDN, HANA read replicas.

The recommended sequence (in the playbook) is: #1 AppRouter (this PR) → #3 cron separation (lowest residual risk) → #2 rate limiters (unlocks srv auto-scaling) → #4 WebSocket sticky (only if needed) → others as traffic forces.

## 1. Playbook contents

The 12 constraints documented in `scaling-playbook.md`. For each row, the doc captures: **current state**, **what breaks at N>1 / under load**, **fix path**, **rough effort**, **dependencies on other rows**.

| # | Constraint | Current pin | Fix | Effort |
|---|---|---|---|---|
| 1 | AppRouter sessions | `instances: 1` (deploy default) | **This PR** — CF Autoscaler + `instances: 1..4`. XSUAA cookie-based, stateless. | Hours |
| 2 | In-process rate limiters (feedback, search, chat) | Documented in `mta-deployment.md § Scaling Constraints` | HANA-backed `RateLimitBuckets` entity (the "option 2" already recommended). | 2-3 days |
| 3 | Scheduled cron jobs | All run inside `tutorials-srv` instance 0; safe-by-lock via `JobLocks` but couples web latency to cron load | **Same-binary, env-flag-gated separation** — new `tutorials-cron` MTA module reuses `path: gen/srv`. One-line guard `if (process.env.ENABLE_CRON === 'true') registerJobs()`. `JobLocks` already covers correctness. **Not a codebase split.** | 1-2 days |
| 4 | WebSocket sticky sessions | Socket.IO transport in `tutorials-srv` requires sticky sessions at N>1 srv | Three options: (a) approuter sticky-session config, (b) Socket.IO Redis adapter, (c) pin srv to 1 and only scale srv if WebSocket is removed (last resort). | 1-3 days |
| 5 | Content-store LRU cache | `srv/lib/content-store.js` holds a 50MB in-memory LRU per instance | At-scale fix: shared Redis or accept 2-3× memory per added instance (predictable). For our traffic profile probably acceptable until 4+ srv instances. | Decision deferred to post-#2 |
| 6 | Content publish race | `POST /content/publish` at N>1 srv could race concurrent publishes | Transaction-level advisory lock or `UPDATE ... WHERE version = $expected` optimistic concurrency. | 2-3 days |
| 7 | HANA connection pool | `@sap/hana-client` defaults; not tuned for high concurrency | Document settings + levers (`max`, `min`, `idleTimeoutMillis`); runtime probe in `/health/db`. | 1-2 days |
| 8 | Sequence generators (`legacyId`) | `srv/lib/legacy-id.js` uses HANA sequence — already cluster-safe | No-op. Document as "already scales." | 0 |
| 9 | YouTube / Discovery / blog fetchers | Quota-bound external APIs; one fetch per cron tick today | Already correctly placed in cron, moves with #3. Add fetcher-side per-tick caching. | Within #3 |
| 10 | Hugo build pipeline | Runs in GitHub Actions, not on CF | Documentation-only. Build is the bottleneck for "how fast does an edit appear" but unrelated to runtime scaling. | 0 |
| 11 | Akamai CDN / caching strategy | No CDN today; HANA-served BLOBs via approuter with `Cache-Control` headers | Forward-looking: when traffic justifies it, add Akamai or CloudFront in front of approuter. | Doc + cost model |
| 12 | Database read replicas | Single HANA instance handles read + write | HANA Cloud read replicas via BTP plan upgrade. Connection-string-aware routing in CDS. | Plan upgrade + routing config |

The doc's **"Recommended sequence"** section at the bottom orders #1 → #3 → #2 → #4 and notes that this sequence covers ~5x current traffic without the bigger Redis/replicas work.

## 2. Phase-1 implementation: AppRouter auto-scaling

### 2.1 Changes to `mta.yaml`

The `tutorials-approuter` module gains an explicit `instances: 1` lower bound and a new `requires` entry for the Autoscaler binding:

```yaml
- name: tutorials-approuter
  type: approuter.nodejs
  path: approuter
  parameters:
    disk-quota: 2048M
    memory: 512M
    app-name: tutorials-approuter
    instances: 1                  # NEW — explicit lower bound; Autoscaler manages the range up to instance_max_count in the policy
  requires:
    - name: tutorials-uaa
    - name: tutorials-srv-api
    - name: tutorials-autoscaler  # NEW — binds the autoscaler policy
    # ... other existing requires preserved verbatim
```

A new resource block at the bottom of `resources:`:

```yaml
- name: tutorials-autoscaler
  type: org.cloudfoundry.managed-service
  parameters:
    service: autoscaler
    service-plan: standard
    path: ./deploy/autoscaler-policy.json
```

### 2.2 Changes to `.deploy/mta.yaml`

Symmetric to `mta.yaml`: same `instances: 1` + `requires` change on `tutorials-approuter`, same `tutorials-autoscaler` resource block. The standalone-approuter MTA gets the same scaling treatment as the full MTA.

### 2.3 New file: `deploy/autoscaler-policy.json`

```json
{
  "instance_min_count": 1,
  "instance_max_count": 4,
  "scaling_rules": [
    {
      "metric_type": "cpu",
      "threshold": 70,
      "operator": ">=",
      "adjustment": "+1",
      "breach_duration_secs": 120,
      "cool_down_secs": 180
    },
    {
      "metric_type": "cpu",
      "threshold": 30,
      "operator": "<",
      "adjustment": "-1",
      "breach_duration_secs": 300,
      "cool_down_secs": 300
    }
  ]
}
```

**Policy rationale:**

- **Scale up:** CPU ≥ 70% for 2 minutes → +1 instance. Cool-down 180s.
- **Scale down:** CPU < 30% for 5 minutes → -1 instance. Cool-down 300s.
- **Range 1..4:** 4× headroom is enough for known traffic patterns + a buffer for unexpected spikes (e.g. SAP TechEd push). Tune after observing real production behavior.
- **Memory metric NOT included:** approuter is CPU-bound (TLS termination, route matching, header rewriting), not memory-bound.

### 2.4 NOT changed

| File | Why |
|---|---|
| `tutorials-srv` module sizing | Pinned at `instances: 1` per the existing rate-limiter comment on `mta.yaml:103-105`. Separate PR (playbook row #2). |
| `tutorials-srv-qa` module sizing | QA traffic is low; no scaling needed. |
| Any `.js` / `.ts` files | Approuter is already stateless. Zero code change anywhere. |
| `approuter/xs-app.json` | Routes don't change. |

## 3. Data flow

No runtime data-flow change. The build-time flow:

```
mta.yaml (and .deploy/mta.yaml)
  └── declares tutorials-autoscaler managed-service resource
       with path: ./deploy/autoscaler-policy.json
  ↓
mbt build packages deploy/autoscaler-policy.json into the MTAR slice
  ↓
cf deploy creates/updates the tutorials-autoscaler service instance
  └── service binds to tutorials-approuter
       └── Autoscaler reads policy → applies scaling rules
```

At runtime: AppRouter instances behave identically to today. The only observable difference is CF spawning additional instances under sustained CPU load, then reaping them after CPU drops.

## 4. Error handling

### 4.1 Autoscaler service unavailable or not entitled

Deploy fails at MTA validation. Pre-deploy guard: `cf marketplace -e autoscaler` must return at least one plan offering. If not entitled, surface the gap to the BTP admin team and fall back to `instances: 1` static (revert this PR).

### 4.2 Policy JSON malformed

The Autoscaler service rejects on bind; deploy errors. Local guard: a `node -e "JSON.parse(require('fs').readFileSync('deploy/autoscaler-policy.json'))"` step in the build pipeline catches syntax errors before deploy.

### 4.3 Stuck-scaling-up loop

If CPU readings stay anomalously high (Node memory leak in approuter, GC pressure), Autoscaler scales up to `instance_max_count: 4`. The cap is the safety net. Alerting on `instance_count == max` is **out of scope** for this PR — flagged in playbook row #1's risks for a follow-up.

### 4.4 Stuck-scaling-down loop

Symmetric concern, lower risk. `instance_min_count: 1` prevents scaling to zero. No-op needed.

### 4.5 Approuter crash during scale-up

CF restarts the failing instance automatically; healthy instances continue serving. No special handling.

## 5. Testing

### 5.1 Unit tests

**None.** Deploy-config + documentation only. No code change.

### 5.2 Smoke tests

**No new tests.** Existing approuter smoke tests already verify the public surface; they pass regardless of instance count.

### 5.3 Pre-deploy validation

- `cf marketplace -e autoscaler` returns ≥1 plan.
- `node -e "JSON.parse(require('fs').readFileSync('deploy/autoscaler-policy.json'))"` succeeds.

### 5.4 Post-deploy verification

1. `cf scaling-policy tutorials-approuter` reports the policy from the JSON file.
2. `cf events tutorials-approuter` shows the Autoscaler binding event.
3. Synthetic load: `hyperfine` or `k6` against `/` for 2 min sustained.
4. `cf app tutorials-approuter` shows instance count rise as CPU climbs.
5. After load stops + 5 min cool-down, instance count returns to 1.

### 5.5 Doc verification

The playbook's row #1 should link to this PR + the deployed policy file as the canonical reference. `predocs:build` (the sidebar guard) should pass — the new file goes in `themeConfig.sidebar` under the architecture section.

## 6. Migration / rollout

### 6.1 DEV first

Standard deploy path. Observe for 24-48h under normal traffic:

- Confirm `cf scaling-policy` reports the policy.
- Instance count stays at 1 under steady traffic.
- Autoscaling events fire if we generate synthetic load (Section 5.4).

### 6.2 PROD second

Once DEV looks healthy AND PROD cutover is otherwise ready (currently end-of-July 2026 per memory [[project_prod_cutover_july_2026]]). Same MTA change, deploys to prod subaccount.

### 6.3 Rollback

Revert the PR + redeploy. Reverts re-pin AppRouter to `instances: 1` and drops the Autoscaler service binding. No data migration, no schema change, no feature flag.

## 7. Documentation cross-links

- The new `docs/developers/architecture/scaling-playbook.md` becomes the canonical reference for scaling decisions.
- `docs/developers/operations/mta-deployment.md § Scaling Constraints` gets a one-line cross-link at the top: "Broader context in [scaling-playbook.md](../architecture/scaling-playbook.md). This section covers only the three in-process rate limiters (playbook row #2)."
- `docs/.vitepress/config.ts` `themeConfig.sidebar` gets the new file registered under the architecture section.

## 8. References

- Issue [#749](https://github.com/sap-tutorials/tutorials-ims/issues/749)
- `docs/developers/operations/mta-deployment.md § Scaling Constraints` (the narrow predecessor doc)
- `srv/jobs/scheduler.js` + `srv/jobs/job-lock.js` (the distributed-locking infrastructure that makes playbook row #3 work via same-binary env flag rather than a code split)
- Memory [[project_prod_cutover_july_2026]] — PROD timing constraint for §6.2
- Memory [[feedback_always_deploy_from_main_primary_tree]] — standard deploy hygiene
