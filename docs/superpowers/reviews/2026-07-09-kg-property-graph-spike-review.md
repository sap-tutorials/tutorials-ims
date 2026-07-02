# KG Property Graph Spike — end-of-week review

**Date:** 2026-07-09
**Spec:** [../specs/2026-07-02-913-kg-property-graph-spike-design.md](../specs/2026-07-02-913-kg-property-graph-spike-design.md)
**Related PRs:** TBD

## 1. What we shipped

- [ ] Merged PR(s):
- [ ] Deployed procedure `KG_PATH_V2` (verify: `hana-cli procedures | grep KG_PATH_V2`)
- [ ] Deployed workspace `KG_PG_WORKSPACE` (verify via HANA `SYS.GRAPH_WORKSPACES` view or the HDI-plugin-specific catalog)
- [ ] Deployed views `KG_PG_VERTICES_V`, `KG_PG_EDGES_V` (verify: `hana-cli views | grep KG_PG`)

## 2. Was v2 measurably better on `pathBetween`?

Screenshot of `/admin-ui/#metrics` from `<date-start>` to `<date-end>` showing:
- p50 / p95 / p99 latency for v1 and v2
- Success / empty / error counts by version
- Fallback breakdown by reason (error / empty / flag_off)

The metric names below are the exact identifiers emitted by the Task 5 handler edit
(see [`srv/knowledge-graph-service.js`](../../../srv/knowledge-graph-service.js) —
`pathBetween` handler). Query them directly against `MetricSnapshots` in HANA
(`SELECT metric, SUM(count_value), AVG(p50_value), AVG(p95_value), AVG(p99_value)
FROM "com.sap.developers.ims.MetricSnapshots" WHERE metric LIKE 'kg_path_%'
AND "windowStart" BETWEEN ? AND ? GROUP BY metric`).

Counters:

| Metric | Meaning | Count |
| --- | --- | --- |
| `kg_path_between_calls_v2_success_prereq` | v2 returned ≥1 path | |
| `kg_path_between_calls_v1_success` | v1 fallback returned ≥1 path | |
| `kg_path_between_calls_v1_empty` | v1 fallback returned zero paths | |
| `kg_path_between_calls_v1_error` | v1 fallback threw | |
| `kg_path_v2_fallback_empty` | v2 returned zero rows → fell to v1 | |
| `kg_path_v2_fallback_error` | v2 threw → fell to v1 | |
| `kg_path_v2_fallback_flag_off` | `KG_PATH_V2_ENABLED != 'true'` | |

Reservoirs (latency, ms — populated by `metrics.observe(...)`):

| Metric | p50 | p95 | p99 |
| --- | --- | --- | --- |
| `kg_path_between_latency_ms_v2` | | | |
| `kg_path_between_latency_ms_v1` | | | |

Derived rates:

| Metric | v1 | v2 |
| --- | --- | --- |
| Success rate (%) | | |
| Empty-path rate (%) | | |

Interpretation: (1-2 paragraphs on what the numbers say)

## 3. Did anything break?

- Total `kg_path_v2_failed` fallbacks: N over observation window (`cf logs tutorials-srv --recent | grep kg_path_v2_failed | wc -l`)
- Cited log lines (max 5, the most representative):
- User-visible incidents: none / listed

## 4. Developer-experience read

- Property-graph learning curve during the spike (candid, 3-5 sentences)
- Would the team be comfortable authoring another algorithm procedure (PageRank, community, WCC) without hand-holding? Y/N + why

## 5. Follow-on decisions

- **#916 PageRank:** yes / no / needs-more-thought — 1 paragraph
- **#917 Community detection:** yes / no / needs-more-thought — 1 paragraph
- **#918 WCC:** yes / no / needs-more-thought — 1 paragraph
- **#919 9-predicate workspace widening:** yes / no / needs-more-thought — 1 paragraph
