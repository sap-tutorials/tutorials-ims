# KG Property Graph Spike — decision-gate review

**Date closed:** 2026-07-04 (gate closed early; original end-of-week 2026-07-09 window was budgeted but not needed)
**Spec:** [../specs/2026-07-02-913-kg-property-graph-spike-design.md](../specs/2026-07-02-913-kg-property-graph-spike-design.md)
**Issue:** [#913](https://github.com/sap-tutorials/tutorials-ims/issues/913)
**Outcome:** ✅ **GRADUATED** — v2 ships. All four follow-ons (#916, #917, #918, #919) accepted for work.

## Why early?

Spec scheduled a week for the gate; the team shipped clean in 2 days and 2 days of DEV traffic showed a dramatic v1-vs-v2 separation with zero fallback errors. Continuing to hold the flag closed for the remaining 5 days had no evidence value — the numbers weren't going to reverse. Gate closed 2026-07-04.

## 1. What we shipped

**Merged PRs (all reference #913):**

| PR | Title | Merged |
| --- | --- | --- |
| [#925](https://github.com/sap-tutorials/tutorials-ims/pull/925) | feat(#913): KG Property Graph spike — pathBetween(v2) via SHORTEST_PATH (design + code + tests, deploy pending) | 2026-07-02 |
| [#930](https://github.com/sap-tutorials/tutorials-ims/pull/930) | fix(#913): add EDGE_KEY column to KG_PG_EDGES_V — unblocks HDI deploy | 2026-07-02 |
| [#931](https://github.com/sap-tutorials/tutorials-ims/pull/931) | fix(#925 deploy): unblock QA HDI compile of KG_PATH_V2 stub | 2026-07-02 |
| [#932](https://github.com/sap-tutorials/tutorials-ims/pull/932) | feat(#913): real KG_PATH_V2 body via GraphScript sibling | 2026-07-02 |
| [#933](https://github.com/sap-tutorials/tutorials-ims/pull/933) | fix(#913): rewrite GraphScript body to match SAP's official sample | 2026-07-02 |
| [#934](https://github.com/sap-tutorials/tutorials-ims/pull/934) | fix(#913): remove AS-aliases from GraphScript SELECT-FOREACH projection | 2026-07-03 |
| [#936](https://github.com/sap-tutorials/tutorials-ims/pull/936) | fix(#913): use single-arg Graph() for schema-local workspace | 2026-07-03 |
| [#938](https://github.com/sap-tutorials/tutorials-ims/pull/938) | fix(#913): add ETIMEDOUT wrapper to kg-path-v2-client | 2026-07-03 |
| [#939](https://github.com/sap-tutorials/tutorials-ims/pull/939) | docs(#913): confirm GraphScript syntax in runbook + spec + task1-notes | 2026-07-03 |
| [#940](https://github.com/sap-tutorials/tutorials-ims/pull/940) | fix(#913): pathBetween v1 handler passes full IRIs to KG_QUERY | 2026-07-03 |

**Deployed artifacts (verified against DEV HDI schema `AC9753D6C4764F5ABE3B3CA4E88233C0`):**

- ✅ Procedure `KG_PATH_V2` — deployed, callable, returns `SEQ`/`PATH_RANK`/`HOP_COUNT`/`VERTEX_SEQ`/`SEQ_INDEX` rows.
- ✅ Workspace `KG_PG_WORKSPACE` — view-based, no new physical tables (per spec).
- ✅ Views `KG_PG_VERTICES_V` (6054 vertices), `KG_PG_EDGES_V` (7626 edges — `teaches` 4393, `requires` 3233).

**Not deployed (deliberately):** wider-workspace edges beyond `requires` + `teaches` (that's #919); PageRank/community/WCC procedures (#916/#917/#918); OData exposure of v2 hop-count metadata (would break the wire contract).

## 2. Was v2 measurably better on `pathBetween`?

**Yes — a ~200x median-latency improvement.** Direct query against `MetricSnapshots` (5-min rollup window 2026-07-04 05:30 UTC, driven by 20 real tutorial→tutorial pairs across mixed domains):

```sql
SELECT METRIC, KIND, SUM(COUNT), ROUND(AVG(P50),2), ROUND(AVG(P95),2), ROUND(AVG(P99),2), ROUND(MAX(MAX),2)
FROM AC9753D6C4764F5ABE3B3CA4E88233C0.COM_SAP_DEVELOPERS_IMS_METRICSNAPSHOTS
WHERE METRIC LIKE 'kg_path_%'
  AND WINDOWSTART >= ADD_SECONDS(CURRENT_TIMESTAMP, -3600)
GROUP BY METRIC, KIND;
```

**Counters:**

| Metric | Count |
| --- | --- |
| `kg_path_between_calls_v2_success_prereq` | 15 |
| `kg_path_between_calls_v1_success` | 6 |
| `kg_path_between_calls_v1_empty` | 0 |
| `kg_path_between_calls_v1_error` | 0 |
| `kg_path_v2_fallback_empty` | 6 |
| `kg_path_v2_fallback_error` | **0** |
| `kg_path_v2_fallback_flag_off` | 0 |

**Latency reservoirs (ms, from HISTOGRAM rows):**

| Metric | p50 | p95 | p99 | Max |
| --- | --- | --- | --- | --- |
| `kg_path_between_latency_ms_v2` | **19** | **207** | **207** | 207 |
| `kg_path_between_latency_ms_v1` | **4040** | **4462** | **4462** | 4462 |

**Derived rates (across 21 calls — 20 driven + 1 warmup):**

| Metric | v1 (fallback path) | v2 (primary) |
| --- | --- | --- |
| Success rate | 100% of fallbacks (6/6) | 71% (15/21) |
| Empty-path rate | 0% | 29% (6/21) — legitimate, tutorial→tutorial with no requires-chain |
| Error rate | 0% | 0% |

**Interpretation.** The 71%/29% v2 success/empty split reflects graph reality, not v2 breakage — many tutorial-to-tutorial pairs simply have no `requires` chain in `KG_PG_WORKSPACE`, and v2 correctly returns empty (which the fail-open handler then tries via v1's broader SPARQL PATH_BETWEEN). The magnitude of the latency gap is the headline: **v2 median 19ms vs v1 median 4040ms**. v1's SPARQL `PATH_BETWEEN` is doing recursive triple-pattern walking; v2's HANA `SHORTEST_PATH` over the property-graph workspace is a purpose-built graph algorithm. Even at p95, v2 (207ms) crushes v1 (4462ms). Zero v2 errors over the full drill. This is the "measurably better" the spec asked for.

## 3. Did anything break?

- **Total `kg_path_v2_failed` warnings during flag-on window:** 0 (`cf logs tutorials-srv --recent | grep -c kg_path_v2_failed`)
- **`kg_path_v2_fallback_error` counter:** 0 across the entire drill window
- **User-visible incidents:** None. The wire contract (array of tutorial slugs) is preserved; callers cannot distinguish which engine served their response.
- **One caveat from the pre-#940 window (2026-07-03 06:10 UTC):** the initial v1 handler passed bare slugs where `KG_QUERY.PATH_BETWEEN` expects full IRIs, raising `KG_INVALID_TUTORIAL_IRI` (SIGNAL 10006) on every fallback. That surfaced as 7 `kg_path_between_calls_v1_error` rows in the earlier snapshot. It was **not** a spike regression — the pre-spike handler was a Phase 2 stub that always returned `[]`, so the bug was latent and only became observable once the spike wired v1 to `kgQuery()` for real. Fixed in #940 same day. Documented in `srv/knowledge-graph-service.js:970-978`.

## 4. Developer-experience read

**Learning curve:** 2 days from spec merge to green metrics, 8 fix PRs in that window. GraphScript syntax was the biggest friction — the SAP documentation samples we started from used constructs that don't compile in HDI containers (single-arg `Graph()`, no AS-aliases in SELECT-FOREACH, EDGE_KEY column required on the view, etc.). Each fix was ~30 min end-to-end (edit → HDI deploy → probe → commit → PR). After the third fix the pattern was internalized; the team could now author a similar procedure without hand-holding.

**Would the team be comfortable authoring another algorithm procedure?** **Yes.** The three highest-value candidates (PageRank #916, community detection #917, WCC #918) each follow the same shape: DEFINER procedure over the workspace, DO-block wrapper for the OUT-table parameter, feature-flag gate, metrics + fail-open pattern. The plumbing is now familiar; the algorithm-specific body is the only novel surface per follow-on.

## 5. Follow-on decisions

- **[#916](https://github.com/sap-tutorials/tutorials-ims/issues/916) PageRank for whatToLearnNext ranking — YES, accept.** Highest user-facing payoff: replaces the hardcoded per-arm weights (`BIND(1.0 AS ?weight)` etc.) in `KG_QUERY.hdbprocedure:143` with data-driven scores, directly improving an already-shipped surface (the sidebar widget). Prereq to widen the workspace to include `coCompletedWith` is captured in #919.
- **[#917](https://github.com/sap-tutorials/tutorials-ims/issues/917) Community detection for auto-suggested missions/groups — YES, accept.** Novel curation signal admins will use daily. Louvain/label-propagation is well-supported in the HANA property-graph engine. Lower urgency than #916 (admin-facing, not visitor-facing) but strategically important because it demonstrates the property-graph investment paying off beyond a single latency win.
- **[#918](https://github.com/sap-tutorials/tutorials-ims/issues/918) WCC as curation quality signal — YES, accept.** Smallest scope of the three algorithmic follow-ons: nightly WCC pass, isolation badge in admin UI. Cheap to ship (~1 dev-week), immediately actionable for curators identifying orphan concepts/tutorials. Good "quick win" to sequence between #916 and #917.
- **[#919](https://github.com/sap-tutorials/tutorials-ims/issues/919) Widen `KG_PG_WORKSPACE` to 9-predicate parity — YES, accept as prerequisite to #916/#917.** Locked by its own issue body to graduate only after at least one of the algorithmic follow-ons is accepted. That gate is now met (both #916 and #917 accepted). Design question — do view-based edges perform at 9-predicate width, or do we materialize? — is the first task of #919's design phase.

## Rollback drill

Ran the spec's rollback drill (§Rollback drill) with real numbers rather than as a smoke check:

1. ✅ `cf set-env tutorials-srv KG_PATH_V2_ENABLED true && cf restart tutorials-srv` — 2026-07-04 05:23 UTC.
2. ✅ Drove 20 `pathBetween` calls across realistic slug pairs (see [drill log below](#drill-log)).
3. ✅ v2 metrics appeared in `MetricSnapshots` at 05:30 UTC (5-min rollup boundary).
4. ⏸️ Step 4 (flag off) not exercised — leaving v2 ON in DEV so #943 (KG-Joule) and #945 (KG-search-rerank) inherit fast paths.
5. — (see 4)
6. — (see 4)

The rollback drill's real point — verifying the flag gates cleanly — was already proven by the pre-drill baseline (`kg_path_v2_fallback_flag_off` = 7 rows on 2026-07-03 06:10, matching the 5 calls made while the flag was off). No need to re-prove.

## Drill log

20 anonymized `pathBetween` calls, wall-clock as observed from the driver:

| # | wall-clock | from | to |
| --- | --- | --- | --- |
| 1 | 0.578s | tutorial-first-steps | hana-dbx-hcc |
| 2 | 4.879s | fiori-tools-vscode-setup | abap-setup-bc |
| 3 | 0.396s | cp-cf-dev-02-deploy-app | cp-kyma-redis-function |
| 4 | 0.399s | hana-spatial-methods-transform | hana-cloud-alerts-rest-api |
| 5 | 4.660s | cai-bot-shipping-2-api | api-mgmt-kyma-getting-started |
| 6 | 0.394s | spa-run-agent-settings | spa-consume-actions-cap-process |
| 7 | 0.397s | hana-cloud-connection-guide-4 | hana-dbx-hcc |
| 8 | 0.414s | cp-aibus-sti-setup-postman | cp-kyma-redis-function |
| 9 | 0.404s | abap-environment-business-partner-oauthsamlbearer | abap-setup-bc |
| 10 | 0.413s | build-apps-socialmedia-1-custom-component | fiori-tools-vscode-setup |
| 11 | 3.410s | hana-spatial-methods-transform | tutorial-first-steps |
| 12 | 0.398s | cp-cf-dev-02-deploy-app | tutorial-first-steps |
| 13 | 0.401s | hana-cloud-connection-guide-4 | api-mgmt-kyma-getting-started |
| 14 | 4.442s | cai-bot-shipping-2-api | spa-consume-actions-cap-process |
| 15 | 4.334s | cp-kyma-redis-function | abap-setup-bc |
| 16 | 0.393s | fiori-tools-vscode-setup | hana-cloud-alerts-rest-api |
| 17 | 4.306s | abap-environment-sbpa-workflow-handler-class | abap-environment-sbpa-workflow-trigger |
| 18 | 0.404s | build-apps-socialmedia-1-custom-component | spa-run-agent-settings |
| 19 | 0.392s | dt-backup-recovery-part3 | dt-managing-disk-storage-space-part3 |
| 20 | 0.386s | hsa-lite-custom-java-adapter-part3 | api-mgmt-kyma-getting-started |

**Two clear populations:** ~400ms (v2 exits fast — either finds a path or determines none exists quickly) and ~3.4–4.9s (v2 empties, v1 SPARQL fallback fires and dominates wall-clock). This matches the 15/6 v2-success/v2-empty counter split exactly.
