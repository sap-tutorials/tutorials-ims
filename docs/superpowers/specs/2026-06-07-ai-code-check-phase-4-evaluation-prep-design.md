# AI Code-Check Phase 4 Evaluation Prep — Design

**Status:** Draft for review
**Tracking issue:** [sap-tutorials/tutorials-ims#210](https://github.com/sap-tutorials/tutorials-ims/issues/210)
**Date:** 2026-06-07
**Author:** Tom Jung (with Claude)
**Refs:** spike spec [2026-06-02-ai-code-check-spike-design.md](2026-06-02-ai-code-check-spike-design.md), shipped in PR #205 (#171)

## Summary

Issue #210 is the Phase 4 evaluation gate of the AI code-check spike (#171). PR #205
shipped the implementation behind `ChatSettings.codeCheckEnabled` (default `false`).
The flag is not yet on in DEV, no pilot authors have added `[CODECHECK_N]` blocks,
and no submissions have been collected. Phase 4's acceptance criteria
(eval-harness runs across ≥3 pilot steps, author-rated agreement %, cost/latency
telemetry, graduate/iterate/shelve decision) all need humans in the loop.

This spec scopes the **operator-side scaffolding** that an agent can productively
ship now to unblock that human work without speculating on outcomes. Net change:
8 new files plus 1 sidebar entry; ~250-350 lines total; no production code paths
touched; no CDS schema changes.

## Goals

1. Give the operator (Tom) a single runbook that walks through Phase 4 end-to-end,
   from flag-flip to decision write-up to issue close-out.
2. Cut copy-paste toil with three small scripts: a JSONL skeleton generator,
   a CSV agreement scorer, and a telemetry puller.
3. Pre-stub the decision doc so the closing artifact is one paste-and-fill away
   when the data is in.
4. Seed a small set of `AnalyticsSavedQuery` rows so ad-hoc poking in
   `/analytics-ui/` reuses the same queries the runbook uses.

## Non-Goals

- Pilot-author one-pager. Pilots are 1-2 people Tom hand-walks; the spike spec
  already documents the `[CODECHECK_N]` block syntax.
- Enabling the flag in DEV. Tom does that manually per PR #205's operator runbook.
- Generating pilot code submissions. The skeleton emits coverage hints only;
  the actual `code` strings are author-supplied.
- Opening follow-up issues. Those depend on the verdict (graduate / iterate / shelve)
  and are written by Tom once the data is in.
- Widening the analytics SQL validator allowlist to admit `PERCENTILE_CONT`. Worth
  a separate change if reuse pressure builds, but not required here — the
  standalone telemetry script bypasses the validator and gets real percentiles.

## Approach

**Operator-side scaffolding only.** Three principles drive every choice:

- **No fabricated content.** The skeleton generator emits `code: ""` plus a
  `_hint` describing the row's coverage role; only the author writes code.
- **Read-only against production data** (the eval harness itself is the lone
  exception — running it writes `CodeCheckSubmissions` rows by design).
- **No new production code paths.** All deliverables sit under `scripts/` or
  `docs/`; nothing changes in `srv/` or `db/`.

## Architecture

```
docs/developers/operations/phase-4-codecheck-eval.md            (runbook)
                                │ §3 invokes
                                ▼
scripts/generate-codecheck-eval-skeleton.cjs                    (skeleton gen)
        ─ reads CodeCheckSpecs via cds bind --exec
        ─ writes scripts/sample-submissions/<slug>-step-<n>.jsonl

                                │ §4 invokes
                                ▼
scripts/evaluate-code-check.js  (already shipped in PR #205)
        ─ writes verdicts/<slug>-step-<n>.csv

                                │ §5 author hand-rates
                                ▼
verdicts/<slug>-step-<n>.csv with `agree` column added

                                │ §6 invokes
                                ▼
scripts/score-codecheck-eval.js                                 (scorer)
        ─ writes verdicts/<slug>-step-<n>-scored.md

                                │ §7 invokes
                                ▼
scripts/pull-codecheck-telemetry.cjs                            (telemetry)
        ─ reads CodeCheckSubmissions via cds bind --exec
        ─ writes verdicts/telemetry-summary.json + Markdown to stdout

                                │ §8 paste into
                                ▼
docs/superpowers/specs/phase-4-codecheck-evaluation.md          (decision template)

scripts/sample-submissions/seed-saved-queries.json              (seed data)
scripts/seed-codecheck-saved-queries.cjs                        (one-time importer)
        ─ INSERTs the 3 rows via cds bind --exec
        ─ idempotent on `name` (use --force to replace existing)
```

## File Inventory

| Path | Kind | Purpose |
|---|---|---|
| `docs/developers/operations/phase-4-codecheck-eval.md` | runbook | Step-by-step Phase 4 procedure |
| `docs/.vitepress/config.ts` | edit | Register runbook in sidebar (predocs:build guard) |
| `scripts/generate-codecheck-eval-skeleton.cjs` | script | Emit a 30-row JSONL skeleton with coverage hints |
| `scripts/score-codecheck-eval.js` | script | Compute agreement % from a hand-rated CSV |
| `scripts/pull-codecheck-telemetry.cjs` | script | Aggregate cost/latency/verdict telemetry |
| `scripts/sample-submissions/seed-saved-queries.json` | seed data | 3 AnalyticsSavedQuery rows for ad-hoc poking |
| `scripts/seed-codecheck-saved-queries.cjs` | importer | INSERTs the seed JSON into AnalyticsSavedQuery via cds bind (idempotent on `name`) |
| `docs/superpowers/specs/phase-4-codecheck-evaluation.md` | template | Pre-stubbed decision doc Tom fills in (date-less filename so it stays accurate when filled in weeks later) |

## Components

### 1. `scripts/generate-codecheck-eval-skeleton.js` (~80 lines)

**CLI:** `--slug <s> --step <n> [--output <path>] [--force]`

**Behavior:**

1. `cds.connect.to('db')`; `SELECT goal, language FROM CodeCheckSpecs WHERE tutorial.slug = ? AND stepNumber = ?` (one row).
2. Default output path: `scripts/sample-submissions/<slug>-step-<n>.jsonl`.
3. **Refuses to overwrite** unless `--force`. Half-curated sets must not be silently clobbered.
4. Emits 30 lines, each one JSON object with `id`, `expectedVerdict`, `code: ""`, and a `_hint` field. The hint is a fixed-template per row index (10/10/10 across pass/partial/fail) drawn from the README's "Tips for building good eval sets" section.
5. The `_hint` field is intentionally undocumented in the harness — `evaluate-code-check.js`'s `JSON.parse` accepts extra keys and ignores them. Authors strip `_hint` if they want, or keep it as inline self-documentation.

**Hint plan (fixed for every step; same coverage shape regardless of language):**

| Range | Verdict | Hint pattern |
|---|---|---|
| s001-s010 | pass | correct/idiomatic; correct/verbose; correct/different-style; correct/uses-author-imports; correct/different-naming; correct/with-comments; correct/early-return-variant; correct/destructuring-variant; correct/minimal; correct/copy-of-reference |
| s011-s020 | partial | missing-await; off-by-one; wrong-error-handling; missing-edge-case; harmless-syntax-issue-but-logic-right; uses-deprecated-but-correct-API; missing-input-validation; correct-but-wrong-naming; right-shape-wrong-helper; correct-with-extraneous-code |
| s021-s030 | fail | off-topic-poem; empty-string; gibberish; wrong-language; opposite-logic; copy-of-prompt-instead-of-code; correct-for-different-step; SQL-injection-shaped; placeholder-todo-comments; null |

**Failure modes:**

- Spec missing → exits 1 with "no CodeCheckSpec for slug=… step=…; has the publish run since the author added the block?".
- Output exists, no `--force` → exits 1 with "use --force to overwrite".
- HANA bind fails → message + exit 1.

### 2. `scripts/score-codecheck-eval.js` (~70 lines)

**CLI:** `--csv <path> [--output <md>]`

**Behavior:**

1. Parses the CSV emitted by `evaluate-code-check.js`. The harness writes
   `submission_id, expected, actual, summary, latency_ms, prompt_tokens, completion_tokens`.
   Author has added an 8th column named `agree` (case-insensitive header match)
   with values in {`TRUE`, `FALSE`, `PARTIAL`}.
2. Validates: `agree` column present, every data row has a value in the allowed
   set; aborts with row numbers if not.
3. Computes:
   - **Headline agreement %** = (TRUE + PARTIAL) / total. Per the spec's
     "treat partial as agree when either expected or actual is partial" rule.
   - **Strict agreement %** = TRUE / total. Diagnostic — shows whether the
     headline is buoyed by the partial-fudge.
   - **3×3 confusion matrix** (rows = expected, cols = actual, cells = count).
   - **EXCEPTION count** = rows where `actual = "EXCEPTION"`. (Note the
     case-sensitive uppercase: `evaluate-code-check.js` writes uppercase
     `EXCEPTION` to the CSV when `dispatchCheckCode` itself throws, while the
     runtime persists lowercase `error` to `CodeCheckSubmissions.verdict` for
     graded-but-failed dispatches. Both are intentional and source-faithful;
     the scorer counts the former, the telemetry script counts the latter.)
4. Prints a Markdown block (or writes to `--output`) ready to paste into the
   decision doc.

**Why include both headline and strict?** The decision threshold (`≥80%` /
`<80%` / `<60%`) is on the headline number per the spec at line 463. The strict
number tells the reader of the decision doc whether the call is robust.

**CSV parsing:** The harness's CSV has well-formed quoting (it `escapeCell`s
cells containing comma/newline/quote). A small custom parser with a 3-state
machine (in-quotes, escaped-quote, between-cells) suffices; no `csv-parse`
dependency needed.

