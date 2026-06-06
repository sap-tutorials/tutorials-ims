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

Tom is the operator. The npm script `seed-ai-quizzes` uses POSIX
env-prefix syntax which doesn't work on cmd / PowerShell, so the
Windows incantations are listed alongside.

### Bulk seed pass

**POSIX (Linux / macOS / Git Bash):**

```bash
npm run seed-ai-quizzes
```

**Windows PowerShell:**

```powershell
$env:AI_AUTHOR_ENABLED='true'; $env:AI_AUTHOR_BUILD_CAP='10000'; npm run fetch-tutorials
```

**Windows cmd.exe:**

```cmd
set AI_AUTHOR_ENABLED=true&& set AI_AUTHOR_BUILD_CAP=10000&& npm run fetch-tutorials
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

## Cross-references

- [PR #205](https://github.com/sap-tutorials/tutorials-ims/pull/205) (issue #171 — AI code-check spike; same prompt-redaction + spike pattern)
- [PR #226](https://github.com/sap-tutorials/tutorials-ims/pull/226) (issue #212 — validation widget; AI questions render through it)
- [PR #234](https://github.com/sap-tutorials/tutorials-ims/pull/234) (issue #209 — AI free-text grader; AI text questions submit through it)
- Sibling architecture docs:
  - [Validation widget](./validation-widget.md)
  - [Free-text grader](./free-text-grader.md)
- Spec: [docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md](../../superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md)
- Tracking: [sap-tutorials/tutorials-ims#208](https://github.com/sap-tutorials/tutorials-ims/issues/208)
