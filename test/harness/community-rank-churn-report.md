# #1171 Community-Overlap Term — Churn Analysis

**Status:** baseline captured OFF; ON run pending real PROD/DEV KgCommunity data.
**Weight tested:** `KG_COMMUNITY_WEIGHT=1.5` (candidate).
**Query set:** `test/harness/community-rank-queries.json` (20 queries, topN=10).

## Procedure (two-process, module-load env capture)

`KG_COMMUNITY_WEIGHT` is read once at module load, so OFF and ON are captured in
separate processes and diffed:

```bash
# OFF baseline
KG_COMMUNITY_WEIGHT=0 npx cds bind --exec -- node test/harness/community-rank-churn.mjs > off.tsv
# ON candidate
KG_COMMUNITY_WEIGHT=1.5 npx cds bind --exec -- node test/harness/community-rank-churn.mjs > on.tsv
# diff the two slug orderings per query (columns: query, tau, entered, left, maxShift)
```

`searchKgRerankEnabled` must be `true` on ChatSettings for both runs (otherwise
both are fuzzy-only and churn is trivially 0 — a meaningless comparison).

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
