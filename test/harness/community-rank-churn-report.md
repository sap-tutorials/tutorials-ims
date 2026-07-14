# #1171 Community-Overlap Term — Churn Analysis

**Status:** baseline captured OFF; ON run pending real PROD/DEV KgCommunity data.
**Weight tested:** `KG_COMMUNITY_WEIGHT=1.5` (candidate).
**Query set:** `test/harness/community-rank-queries.json` (20 queries, topN=10).

## Procedure (two-process capture + compare)

`KG_COMMUNITY_WEIGHT` is read once at module load by the SearchService, so a
single process cannot toggle it. Capture raw ranked slug lists in two separate
processes (OFF then ON), then compare:

```bash
# OFF baseline — capture raw ranked slugs per query
KG_COMMUNITY_WEIGHT=0   npx cds bind --exec -- node test/harness/community-rank-churn.mjs capture > off.tsv
# ON candidate
KG_COMMUNITY_WEIGHT=1.5 npx cds bind --exec -- node test/harness/community-rank-churn.mjs capture > on.tsv
# compute per-query churn (tau distance, entered/left top-N, max shift) + mean tau
node test/harness/community-rank-churn.mjs compare off.tsv on.tsv
```

`searchKgRerankEnabled` must be `true` on ChatSettings for BOTH capture runs
(otherwise both are fuzzy-only and churn is trivially 0 — a meaningless
comparison). Kendall-tau here is a DISTANCE: `0` = identical ordering (no
churn), `1` = fully reversed. The enable criterion targets **mean tau < 0.15**.

## Churn metrics (per query)

| query | Kendall-tau | entered topN | left topN | max rank shift | reviewed verdict |
|---|---|---|---|---|---|
| _(populated from on.tsv vs off.tsv)_ | | | | | |

## Verdict

_To be completed after the ON run against real KgCommunity data. The term is
recommended for enabling ONLY if: (a) no currently-well-ranked title-hit query
loses its top result, (b) aggregate Kendall-tau churn is bounded (target: mean
tau < 0.15 over the query set), and (c) every top-N entrant is hand-reviewed as
a topical improvement, not noise._
