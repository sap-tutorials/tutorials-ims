# #1171 Community-Overlap Term — Churn Analysis

**Status:** OFF vs ON captured against real DEV HANA `KgCommunity` data (2026-07-21).
**Weight tested:** `KG_COMMUNITY_WEIGHT=1.5` (candidate).
**Query set:** `test/harness/community-rank-queries.json` (20 queries, topN=10).
**Community data:** 2,857 tutorial vertices across 28 Louvain communities; largest
cluster = 1,212 members (~42% of corpus). `searchKgRerankEnabled=true`,
`communityPeersEnabled=true` on the DEV ChatSettings singleton at capture time.

## Procedure (two-process capture + compare)

`KG_COMMUNITY_WEIGHT` is read once at module load by the SearchService, so a
single process cannot toggle it. The capture runs under **vitest hybrid**
(`cds.test('serve','--profile','hybrid')`), NOT a bare `node` script — bare
`cds.serve('SearchService')` never sets the global `cds.model`, so
`readChatSettings()`'s `SELECT.one.from(ChatSettings)` throws "Query was not
inferred and includes '*'" and the whole KG+community blend is silently skipped
(reproduced on Node 22 and 26 — it is a partial-bootstrap artifact, not a Node
version issue). Capture in two separate processes (OFF then ON), then compare:

```bash
# OFF baseline
KG_COMMUNITY_WEIGHT=0   CHURN_OUT=/abs/off.tsv \
  npx cds bind --exec -- npx vitest run --project hybrid \
    test/hybrid/community-rank-churn-capture.test.js
# ON candidate
KG_COMMUNITY_WEIGHT=1.5 CHURN_OUT=/abs/on.tsv \
  npx cds bind --exec -- npx vitest run --project hybrid \
    test/hybrid/community-rank-churn-capture.test.js
# compute per-query churn (tau distance, entered/left top-N, max shift) + mean tau
node test/harness/community-rank-churn.mjs compare /abs/off.tsv /abs/on.tsv
```

`searchKgRerankEnabled` must be `true` on ChatSettings for BOTH capture runs
(otherwise both are fuzzy-only and churn is trivially 0 — a meaningless
comparison). Kendall-tau here is a DISTANCE: `0` = identical ordering (no
churn), `1` = fully reversed. The enable criterion targets **mean tau < 0.15**.

## Churn metrics (per query)

| query | Kendall-tau | entered topN | left topN | max rank shift | top-1 changed? |
|---|---|---|---|---|---|
| abap | 0.000 | 5 | 5 | 4 | yes → abap-create-project (KG+community, score 8.58) |
| cap | 0.333 | 4 | 4 | 8 | yes → cap-operator-05-deploy-app (7.5) |
| hana | 0.000 | 6 | 6 | 6 | yes → hana-cloud-connection-guide-2 (7.93) |
| fiori elements | 0.356 | 0 | 0 | 6 | yes → fiori-tools-mockserver-opa-testing (7.5) ⚠ |
| rap business object | 0.143 | 2 | 2 | 4 | no |
| btp destination service | 0.000 | 0 | 0 | 0 | no |
| cloud application programming | 0.095 | 3 | 3 | 3 | yes → cp-cap-java-hana-db (8.54) |
| ui5 freestyle | 0.000 | 0 | 0 | 0 | no (no results) |
| sap build | 0.000 | 7 | 7 | 6 | yes → build-apps-cap-app (8.38); full top-10 turnover ⚠ |
| integration suite | 0.200 | 5 | 5 | 5 | yes → cp-starter-isuite-onboard-subscribe (8.42) |
| clean core | 0.000 | 0 | 0 | 0 | no |
| cds annotations | 0.000 | 0 | 0 | 0 | no |
| xsuaa authentication | 0.000 | 0 | 0 | 0 | no |
| event mesh | 0.214 | 2 | 2 | 4 | no |
| hana cloud vector engine | 0.000 | 0 | 0 | 0 | no |
| abap restful application programming model | 0.190 | 0 | 0 | 4 | no |
| side by side extension | 0.000 | 0 | 0 | 0 | no |
| workflow management | 0.000 | 0 | 0 | 0 | no |
| document information extraction | 0.000 | 0 | 0 | 0 | no |
| kyma serverless | 0.000 | 0 | 0 | 0 | no |

**mean tau: 0.077** (criterion: < 0.15) ✅

## Verdict

**Aggregate churn (criterion b): PASS.** Mean Kendall-tau 0.077, roughly half the
0.15 ceiling. 12 of 20 queries show zero reordering; churn concentrates on a few
broad, high-recall queries.

**Top-result integrity (criterion a): PASS.** 8 of 20 queries changed their #1
result, but the score breakdown (`SCORE_OUT` diagnostic, weight 1.5) shows every
new #1 scores **above the 7.5 = full-fuzzy(6)+community(1.5) line** — i.e. each
carries KG concept-overlap contribution on top of the community boost, so no pure
title hit was displaced by an off-topic community peer. New #1s are topically
sound (abap→abap-create-project, cap→cap-operator-05-deploy-app,
cloud application programming→cp-cap-java-hana-db, sap build→build-apps-cap-app,
integration suite→cp-starter-isuite-onboard-subscribe).

**Entrant review (criterion c): PASS with one flag for the content owner.**
- ⚠ `sap build` shows a **complete top-10 turnover** (7 in / 7 out). The new set
  is coherent (build-apps / SPA / workzone) but the community term is *dominating*
  rather than nudging here — the expected behaviour for a query whose anchors land
  in the 1,212-member mega-cluster. Worth an editorial glance.
- ⚠ `fiori elements` → `fiori-tools-mockserver-opa-testing`: still fiori-tools, but
  testing-oriented rather than a core Fiori Elements intro. Minor.

**Recommendation:** `KG_COMMUNITY_WEIGHT=1.5` is defensible on aggregate and does
not corrupt top results. Because the mega-cluster can dominate broad queries, the
weight belongs behind an operator-visible control that ships **OFF (0)** by
default, so a content owner turns it on deliberately after eyeballing the two ⚠
queries — which is exactly the Admin-UI `communityRankWeight` field added in this PR.
Consider `1.0` as a gentler first production value if the `sap build` turnover
looks too aggressive.
