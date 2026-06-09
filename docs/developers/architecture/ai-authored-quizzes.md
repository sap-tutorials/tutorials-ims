# AI-authored quizzes (issue #208)

AI-authored quizzes are a build-time author opt-in: an author drops an
`[AUTOAUTHOR_*]` directive into a `-Contribution` `rules.vr` file, and
the fetch pipeline calls an LLM to synthesize the question(s) from the
step body. Output is a regular [`ValidationQuestion`](./validation-widget.md)
shape, indistinguishable at runtime from a hand-authored
`[VALIDATE_N]` block. AI free-text questions further flow through the
[free-text grader](./free-text-grader.md) at submit time.

This is the third capability tracked under the
[issue #171](https://github.com/sap-tutorials/tutorials-ims/issues/171)
"AI quiz" vision — sibling to the AI code-check spike (PR #205) and
the free-text grader (PR #234). Same prompt-redaction pattern, same
admin-driven flag, same eval-then-graduate spike playbook.

## End-to-end flow

```text
Author writes [AUTOAUTHOR_N] (or [AUTOAUTHOR_ALL]) in a -Contribution rules.vr
  → scripts/parsers/rules.ts emits a placeholder ValidationQuestion with
    aiAuthored: true (and the directive's :mcq / :text type suffix)
    → scripts/lib/expand-ai-authored.ts walks placeholders during fetch
      → defaultCallModel (srv/lib/code-check-llm.js) — single LLM call per question
        → per-tutorial cache write to .tutorial-cache/<slug>.ai-quiz-cache.json
          (key: stepBody + directive type-suffix + PROMPT_VERSION + modelName)
            → expanded ValidationQuestion[] merged into Hugo frontmatter
              → validation island (hugo-apps/src/validation/Validation.vue) renders
                identically to hand-authored questions

For AI text questions:
  collectAiGradedSpecs (existing path from PR #234) sees ###Grading: ai-judged
    → .tutorial-cache/<slug>.validate-answer.json sidecar
      → publish-validate-answer.js POSTs to /content/validate-answer-specs
        → ValidateAnswerSpecs HANA entity (correctAnswer kept off the wire)
          → at runtime: POST /api/validate-answer grades via free-text grader
```

The expansion happens between parse and frontmatter-emit. By the time
Hugo runs, AI questions are just questions — no special template
codepath, no runtime LLM call for the question body.

## Directive syntax + precedence

| Directive                  | Scope         | Type filter |
| -------------------------- | ------------- | ----------- |
| `[AUTOAUTHOR_N]`           | step `N`      | mixed       |
| `[AUTOAUTHOR_N:mcq]`       | step `N`      | MCQ only    |
| `[AUTOAUTHOR_N:text]`      | step `N`      | text only   |
| `[AUTOAUTHOR_ALL]`         | tutorial-wide | mixed       |
| `[AUTOAUTHOR_ALL:mcq]`     | tutorial-wide | MCQ only    |
| `[AUTOAUTHOR_ALL:text]`    | tutorial-wide | text only   |

Precedence (highest wins):

1. **Hand-authored `[VALIDATE_N]`** for that step always wins. No
   AI call is made for that step — the AI path is strictly opt-in
   _additional_ coverage, never an override.
2. **Per-step `[AUTOAUTHOR_N]`** wins over tutorial-wide.
3. **`[AUTOAUTHOR_ALL]`** expands only on steps that have neither a
   hand-authored question nor a per-step directive.

## Cache invalidation

Per-tutorial JSON cache at `.tutorial-cache/<slug>.ai-quiz-cache.json`.
Each entry is keyed by a SHA-256 hash of:

```text
stepBody          (verbatim from s.content)
\x00              (NUL separator)
directiveSuffix   ('' | 'mcq' | 'text')
\x00
PROMPT_VERSION    (constant in srv/lib/ai-quiz-generator.js)
\x00
modelName         (recorded on first generation)
```

What invalidates an entry:

- **Editing the step body** — hash changes, entry re-generated on next fetch.
- **Bumping `PROMPT_VERSION`** in `srv/lib/ai-quiz-generator.js` — invalidates _all_ entries across all slugs.
- **Deleting the cache file** — manual full re-seed for that slug.

**Model-swap caveat:** changing the runtime model does **not**
auto-invalidate the cache. The hash uses the cached `modelName` (which
is set on first generation), so an existing entry continues to hit
even when the runtime model would now produce different content. To
re-seed under a new model, manually delete
`.tutorial-cache/<slug>.ai-quiz-cache.json` (or the whole
`.tutorial-cache/` directory to force a full re-fetch of the
catalog).

## Cost

| Item                          | Value                              |
| ----------------------------- | ---------------------------------- |
| Per-call cost                 | ~0.005 – 0.012 USD (gpt-4o-class)  |
| Default build cap             | 200 calls (`AI_AUTHOR_BUILD_CAP=200`) |
| Bulk seed cap                 | 10 000 (set by `npm run seed-ai-quizzes`) |
| 10-tutorial pilot (~60 steps) | ~$0.60 first-time, ~$0.00 on rebuild (cache hits) |
| Hard-cap behavior             | Drop-not-fail: over-cap directives silently skipped + logged |

The cap is per-build, not per-tutorial. A pathological "all 1400
tutorials, AUTOAUTHOR_ALL on every step" run would burn ~$80 — and
gets stopped at 200 calls under default config, with the rest logged
as skipped.

## Operator runbook

Tom is the operator. The `seed-ai-quizzes` script uses `cross-env` so
the same invocation works on Linux, macOS, and Windows (cmd /
PowerShell).

### Bulk seed pass

```bash
npm run seed-ai-quizzes
```

### Spike workflow

1. **Pick 5 – 10 pilot slugs** from the catalog covering a mix of
   technologies and tutorial lengths.
2. **Add `[AUTOAUTHOR_*]` directives** to each pilot's `rules.vr` in
   the matching `*-Contribution` repo. Mix per-step and tutorial-wide
   to exercise both precedence paths.
3. **Run the seed pass** (above) to populate `.tutorial-cache/<slug>.ai-quiz-cache.json`.
4. **Verify caches were written:**
   ```bash
   ls .tutorial-cache/*.ai-quiz-cache.json
   ```
5. **Build Hugo + verify locally** that AI questions appear in the
   rendered tutorial pages identically to hand-authored questions.
6. **Run the eval harness:**
   ```bash
   npx tsx scripts/evaluate-ai-quizzes.ts --slugs <comma-list> --output verdicts/eval.csv
   ```
7. **Hand-grade the CSV** — fill `authorWouldShip` with `yes` / `no` /
   `maybe` (lowercase, no surrounding whitespace — see note below) and
   `authorNotes` with a one-line rationale.
8. **Aggregate the verdicts:**
   ```bash
   npx tsx scripts/aggregate-ai-quiz-eval.ts verdicts/eval.csv
   ```
9. **Apply the threshold table** (next section) to decide
   graduate / iterate / shelve.

**Operator note on `authorWouldShip` cell values:** the aggregator
does case-sensitive equality on the literal `'yes'`. `'Yes'`, `'YES'`,
`' yes '` all count as not-yes and silently inflate the no/maybe
buckets. Use lowercase, no whitespace.

## Spike exit criteria

Apply to the aggregated would-ship percentages:

| Result                                          | Action                                                   |
| ----------------------------------------------- | -------------------------------------------------------- |
| Overall ≥ 75% AND MCQ ≥ 80% AND text ≥ 60%      | **Graduate** — drop `AI_AUTHOR_ENABLED` env flag, ship to all tutorials |
| 50% – 74% on either dimension                   | **Iterate** — try v2 prompt (possibly RAG-enriched), re-evaluate |
| < 50%                                           | **Shelve** — retain code behind flag for future model-quality improvements |

The MCQ-specific threshold is higher than text because MCQ has lower
inherent variance — a poor MCQ generator stands out faster than a poor
free-text generator, so the bar is higher to clear.

## Pre-go-live smoke runbook

The pre-go-live smoke (`npm run preflight:ai-quiz-smoke`) is a one-time gate run before the AI-quiz spike graduates (#278). It samples a fraction of the catalog and runs the full pipeline against each sampled tutorial, checking five invariants programmatically.

### When to run

- Before #275 graduation hand-grading (mandatory; see #275's acceptance criteria).
- When a new `promptVersion` lands (e.g. v2 / RAG-enriched prompt). Bump `CURRENT_PROMPT_VERSION` in `scripts/lib/ai-quiz-invariants.ts` to match the generator's `PROMPT_VERSION` first.
- When the runtime model changes (e.g. swap to a newer Claude or different orchestration deployment). Note that switching models doesn't auto-invalidate the per-slug cache — re-run with deleted caches if you want to exercise the LLM path.
- When a schema migration touches `ValidateAnswerSpecs` or the `__aiCorrectAnswer` field on `ValidationQuestion`.

### Cost + wall-clock

10% of ~1,379 = ~138 tutorials × avg ~6 LLM calls per tutorial = ~828 calls × ~$0.01 = **~$8–$14 per run**. Sequential per-slug `cds bind --exec` runs ~30–60 minutes wall-clock.

For cheaper validation (wiring smoke / one-slug debug): `--sample 5` runs in ~5 minutes for ~$0.30. `--dry-run` reads pre-existing caches and is free.

### Running it

Prereqs: `cf login` to DEV space, `cds bind` configured against a HANA DB (e.g. the prod-like DEV `tutorials-db`).

```bash
# Default: 10% of catalog with seed 42
npm run preflight:ai-quiz-smoke

# Reproducible re-run on a canonical seed (operator on any machine — same sample)
npm run preflight:ai-quiz-smoke -- --seed 278

# Smaller sample for tighter feedback
npm run preflight:ai-quiz-smoke -- --sample 20

# Specific slugs (e.g. re-checking a single previously-failing slug)
npm run preflight:ai-quiz-smoke -- --slugs cap-getting-started,abap-cloud-ui-from-interface

# Dry-run against pre-existing cache (no LLM calls, no subprocess)
npm run preflight:ai-quiz-smoke -- --slugs cap-getting-started --dry-run

# Tighter per-tutorial cap (rarely needed; the smoke override default is 10000)
npm run preflight:ai-quiz-smoke -- --build-cap 500
```

`--slugs` overrides sampling. Otherwise `--sample N` (default 10% of catalog) selects via reproducible Fisher-Yates over a sorted catalog.

### Reading the artifact

`verdicts/preflight-smoke.json`:

```json
{
  "safeToGraduate": false,
  "totals": { "passed": 135, "failed": 3, "total": 138 },
  "failedSlugs": ["a", "b", "c"],
  "failuresByInvariant": {
    "no-upstream-errors": 0,
    "precedence": 2,
    "anti-leak": 0,
    "mcq-shape": 1,
    "generator-sanity": 0
  },
  "rows": [ /* per-tutorial details with reasons */ ]
}
```

`safeToGraduate` is the gate: `true` means the AC for #278 is satisfied for this run; `false` means at least one invariant failed somewhere.

### What each invariant means

| Invariant | What it checks | Bug shape it catches |
| --------- | -------------- | -------------------- |
| `no-upstream-errors` | Pipeline summary line shows `0 errors` | PR #261's `cds.entities is not a function` + HTTP 400 contract bug |
| `precedence` | No cache entry for any step in `handAuthoredSteps` | PR #277's regex-substring + case-sensitive `[X]` bugs |
| `anti-leak` | AI text questions have `__aiCorrectAnswer`, no public `correctAnswer` | Future regressions of issue #209's leak-prevention |
| `mcq-shape` | MCQs have 2–4 options and `correctAnswer` ∈ `options` verbatim | Generator emits malformed MCQ |
| `generator-sanity` | `promptVersion` matches expected, `modelName` non-empty, every entry has ≥1 question | Generator silently emits empty entries / stale prompt |

### Triage on failure

Exit codes:

- **0** — `safeToGraduate: true`. Done.
- **2** — Invariant violations. Triage and fix before #275 graduation.
- **3** — Unexpected exception. Read stderr, fix script bug, re-run.

When exit 2 fires:

1. Read `failuresByInvariant`. A single invariant failing on many tutorials usually means a code regression in the AI-quiz pipeline — fix at the source (likely `scripts/parsers/rules.ts`, `scripts/lib/expand-ai-authored.ts`, or `srv/lib/ai-quiz-generator.js`), then re-run the smoke with the same seed: `npm run preflight:ai-quiz-smoke -- --seed <S>`.
2. A single tutorial failing many invariants usually means that tutorial's `rules.vr` is malformed — flag it to the author and skip in the sample (or rebase against a fresh fetch).
3. Re-run a single failing slug to iterate quickly: `npm run preflight:ai-quiz-smoke -- --slugs <slug>`.
4. Do NOT mark #275 graduation acceptable until `safeToGraduate: true`.

### What this is NOT

- Not a recurring CI check. ~$10 per run is too expensive to run weekly to re-find bugs we already shipped.
- Not a quality grader. It checks pipeline mechanics (does the AI run produce a well-shaped artifact?), not whether the questions are good. #275's hand-grading covers quality.
- Not a guardrail against runtime drift. If an AI-quiz cache is freshly produced and the smoke passes, that's evidence at one moment in time. A subsequent generator-prompt or model change requires a re-run.

## Cross-references

- [PR #205](https://github.com/sap-tutorials/tutorials-ims/pull/205) (issue #171 — AI code-check spike; same prompt-redaction + spike pattern)
- [PR #226](https://github.com/sap-tutorials/tutorials-ims/pull/226) (issue #212 — validation widget; AI questions render through it)
- [PR #234](https://github.com/sap-tutorials/tutorials-ims/pull/234) (issue #209 — AI free-text grader; AI text questions submit through it)
- Sibling architecture docs:
  - [Validation widget](./validation-widget.md)
  - [Free-text grader](./free-text-grader.md)
- Spec: [docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md](../../superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md)
- Tracking: [sap-tutorials/tutorials-ims#208](https://github.com/sap-tutorials/tutorials-ims/issues/208)
