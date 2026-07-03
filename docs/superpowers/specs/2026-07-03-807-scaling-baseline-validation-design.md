# #807 — Scaling-playbook baseline validation pass

**Status:** Approved 2026-07-03
**Issue:** [#807](https://github.com/sap-tutorials/tutorials-ims/issues/807)
**Related:** #749 (scaling playbook), #804/#965 (k6 suite), #805/#907 (observability instrumentation), #909/#937 (`METRICS_DB_WRAP`)

## 1. Background

Three of the four asks in #807 shipped in the last two weeks:

| Ask | Shipped in | Where |
|---|---|---|
| Stand up a k6 suite | PR #965 (issue #804) | `test/load/`, `.github/workflows/load-test.yml` |
| Instrument cache + pool metrics | PRs #907 (#805) + #937 (#909) | `srv/lib/metrics.js`, `srv/lib/metrics-db-wrap.js`, `MetricSnapshots` entity, `/admin/metrics/live` |
| Validate the scaling playbook | — | `docs/developers/architecture/scaling-playbook.md` exists (from #749), Row #1 shipped; **the rest is asserted, not measured** |
| Return for spikes around major events | — | Ongoing stance |

The gap this spec closes is the third row. PR #965's own post-merge checklist says:

> **Not run:** live `k6 run` against DEV. First real signal will come from the manual `workflow_dispatch` after merge.
>
> **Post-merge follow-ups:**
> 1. Dispatch `smoke` scenario against DEV; confirm green.
> 2. Dispatch `baseline`; capture real p95 numbers.
> 3. If p95 is far below threshold, tighten `THRESHOLDS` in a follow-up PR.

This spec covers those three follow-ups **plus** the "validate the scaling playbook" work — capturing the k6 numbers side-by-side with `/admin/metrics/live` and recording a validation log row in `scaling-playbook.md`.

## 2. Scope

### In scope

1. Dispatch `smoke` via `workflow_dispatch` from GitHub Actions → confirm green.
2. Dispatch `tutorials` twice (`LOAD_MODE=cold` then `LOAD_MODE=hot`) → prove `content.cache.hit`/`miss` counters flip and `db.acquire.ms.p95` stays sane on cold.
3. Dispatch `baseline` (10 VU × 2 min) → capture `k6-summary-02-public-baseline.json` **and** before/after `/admin/metrics/live` snapshots taken in the same wall-clock window.
4. Dispatch `ws` → smoke-level WebSocket handshake check. If red, file a separate issue and continue.
5. Compute proposed new `THRESHOLDS` values (`max(1.5 × observed_p95, 100 ms)` rounded to nearest 50 ms). Never loosen.
6. PR the tightened thresholds to `test/load/config.js`.
7. Append a **Validation log** section to `docs/developers/architecture/scaling-playbook.md` capturing run date, k6 version, base URL, per-endpoint p95, cache-hit rate, DB acquire p95, and any surprises. Link to the Actions run URL and PR SHA.
8. Update the scaling-playbook table so Row #1 gets a "validated 2026-07-04" note. Rows #5 and #7 get their "observed at N=1" datapoint recorded (context for when we scale up).

### Out of scope

- `ramp` scenario (0→100 VU × 15 min). Only run when investigating a regression. A baseline pass does not need it.
- WebSocket deep-dive. Row #4 of the playbook has its own bucket.
- Any product-source code changes. Only `test/load/config.js`, the playbook doc, and the spec/plan files.
- PROD dispatch. v1 pin is DEV-only.
- Sidebar registration for the spec/plan — `superpowers/**` is in `srcExclude` (`docs/.vitepress/config.ts:46`), so those files are not VitePress pages.

## 3. Success criteria

All four must be true:

1. All five scenarios in `all-except-ramp` pass their thresholds green in a single dispatch, OR the failing thresholds have a documented reason + follow-up issue.
2. `THRESHOLDS` PR merged with values within 20% of `1.5 × observed_p95` for every keyed endpoint (rounded to nearest 50 ms, floor 100 ms). Never loosened.
3. Validation log section in `scaling-playbook.md` names the exact Actions run URL and window (`2026-07-04T HH:MM–HH:MM UTC`).
4. Weekly cron (Monday 03:00 UTC) unchanged.

## 4. Method

### 4.1 Prerequisites (verify once, before dispatch)

- `cf login` targeted at DEV space. Run `cf apps` to confirm both `tutorials-approuter` and `tutorials-srv` are `started`.
- A tech-user credential with `Admin` role exists in `tenantSettings.techUsers` for DEV. If missing, add a temporary one via runtime-config (`admin-ui/#operations` → tenant settings) so `/admin/metrics/live` returns 200 for our `curl`. Export as `ADMIN_BASIC_AUTH="user:pass"`. **Rotate after the run** — see §7.
- Confirm `METRICS_ENABLED` is unset or `true` (default) and `METRICS_DB_WRAP=true` (PRs #937 / #909 enabled it) in `cf env tutorials-srv`. Without db-wrap the pool metrics we care about aren't produced.
- Confirm no `rebuild-content.yml` run is in flight: `gh run list --workflow=rebuild-content.yml --limit 3`. If one is running or recently completed, wait 10 min so the LRU has stabilised.

### 4.2 Correlation pattern (per scenario)

Since `/admin/metrics/live` returns an *in-memory* snapshot at a point in time, and `MetricSnapshots` rows aren't written until the next 5-min rollup, we do a two-track capture:

1. **T-0:** `curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > before-<scenario>.json`
2. **T-0:** `gh workflow run load-test.yml -f scenario=<name>` and note the run URL.
3. Wait for run completion.
4. **T-N (immediately after):** `curl -su "$ADMIN_BASIC_AUTH" "$SRV_URL/admin/metrics/live" > after-<scenario>.json`
5. Download the k6 artifact: `gh run download <run-id> -n k6-summaries -D artifacts/`
6. Optional, after 5+ min: pull persisted rollups from `MetricSnapshots` via `AnalyticsService` for finalized 5-min-aligned histograms.

Where `$SRV_URL` is `https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com`.

### 4.3 Dispatch order

Cache is warmed predictably by putting the cold-tutorials run **first** (after smoke).

| Order | Scenario | Duration | Why |
|---|---|---|---|
| 1 | `smoke` | 30 s | Safety. If red, stop and investigate. |
| 2 | `tutorials` (`LOAD_MODE=cold`) | 3 min | Exercises the cold-cache path — `db.acquire.ms`, `content.cache.miss`, `db.pool.timeout`. **Restart of `tutorials-srv` is intentionally skipped** — the LRU may hold residuals from prior traffic, which we document in the log. The `hit/(hit+miss)` **ratio during the scenario window** is still meaningful. |
| 3 | `tutorials` (`LOAD_MODE=hot`) | 3 min | Warm-cache path. Should show `content.cache.hit` dominant and much lower p95. |
| 4 | `baseline` | 2 min | Steady weighted mix — the number that goes into the tightened thresholds. |
| 5 | `baseline` (second run, ≥5 min gap) | 2 min | Two samples so we don't tighten off a single fluke. Use `max(run1_p95, run2_p95)` as the observed value. |
| 6 | `ws` | 2 min | Handshake churn. If red, file a separate issue and continue — do not block on #807. |

Total ≈ 15 min k6 wall-clock + ~15 min overhead. One sitting.

### 4.4 Deriving new `THRESHOLDS`

For each keyed endpoint in `test/load/config.js` `THRESHOLDS`:

- `observed_p95` = `max(run1, run2)` from k6 summaries. If either baseline run aborts (e.g. publish-in-flight guard skip, CI transient), re-dispatch — do not tighten off a single sample.
- `proposed_ceiling = max(1.5 × observed_p95, 100)` rounded to nearest 50 ms
- If `proposed_ceiling >= current_ceiling`: **do not loosen.** Leave current, note in the validation log that we ran under it.
- If `proposed_ceiling < current_ceiling`: tighten to `proposed_ceiling`.

Rationale: `1.5×` gives noise headroom without inviting silent regressions. The 100 ms floor prevents flaky thresholds on network jitter for endpoints that measure <70 ms locally.

### 4.5 Validation-log format

Appended to `docs/developers/architecture/scaling-playbook.md` **before** the existing "Last updated" trailer, in a new top-level section:

```markdown
## Validation log

### 2026-07-04 — Baseline pass under N=1 (Issue #807)

- **Actions run:** <URL>
- **Base URL:** https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com
- **k6 version:** 0.51.0
- **srv instances:** 1
- **approuter instances:** 1
- **`METRICS_DB_WRAP`:** true

**k6 p95 (baseline scenario, worse of two runs):**

| Endpoint | Observed p95 | Old threshold | New threshold | Notes |
|---|---|---|---|---|
| build-catalog | Xms | 500 | Yms | — |
| build-navigator | Xms | 500 | Yms | — |
| tutorial | Xms | 300 | Yms | — |
| advocates-list | Xms | 200 | Yms | — |
| advocates-photo | Xms | 300 | Yms | — |

**Tutorial-serve cache mode comparison:**

| Mode | p95 | hit-rate | Notes |
|---|---|---|---|
| cold | Xms | X% | LRU state at scenario start: N slugs cached (residual, no restart) |
| hot | Xms | X% | — |

**Cache metrics (from `/admin/metrics/live` diff, cold → hot):**

- `content.cache.hit`: N₀ → N₁
- `content.cache.miss`: M₀ → M₁ (should be flat between runs, i.e. hot leg adds no misses)
- `cache.bytes` gauge: X MB → Y MB
- `cache.evict`: N (well under LRU cap? expected 0 for one tutorial-list worth)

**DB pool metrics (from `/admin/metrics/live`, tutorials-cold window):**

- `db.acquire.ms.p95`: Xms
- `db.pool.timeout`: N (target: 0)
- `db.tx.ms.p95`: Xms
- `db.tx.run.ms.p95`: Xms

**Playbook rows validated at N=1:**

- **Row #1 (AppRouter):** Held under baseline — auto-scaler config remains inert at 1..4.
- **Row #5 (in-memory caches):** 50 MB LRU on `content-store.js` sat at ~X MB. Headroom fine at N=1; projected ~2X MB at N=2 srv.
- **Row #7 (HANA pool):** p95 acquire under Xms with `db.pool.timeout=0`. Documents current `@sap/hana-client` defaults are adequate at N=1 baseline traffic.

**Rows NOT exercised by this pass:**

- Row #4 (WebSocket) — only smoke-level (~20 VU handshake churn).
- Rows #2, #3, #6, #12–14 — not touched by baseline traffic; deferred until the traffic pattern that stresses each row is actually observed.

**Threshold PR:** <sha> / <PR URL>
```

### 4.6 Deliverables (single PR)

- `test/load/config.js` — tightened thresholds.
- `docs/developers/architecture/scaling-playbook.md` — new "Validation log" section + Row #1 / #5 / #7 status notes in the table.
- `docs/superpowers/specs/2026-07-03-807-scaling-baseline-validation-design.md` — this spec.
- `docs/superpowers/plans/2026-07-03-807-scaling-baseline-validation.md` — writing-plans output.

PR title: `chore(#807): scaling-playbook baseline validation + tightened k6 thresholds`. Draft first, promoted to ready once the tightened-threshold re-dispatch is green.

## 5. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `rebuild-content.yml` collides with our dispatch | Low | Workflow's built-in publish-in-flight guard skips cleanly; we re-dispatch. |
| Single-run p95 misrepresents typical | Medium | Two `baseline` runs ≥5 min apart; use the worse of the two. |
| Temp tech-user leaked (never rotated) | Low | Explicit rotation checklist in the plan; tech-user is one runtime-config field, one admin action to remove. |
| Cold scenario shows warm results (LRU residual) | Medium (restart skipped by design) | Document residual in log; report `hit/(hit+miss)` **ratio during window**, not absolute. |
| DEV base URL changes | Low | One env var (`LOAD_BASE_URL`) covers workflow + local. |
| Docker Hub rate-limit on `grafana/k6:0.51.0` in CI | Low | Re-run. If recurrent, file a follow-up for a mirror. |
| DEV HANA plan is smaller than PROD; p95s pessimistic for PROD | Medium | Log explicitly notes "Numbers apply to DEV plan; PROD sizing re-measured post-cutover." |

## 6. Testing

Because #807's product-side change is *only* `test/load/config.js` thresholds + docs, the surface is small:

- `npm run test` — passes unchanged. Nothing in unit touches `test/load/`.
- No new unit test — k6 has no Node runtime; "test" is a successful dispatch.
- `npm run docs:build` — MUST pass locally before commit (`predocs:build` sidebar guard).
- Manual: one final `gh workflow run load-test.yml -f scenario=baseline` **against the tightened thresholds** to confirm green. If a threshold flags, back off that specific threshold — do not merge tighter-than-observed values.

## 7. Rollback / rotation

- **Tightened thresholds:** Single-file edit. Revert with `git revert <sha>` and re-dispatch. No product code affected — the k6 config is inert until dispatched. `1.5×` (not `2×`) is chosen because over-tightening is bounded cost.
- **Temp tech-user rotation:** After the PR is merged, remove the temporary entry from `tenantSettings.techUsers` via the admin UI (`admin-ui/#operations` → tenant settings). Confirm the tech-user is gone by attempting the `curl` again — should now return 401.

## 8. Follow-ups (out of scope, filed if surfaced)

- If `ws` scenario fails: separate issue for Row #4.
- If `db.acquire.ms.p95` on cold is >100 ms: separate issue for Row #7 pool tuning.
- If `cache.evict` fires during `tutorials-hot`: separate issue for Row #5 LRU sizing.
- If `baseline` p95 stays above threshold on the tightened re-dispatch: back off threshold in the same PR; open a perf-investigation issue with the k6 artifacts attached.
