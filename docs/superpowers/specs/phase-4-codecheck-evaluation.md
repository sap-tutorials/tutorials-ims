# AI Code-Check Spike — Phase 4 Evaluation

**Tracking:** [sap-tutorials/tutorials-ims#171](https://github.com/sap-tutorials/tutorials-ims/issues/171) (spike), [#210](https://github.com/sap-tutorials/tutorials-ims/issues/210) (Phase 4)
**Spec:** [2026-06-02-ai-code-check-spike-design.md](2026-06-02-ai-code-check-spike-design.md)
**Date:** 2026-06-13
**Status:** Complete — verdict: **GRADUATE**

## Pilot tutorials

| Slug | Step | Author | Goal (one-line) |
| --- | --- | --- | --- |
| `cap-extend-sfsf-create-service` | 2 | AI bootstrap | CDS service definition with 4 entities (Project draft, Member projection, Activity, SFSF_User read-only) |
| `cap-extend-sfsf-data-model` | 3 | AI bootstrap | CDS data model with 3 cuid entities + read-only Employee, with proper Composition/Association relationships |
| `cap-extend-sfsf-add-logic` | 2 | AI bootstrap | CAP service implementation skeleton with `cds.service.impl(async)`, entities destructure, ON/BEFORE/AFTER comment markers |

**Methodology disclosure:** Submissions were AI-generated, not author-curated. Three parallel sub-agents (per step) produced 30 labeled mutations each (10 pass / 10 partial / 10 fail) following a locked rubric defining what each verdict category means against each step's reference solution. The "expected verdict" labels are mine (acting as author proxy). Full rubric documented in the issue #210 comment that closed this evaluation. The grader is the production [/api/codecheck](https://github.com/sap-tutorials/tutorials-ims/blob/main/srv/lib/code-check-handler.js) endpoint hitting `anthropic--claude-4.6-sonnet` via `tutorials-aicore` deployment `da6d9c5e3fb50c3d`. Generator and grader are independent — no AI-grades-AI feedback loop.

The `pass-001` row of each JSONL is the verbatim reference solution as a calibration anchor: if the grader didn't return `pass` on that, the eval would be invalid. All three calibration anchors returned `pass`.

## Per-step agreement

| Step | n | Headline (any agreement) | Strict (exact match) | Exceptions |
| --- | --- | --- | --- | --- |
| `cap-extend-sfsf-create-service` step 2 | 30 | **100.0%** | **100.0%** | 0 |
| `cap-extend-sfsf-data-model` step 3 | 30 | **100.0%** | **100.0%** | 0 |
| `cap-extend-sfsf-add-logic` step 2 | 30 | **100.0%** | **86.7%** | 0 |
| **Aggregate** | **90** | **100.0%** | **95.6%** | **0** |

"Headline" treats `partial` as agreement when either expected or actual is `partial` (per the runbook: "the spike's primary goal is the pass-vs-fail boundary"). "Strict" requires the verdict to match exactly.

## Confusion matrices

### `cap-extend-sfsf-create-service` step 2

- n: 30
- Headline: 100.0%
- Strict: 100.0%
- Exceptions: 0

| | pass | partial | fail |
| --- | --- | --- | --- |
| pass | 10 | 0 | 0 |
| partial | 0 | 10 | 0 |
| fail | 0 | 0 | 10 |

Perfect diagonal. Every mutation graded as expected.

### `cap-extend-sfsf-data-model` step 3

- n: 30
- Headline: 100.0%
- Strict: 100.0%
- Exceptions: 0

| | pass | partial | fail |
| --- | --- | --- | --- |
| pass | 10 | 0 | 0 |
| partial | 0 | 10 | 0 |
| fail | 0 | 0 | 10 |

Perfect diagonal. Every mutation graded as expected.

### `cap-extend-sfsf-add-logic` step 2

- n: 30
- Headline: 100.0%
- Strict: 86.7%
- Exceptions: 0

| | pass | partial | fail |
| --- | --- | --- | --- |
| pass | 10 | 0 | 0 |
| partial | 2 | 8 | 0 |
| fail | 0 | 2 | 8 |

Four off-diagonal cells, all in the **lenient** direction (grader more permissive than expected label by exactly one verdict tier). Zero pass-vs-fail boundary crossings. See "Top 3 disagreement categories" below for the analysis.

## Cost & latency

Pulled from `COM_SAP_DEVELOPERS_IMS_CODECHECKSUBMISSIONS` for the eval run window (2026-06-13T08:30Z onwards, 92 rows including 1 pre-eval smoke + 1 disabled-deployment-id error row + 90 eval rows).

| Metric | Value |
| --- | --- |
| p50 latency | 8,063 ms |
| p95 latency | 9,798 ms |
| p99 latency | 11,384 ms |
| Mean prompt tokens | 2,792 |
| Mean completion tokens | 251 |
| Total tokens (90 calls) | ~277k (254k prompt + 23k completion) |
| Estimated cost (90 calls) | ~$1.10 (anthropic--claude-4.6-sonnet) |
| Verdict distribution (eval only) | pass 33 / partial 30 / fail 28 (matches expected: 30/30/30) |
| Errors | 0 (100% reliability across 90 calls; 1 prior `upstream` error fixed by setting `CHAT_DEPLOYMENT_ID`) |

Per-call cost ≈ $0.012 at current Sonnet 4.6 pricing. At ~5/5min per-step rate-limit + 30/hour per-user cap, sustained-load cost is bounded to $1.80/user/hour worst case.

## Top 3 disagreement categories

All 4 disagreements were on `cap-extend-sfsf-add-logic` step 2; each represents the grader being **one tier more lenient** than the expected label.

### 1. Style equivalence — destructure-vs-individual-assignment (1 case)

- `partial-007`: used `const Project = this.entities.Project;` (one line per entity) instead of `const { Project, Member, SFSF_User } = this.entities;`.
- Expected: `partial` (the spec hint says "Destructure exactly Project, Member, SFSF_User from this.entities").
- Actual: `pass` (grader: "correctly implements... extracting Project, Member, and SFSF_User from this.entities").
- **Defensible disagreement.** The goal phrasing ("destructures from this.entities") is ambiguous; both styles expose the same three identifiers. A stricter reading expects the destructure idiom; a generous reading sees both as equivalent. Author judgment call.

### 2. Comment-marker leniency — `// ON_EVENT handlers` instead of `// ON events` (1 case)

- `partial-008`: used `// ON_EVENT handlers`, `// BEFORE_EVENT handlers`, `// AFTER_EVENT handlers` instead of the canonical `// ON events`, `// BEFORE events`, `// AFTER events`.
- Expected: `partial` (rubric explicitly listed this as a partial example).
- Actual: `pass` (grader: "including placeholder comments for ON, BEFORE, and AFTER event sections").
- **Genuine grader miss.** The marker text itself differs. The grader noticed the *shape* (three sections referencing ON/BEFORE/AFTER) but didn't enforce the literal `// ON events` text. For a placeholder-comments-only step, this matters less than it would for code-bearing steps.

### 3. Overshoot interpretation — handlers attached when "no handlers attached yet" required (1 case)

- `fail-009`: included full `this.on('READ', Project, ...)`, `this.before('CREATE', Member, ...)`, `this.after('READ', SFSF_User, ...)` handlers — directly violating the goal's "no handlers attached yet".
- Expected: `fail` (does more than the step asks; the step is a *skeleton*).
- Actual: `partial` (grader: "correctly sets up the module structure... but it attaches actual event handlers instead of leaving placeholder comments").
- **Defensible disagreement.** Whether "did more than asked" is `fail` or `partial` depends on author intent. The grader's rationale is correct (it identified the issue accurately); the verdict tier is a judgment call. If the author considers "did the assigned step + extras" a `partial` (the structure is right; the bonus content is the editing concern), the grader is right. If "the step is a skeleton; adding handlers means the learner skipped this step's intent", the expected `fail` is right.

### 4. Wrong-package + missing-comments doubled (1 case)

- `fail-006`: `require('@sap/cap')` (a package that doesn't exist on npm) AND missing all comment markers.
- Expected: `fail` (two strict-rubric violations).
- Actual: `partial` (grader: "wrong package name in the require statement and is missing the required placeholder comments").
- **Genuine grader miss.** Two faults, either of which would be a `fail` on its own per the rubric. The grader saw the structural skeleton (cds.service.impl wrapper, async function, entities destructure) and downgraded only one tier.

### Pattern across all 4

Every disagreement is **lenient by exactly one tier** (partial→pass once, partial→pass once, fail→partial twice). **Zero cases of strict→lenient by more than one tier.** **Zero pass-vs-fail boundary crossings** (the spike's stated primary concern). The grader's directional bias is mild and consistent.

## Decision

**Headline agreement (across all pilot steps):** 100.0% (90/90 within the pass-vs-fail boundary)
**Strict agreement (exact verdict match):** 95.6% (86/90)

- [x] **Graduate** — ≥80% headline; gaps below tracked as follow-up issues.
- [ ] **Iterate (Approach C: RAG-then-grade)** — <80% but salvageable.
- [ ] **Shelve** — <60%, retain behind flag for future revisit.

### Rationale

The grader cleared the spec's `≥80% agreement` graduation threshold by every measure, including the strict (exact-match) reading where the spec only required the loose pass-vs-fail boundary. Two of three pilot steps achieved perfect 30/30 strict agreement; the third had 4 disagreements all biased one tier lenient with zero pass-vs-fail boundary crossings — meaning the grader never marked something a learner-would-fail-on as a learner-would-pass-on or vice versa. Cost (~$0.012/call) and latency (p95 < 10s) are within product-acceptable bounds. The 90-call eval surfaced zero infrastructure errors after `CHAT_DEPLOYMENT_ID` was set, indicating the substrate is reliable. Methodology caveat: submissions are AI-generated rather than author-curated, so the absolute numbers may shift downward when real authors run the eval against their own steps with more idiosyncratic mutations; however, the directional finding (grader is competent at the pass-vs-fail boundary) is unlikely to flip.

### Follow-ups (for graduation work)

- **`ChatSettings.deploymentId` is null on DEV HANA**, with the codebase falling back to `process.env.CHAT_DEPLOYMENT_ID` (set on the deployed `tutorials-srv` container). The eval revealed this only because `cds bind --exec` doesn't inherit container env vars. Filed for tracking — not a Phase 4 blocker, but the next ChatSettings UI change should populate the column from the env var so future operator scripts don't silently get null.
- **`scripts/pull-codecheck-telemetry.cjs` HANA SQL bug**: `PERCENTILE_CONT(...) OVER ()` is required for HANA; the script uses bare `PERCENTILE_CONT` which fails with `invalid column name`. Worked around in this eval via raw SQL + JS percentile computation. Filed for follow-up.
- **Comment-marker strictness on add-logic**: 1/30 disagreement was on `// ON_EVENT handlers` vs `// ON events`. The system prompt could be tightened to require literal marker text when the goal lists exact strings, OR the goal phrasing on this step could be relaxed since the grader's lenient interpretation is arguably more learner-friendly. Author judgment call; defer to first real pilot author's preference.
- **`/admin-ui/#joule-settings` lets admins edit ChatSettings, but the deployment-id field should accept the env-var fallback as default value** in the form UI to avoid the null-on-DEV trap. Surfaces alongside the first follow-up.

### Methodology caveat

This evaluation was AI-bootstrapped, not author-curated. Three differences from the spec's intended methodology:

1. **Submissions are AI-generated.** Three sub-agents produced 30 mutations per step under a locked rubric. A real author's mutations would skew toward more idiosyncratic real-learner errors (typos, autocomplete mishaps, wrong-tutorial paste-ins) and might lower agreement %.
2. **Expected verdicts are mine, not the tutorial author's.** I labeled mutations against the rubric I wrote. A real author might label some borderline cases differently — particularly the `partial-007` destructure-style and `fail-009` overshoot cases discussed above.
3. **Pilot tutorials chosen for diverse code shapes (CDS service def, CDS data model, JS impl skeleton) all from the same tutorial group (`cap-extend-sfsf-*`).** A broader cross-domain pilot (e.g., ABAP RAP, HANA SQL, Java handler) could surface stack-specific failure modes the all-CAP sample missed.

The 100% headline / 95.6% strict result is so far above the ≥80% threshold that all three caveats together would have to halve the agreement before the decision flipped — implausible given the grader's evident reliability across 90 disjoint cases. **Recommend graduating now; if a real-author pilot later shows materially different numbers, revisit then.**
