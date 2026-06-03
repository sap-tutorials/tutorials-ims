# Sample submissions for code-check spike (issue #171)

Each `.jsonl` file in this directory is an evaluation set for one tutorial step.
Each line is one submission to grade. Format:

    {"id": "s001", "expectedVerdict": "pass",    "code": "...your code as a JSON string..."}
    {"id": "s002", "expectedVerdict": "partial", "code": "..."}
    {"id": "s003", "expectedVerdict": "fail",    "code": "..."}

## Fields

| Field | Values | Notes |
|---|---|---|
| `id` | any unique string | Identifies the row in the output CSV |
| `expectedVerdict` | `pass`, `partial`, `fail` | Your ground-truth label |
| `code` | string | The learner's submitted code (escape backslashes and quotes per JSON rules) |

## Tips for building good eval sets

- **Aim for 30 submissions per step** you want to evaluate — enough to give a meaningful agreement rate.
- **Spread ~10/10/10 across pass / partial / fail** to expose grader bias on each boundary.
- **Include "off-topic" submissions** (a poem, empty string, gibberish, `null`) — they should all return `verdict=fail`.
- **Include near-miss submissions** — correct algorithm but missing an `await`, wrong variable name, etc. — these land on the pass/fail boundary and stress-test the partial verdict.
- **Include wrong-language submissions** where the spec expects JavaScript but the learner pastes Python. The grader should return `fail` (or `partial` if the approach is otherwise correct and the spec is language-agnostic).
- **Keep IDs sequential** (`s001`, `s002`, ...) so rows sort stably in the output CSV.

## Running the harness

```bash
ALLOW_HYBRID_WRITES=true \
  npx cds bind --exec -- node scripts/evaluate-code-check.js \
  --slug your-tutorial-slug \
  --step 3 \
  --submissions scripts/sample-submissions/your-slug-step-3.jsonl \
  --output verdicts/your-slug-step-3.csv
```

Requires `cf login` to the DEV space and the `ALLOW_HYBRID_WRITES=true` guard (same as hybrid tests).

## Reading the output CSV

The script writes:

```
submission_id, expected, actual, summary, latency_ms, prompt_tokens, completion_tokens
```

Open the CSV, add an **"agree"** column with `TRUE` / `FALSE`, then compute the
agreement rate:

```
agree rate = COUNT(agree = TRUE) / total rows
```

For the Phase 4 decision boundary: treat `partial` as agree when *either* expected
or actual is `partial` — the spike's primary goal is the pass-vs-fail boundary,
not the exact partial definition.

## Example file name convention

```
scripts/sample-submissions/<tutorial-slug>-step-<n>.jsonl
```

For example:

```
scripts/sample-submissions/abap-environment-trial-onboarding-step-3.jsonl
scripts/sample-submissions/cp-apm-alerts-central-store-step-2.jsonl
```
