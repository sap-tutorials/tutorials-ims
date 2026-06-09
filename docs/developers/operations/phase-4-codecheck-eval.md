# Phase 4 — AI code-check spike evaluation

Runbook for [issue #210](https://github.com/sap-tutorials/tutorials-ims/issues/210)
(follow-up to [#171](https://github.com/sap-tutorials/tutorials-ims/issues/171),
shipped in [PR #205](https://github.com/sap-tutorials/tutorials-ims/pull/205)).
Walks through the post-deploy evaluation cycle that drives the
graduate / iterate / shelve decision.

## Prerequisites

- PR #205 deployed to DEV (verify: `curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/health`).
- `cf login` to the `tutorial-system / dev` space.
- 1-2 pilot authors lined up (each owning a `*-Contribution` repo).

## 1. Enable the flag in DEV

In `/admin-ui/#joule-settings`, set `ChatSettings.codeCheckEnabled = true`.
(Or via `cds query`: see PR #205 § "Operator runbook" steps 3, 6, 7.)

## 2. Coordinate pilot tutorials

- Choose 3+ steps total across 1-2 pilots (acceptance criterion is ≥3 steps).
- Pick code-heavy steps where the author has a clear reference solution.
- Author adds `[CODECHECK_N]` blocks per the spike spec § "rules.vr CODECHECK block".
- Trigger `rebuild-content.yml` (full or per-slug). Confirm the mount div is published:

  ```bash
  curl -s https://.../tutorials/<pilot-slug>/ | grep step-codecheck-mount
  ```

## 3. Generate JSONL skeleton per step

```bash
npx cds bind --exec -- node scripts/generate-codecheck-eval-skeleton.cjs \
  --slug <pilot-slug> --step <n>
```

The author edits `scripts/sample-submissions/<slug>-step-<n>.jsonl` to fill
in the 30 `code` strings, using the per-row `_hint` for coverage guidance.

## 4. Run the eval harness per step

```bash
ALLOW_HYBRID_WRITES=true \
  npx cds bind --exec -- node scripts/evaluate-code-check.js \
  --slug <pilot-slug> --step <n> \
  --submissions scripts/sample-submissions/<slug>-step-<n>.jsonl \
  --output verdicts/<slug>-step-<n>.csv
```

## 5. Author rates the CSV

Open `verdicts/<slug>-step-<n>.csv` in a sheet app. Add an `agree` column
with values `TRUE`, `FALSE`, or `PARTIAL` per row. Save back to the same path.

Rule: treat `PARTIAL` as agree when **either** expected or actual is `partial`
— the spike's primary goal is the pass-vs-fail boundary.

## 6. Score

```bash
node scripts/score-codecheck-eval.js \
  --csv verdicts/<slug>-step-<n>.csv \
  --output verdicts/<slug>-step-<n>-scored.md
```

Prints a Markdown block with headline %, strict %, and a 3×3 confusion matrix.

## 7. Pull telemetry once all steps are graded

```bash
npx cds bind --exec -- node scripts/pull-codecheck-telemetry.cjs \
  --since <date-flag-was-flipped> \
  --output verdicts/telemetry-summary.json
```

(One-time, optional) Seed the three canned `AnalyticsSavedQuery` rows so
ad-hoc poking in `/analytics-ui/` reuses the same shape:

```bash
npx cds bind --exec -- node scripts/seed-codecheck-saved-queries.cjs
```

The seed script is idempotent on `name` — re-running it skips existing rows
unless you pass `--force`. It uses validator-safe aggregates only; real
percentile latency stays exclusive to `pull-codecheck-telemetry.cjs`.

## 8. Fill the decision doc

1. Open `docs/superpowers/specs/phase-4-codecheck-evaluation.md`.
2. Paste each `*-scored.md` block into the per-step section.
3. Paste `telemetry-summary.json`'s Markdown into the Cost & latency section.
4. Check the verdict box (graduate / iterate / shelve) per spec thresholds:
   - **≥80% headline** → graduate
   - **<80% but salvageable** → iterate (Approach C: RAG-then-grade)
   - **<60%** → shelve (retain code behind flag)
5. Fill rationale in 3-4 sentences.

## 9. Comment + close

- Comment headline numbers + decision link on **#171** and **#210**.
- Close **#210** (with link to merged decision-doc PR).
- If the verdict is "graduate", **#171** stays open with linked sub-issues.
- If "shelve", close **#171** too — code stays behind the flag.

## Troubleshooting

- **401 on `/api/codecheck`** — token expired; refresh with `cf-bearer-token`.
- **503 on `/api/codecheck`** — flag is off; re-check `ChatSettings.codeCheckEnabled`.
- **0 CodeCheckSpecs returned by skeleton generator** — publish-content didn't
  ship sidecars for that slug; re-trigger `rebuild-content.yml`.
- **HANA error on `PERCENTILE_CONT`** — telemetry script targets HANA only.
  Running it with an in-memory SQLite binding fails. Use a real `cf login` + `cds bind`.
- **"Refusing to overwrite"** from skeleton generator — pass `--force` only if
  the existing JSONL is intentionally being regenerated; half-curated content
  is otherwise destroyed.
