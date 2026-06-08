# AI Code-Check Spike — Phase 4 Evaluation

**Tracking:** [sap-tutorials/tutorials-ims#171](https://github.com/sap-tutorials/tutorials-ims/issues/171) (spike), [#210](https://github.com/sap-tutorials/tutorials-ims/issues/210) (Phase 4)
**Spec:** [2026-06-02-ai-code-check-spike-design.md](2026-06-02-ai-code-check-spike-design.md)
**Date:** _<filled when complete>_
**Status:** Pending Phase 4 data

## Pilot tutorials

| Slug | Step | Author | Goal (one-line) |
|---|---|---|---|
| _t1_ | _n_ | _x_ | _…_ |
| _t2_ | _n_ | _x_ | _…_ |
| _t3_ | _n_ | _x_ | _…_ |

## Per-step agreement

| Step | n | Headline (TRUE+PARTIAL)/n | Strict TRUE/n | Exceptions |
|---|---|---|---|---|
| _t1 step n_ | 30 | _%_ | _%_ | _0_ |
| _t2 step n_ | 30 | _%_ | _%_ | _0_ |
| _t3 step n_ | 30 | _%_ | _%_ | _0_ |

## Confusion matrices

_Paste the output of `scripts/score-codecheck-eval.js` per step._

<!-- per step:

## <slug> step <n>
- n: 30
- Headline: x.x%
- Strict: x.x%
- Exceptions: 0

### Confusion matrix (rows = expected, cols = actual)
| | pass | partial | fail |
|---|---|---|---|
| pass    | … | … | … |
| partial | … | … | … |
| fail    | … | … | … |

-->

## Cost & latency

_Paste the Markdown output of `scripts/pull-codecheck-telemetry.cjs`._

| Metric | Value |
|---|---|
| p50 latency | _ms_ |
| p95 latency | _ms_ |
| p99 latency | _ms_ |
| Mean prompt tokens | _n_ |
| Mean completion tokens | _n_ |
| Verdict distribution | pass _x%_ / partial _y%_ / fail _z%_ / error _e%_ |

## Top 3 disagreement categories

1. _…e.g. "near-miss missing await graded as fail"…_
2. _…_
3. _…_

## Decision

**Headline agreement (across all pilot steps):** _%_

- [ ] **Graduate** — ≥80% headline; gaps below tracked as follow-up issues.
- [ ] **Iterate (Approach C: RAG-then-grade)** — <80% but salvageable.
- [ ] **Shelve** — <60%, retain behind flag for future revisit.

### Rationale

_…why this decision over the alternatives, in 3-4 sentences…_

### Follow-ups (if Graduate)

- _…issue link…_
- _…issue link…_

### Action (if Shelve)

- Confirm `codeCheckEnabled = false` in DEV + prod ChatSettings.
- No code removed; spike artifacts preserved at @<commit-sha>.