### 3. `scripts/pull-codecheck-telemetry.js` (~90 lines)

**CLI:** `[--since <iso-date>] [--output <path>]`. Default output path:
`verdicts/telemetry-summary.json`.

**Behavior:** Connects via `cds bind --exec`, runs five fixed `SELECT` aggregates,
writes the JSON output and prints a Markdown summary table to stdout.

**The five queries:**

```sql
-- 1. Verdict distribution
SELECT verdict, COUNT(*) AS n
  FROM com_sap_developers_ims_CodeCheckSubmissions
 WHERE createdAt >= ?
 GROUP BY verdict;

-- 2. Latency percentiles (HANA-only — uses PERCENTILE_CONT)
SELECT
  MIN(latencyMs) AS p_min,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latencyMs) AS p50,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latencyMs) AS p95,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latencyMs) AS p99,
  MAX(latencyMs) AS p_max
  FROM com_sap_developers_ims_CodeCheckSubmissions
 WHERE createdAt >= ? AND latencyMs IS NOT NULL;

-- 3. Token cost
SELECT
  AVG(promptTokens)     AS avg_prompt,
  AVG(completionTokens) AS avg_completion,
  SUM(promptTokens + completionTokens) AS total_tokens,
  COUNT(*)              AS n_with_tokens
  FROM com_sap_developers_ims_CodeCheckSubmissions
 WHERE createdAt >= ? AND promptTokens IS NOT NULL;

-- 4. Error breakdown
SELECT errorReason, COUNT(*) AS n
  FROM com_sap_developers_ims_CodeCheckSubmissions
 WHERE createdAt >= ? AND verdict = 'error'
 GROUP BY errorReason;

-- 5. Per-(slug, step) submission count + verdict mix (coverage sanity check)
SELECT tutorialSlug, stepNumber, verdict, COUNT(*) AS n
  FROM com_sap_developers_ims_CodeCheckSubmissions
 WHERE createdAt >= ?
 GROUP BY tutorialSlug, stepNumber, verdict
 ORDER BY tutorialSlug, stepNumber, verdict;
```

These run against HANA via `cds.run(sql, [params])`, **bypassing**
`srv/lib/analytics-sql-validator.cjs` (which sits in the
`AnalyticsService.runSelectQuery` action path, not the database client).
The validator does not list `PERCENTILE_CONT` — see
[srv/lib/ui-event-saved-queries.js:59](srv/lib/ui-event-saved-queries.js#L59)'s
existing TODO comment — so reusing these via Saved Queries is **not** an
option; see component 4.

**Output JSON shape:**

```json
{
  "since": "2026-06-08T00:00:00Z",
  "verdictDistribution": [{"verdict":"pass","n":24},{"verdict":"partial","n":12}, …],
  "latency": {"p_min":340,"p50":1240,"p95":2890,"p99":3410,"p_max":3520},
  "tokens": {"avg_prompt":612,"avg_completion":188,"total_tokens":24000,"n_with_tokens":30},
  "errors": [{"errorReason":"upstream_timeout","n":1}],
  "perStepCoverage": [{"tutorialSlug":"…","stepNumber":3,"verdict":"pass","n":10}, …]
}
```

### 4. `scripts/sample-submissions/seed-saved-queries.json` + `scripts/seed-codecheck-saved-queries.cjs`

Three rows that get INSERTed into `AnalyticsSavedQuery` once per environment
via a small CJS importer. The Analytics Builder UI has no "Import" affordance
— `SavedTab.vue` exposes only list/rename/setVisibility/duplicate/recordRun/remove
— so we seed via `cds bind --exec -- node scripts/seed-codecheck-saved-queries.cjs`.

The three rows (validator-safe aggregates only — no `PERCENTILE_CONT`):

1. **Code-check: verdict distribution by slug+step** —
   `SELECT tutorialSlug, stepNumber, verdict, COUNT(*) AS n FROM CodeCheckSubmissions GROUP BY tutorialSlug, stepNumber, verdict`.
2. **Code-check: latency summary by verdict** —
   `SELECT verdict, COUNT(*) AS n, MIN(latencyMs) AS lat_min, AVG(latencyMs) AS lat_avg, MAX(latencyMs) AS lat_max FROM CodeCheckSubmissions GROUP BY verdict`.
3. **Code-check: token cost by verdict** —
   `SELECT verdict, AVG(promptTokens) AS avg_prompt, AVG(completionTokens) AS avg_completion, SUM(promptTokens + completionTokens) AS total FROM CodeCheckSubmissions GROUP BY verdict`.

Seed JSON shape mirrors the actual `AnalyticsSavedQuery` columns from
[db/analytics-builder.cds:28](../../db/analytics-builder.cds): `{ name,
description, sql, spec, visibility }`. `spec` is `null` for SQL-tab saves
(per the comment at [srv/analytics-service.cds:87](../../srv/analytics-service.cds)
"null for editor/legacy paths"); `visibility` is `'shared-admins'` (NOT `'public'` —
the legal values are `'private' | 'shared-admins'`). The importer uses
`SELECT.one ... where({ name })` for idempotency on name, with `--force` for
delete-then-insert.

**Real percentile latency stays exclusive to `pull-codecheck-telemetry.cjs`.**

### 5. `docs/developers/operations/phase-4-codecheck-eval.md` (runbook)

Sections (each is concrete commands, no prose drift):

1. **Prerequisites** — PR #205 deployed; `cf login`; pilots lined up.
2. **Enable flag in DEV** — copy of PR #205 § "Operator runbook" steps 3, 6, 7.
3. **Coordinate pilots** — 3+ steps total across 1-2 pilots; what makes a good pilot step; rebuild workflow trigger; sanity-check command for the published mount div.
4. **Generate JSONL skeleton** per step — `node scripts/generate-codecheck-eval-skeleton.js …`. Author edits `code` strings using the `_hint` for coverage.
5. **Run eval harness** — the existing `evaluate-code-check.js` invocation.
6. **Author rates the CSV** — open in a sheet app, add `agree` column, save.
7. **Score** — `node scripts/score-codecheck-eval.js …`.
8. **Pull telemetry** — once all steps graded — `node scripts/pull-codecheck-telemetry.js …`.
9. **Fill decision doc** — paste scored.md tables and telemetry summary into `phase-4-codecheck-evaluation.md`; check the verdict box; write rationale.
10. **Comment + close** — comment headline numbers + decision link on #171 and #210; close per outcome.

A short "Troubleshooting" section covers the obvious failure modes
(401, 503, missing CodeCheckSpecs, percentile-on-non-HANA).

### 6. `docs/superpowers/specs/phase-4-codecheck-evaluation.md` (decision template)

Pre-stubbed sections, ready to fill. Filename intentionally has no date prefix
because the document gets filled in and committed weeks after this prep PR
lands; a `2026-06-07` prefix on the filled-in version would mislead readers
about when the evaluation actually concluded.

Sections:

- Pilot tutorials table
- Per-step agreement table (headline, strict, exceptions per step)
- Confusion matrix paste-blocks per step
- Cost & latency table
- Top 3 disagreement categories (free text)
- Decision (3 checkboxes: graduate / iterate / shelve)
- Rationale (3-4 sentences)
- Follow-ups (if Graduate) or Action (if Shelve)

The document gets a real date and `Status: Final` + a PR when Tom commits the
filled-in version. Until then it sits with `Status: Pending Phase 4 data`.

### 7. `docs/.vitepress/config.ts` edit

Register the runbook in `themeConfig.sidebar` under the existing
`/developers/operations/` group. The `predocs:build` guard rejects unregistered
pages, so this is required. One-line addition.

## Data

No CDS changes. Three existing entities are read:

- `CodeCheckSpecs` — read by skeleton generator (`goal`, `language` fields).
- `CodeCheckSubmissions` — read by telemetry script (verdict, latency,
  prompt/completion tokens, errorReason, createdAt, tutorialSlug, stepNumber).
- `AnalyticsSavedQuery` — written once by importing the seed JSON via the
  Analytics Builder UI.

## Failure Modes

| Failure | Surface | Mitigation |
|---|---|---|
| Skeleton overwrites curated JSONL | Author loses ~hours of work | `--force` flag; default refuses |
| `_hint` field breaks downstream tooling | Eval harness fails to parse | Harness already accepts arbitrary keys; no risk |
| Percentile query rejected by HANA | Telemetry script crashes | Script targets HANA only — documented in runbook troubleshooting |
| Operator imports seed before analytics-ui exists | Seed import fails | Runbook places seed import as optional after step 8 |
| CSV parser misreads quoted cell with embedded `,` | Score off | Custom parser exercises the harness's escapeCell shape; unit-tested |
| Tom forgets to flip flag back if shelving | Code stays live | Runbook §10 includes "if shelve" sub-step |

## Testing

Each script gets a small unit test (project convention: `test/unit/<topic>.test.js`).

- **`generate-codecheck-eval-skeleton.test.js`** — emits 30 rows, the right
  10/10/10 verdict mix, refuses overwrite without `--force`. Mocks the DB read.
- **`score-codecheck-eval.test.js`** — fixture CSV → expected scored Markdown;
  also a malformed-`agree` fixture should error with row number.
- **`pull-codecheck-telemetry.test.js`** — mocks `cds.run`; asserts the five
  query shapes and the JSON output structure. Doesn't test HANA syntax —
  that's exercised the first time Tom runs it for real (cheap, low-risk).

No hybrid test (the harness itself already has hybrid coverage in PR #205).
No smoke test (none of these run on the deployed app).

The seed JSON is exercised by the operator at import time; no unit test would
catch a real failure there better than the import error would.

## Open Questions

- **Should `scripts/sample-submissions/*.jsonl` be gitignored?** Pilot author
  code may be repo-specific solutions they'd rather not commit. The README in
  that directory is permanent; the JSONL files generated post-pilot have value
  for regression but might leak IP. **Recommendation:** add
  `scripts/sample-submissions/*.jsonl` to `.gitignore` initially; revisit if
  Tom or pilots want them committed for replay value. `verdicts/` is already
  gitignored.

## Rollout

One PR (`feat(codecheck): Phase 4 evaluation prep (#210)`):

- All 7 files added/edited.
- Unit tests passing.
- `npm run docs:build` green (sidebar guard).
- No deploy required — scripts run locally via `cds bind`; runbook + decision
  template are docs only.

When this PR merges, Tom can start Phase 4 the same day by following the
runbook from §1.
