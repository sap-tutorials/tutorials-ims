# Meta-Tutorials Showcase for AI Features — Design Spec

**Status:** Draft for review
**Tracking issue:** [sap-tutorials/tutorials-ims#382](https://github.com/sap-tutorials/tutorials-ims/issues/382)
**Date:** 2026-06-18
**Author:** Tom Jung (with Claude)

## Summary

Build a **mission** titled *"Tutorial Platform Features for Authors"* containing four self-referential tutorials that demonstrate the platform's recently shipped AI features and new authoring syntax. Source markdown lives in a new `tutorials/` folder inside the existing `sap-tutorials/meta-tutorials` repo (currently excluded from the build). A new path-prefix filter lets that folder participate in the build pipeline while leaving the run-book and other meta-content excluded. Quiz/validation companion files live in a new `sap-tutorials/meta-tutorials-Contribution` repo. The mission is registered post-publish by a Center Admin via `/admin-ui/#missions-display`.

These tutorials are simultaneously (a) a copy-pasteable reference for authors learning the syntax, linked from [docs/authors/writing-tutorials.md](../../authors/writing-tutorials.md), and (b) live demonstrations of the features at developers.sap.com. The worked subject matter is tutorial-authoring itself, so each tutorial's quiz / code-check / generated questions are *about* the platform feature being demonstrated.

## Goals

1. **Author reference + live demo.** A learner reading developers.sap.com should be able to take each tutorial end-to-end with the AI feature live. An author reading the GitHub source should be able to copy the markdown verbatim into their own tutorial.
2. **Showcase every author-visible new feature.** Cover three AI features (code-check, free-text grader, AI-authored quizzes) and six recent non-AI syntax additions (OS-conditional content, generic option blocks, branched tutorials, skip-runs, mermaid diagrams, codetabs, glossary tooltips, lightbox).
3. **Minimize repo disruption.** The existing `meta-tutorials/run-book/` and `task-interview-coach/` content stays put and stays out of the build. Only the new `tutorials/` subfolder participates.
4. **Self-referential learning loop.** The validation content asks questions about tutorial authoring; the code-check accepts a small `rules.vr` snippet; the AUTOAUTHOR demo step body is itself about the parser. The medium IS the message.

## Non-Goals

- **Migrating the existing `meta-tutorials/run-book/` content** to tutorial format. Run-book stays as administrative documentation, not platform tutorials.
- **A standalone admin-facing "how to enable codecheck" tutorial.** Admin operations are documented in [center-admin.md](../../authors/center-admin.md), not the developers.sap.com tutorial set.
- **Authoring tooling enhancements** (VS Code extension demos, frontmatter validators). Out of scope for this content; covered separately when those tools ship.
- **A standalone branched-missions demo tutorial.** The mission-level alt-groups feature is already demonstrated in production groups; covering it here would conflict with the mission these tutorials are themselves part of.
- **Coverage of pre-existing legacy syntax.** V1 parser (ACCORDION-BEGIN/END), absolute image URLs, and other legacy patterns are explicitly *not* showcased — only post-2026 additions.

## Approach

A four-tutorial mission, with markdown source in `sap-tutorials/meta-tutorials/tutorials/`, validation files in a new `sap-tutorials/meta-tutorials-Contribution`, and a one-line pipeline change to allowlist the new folder for fetching.

Two approaches considered and rejected:

- **A — Standalone new repo (`tutorial-platform-demos`).** Cleaner conceptual separation but adds a third tutorial repo to maintain, requires new GitHub-Actions wiring on the new repo for repo-dispatch, and creates an artificial split between "platform showcase" and "platform admin docs" that already coexist in `meta-tutorials`.
- **B — Restructure `meta-tutorials` to fully participate in the build.** Would require either tutorial-shaping the run-book content (it's not tutorial-shaped — it's an admin run-book) or moving the run-book elsewhere. Larger scope than the issue calls for.

Approach C, the chosen path, **adds a folder-scoped allowlist** to keep `meta-tutorials` mostly excluded but let `tutorials/` ship.

## Architecture

```text
sap-tutorials/meta-tutorials/                    (existing repo)
├── README.MD                                    (unchanged, NOT fetched)
├── run-book/                                    (unchanged, NOT fetched)
├── task-interview-coach/                        (unchanged, NOT fetched)
└── tutorials/                                   (NEW — fetched into Hugo build)
    ├── use-codecheck-to-ai-grade-reader-code.md
    ├── use-codecheck-to-ai-grade-reader-code/
    │   ├── 001-rules-vr-overview.png
    │   └── 002-codecheck-grading-result.png
    ├── use-validate-to-ai-grade-free-text-answers.md
    ├── use-validate-to-ai-grade-free-text-answers/
    │   └── 001-text-answer-feedback.png
    ├── use-autoauthor-to-generate-quiz-questions.md
    ├── use-autoauthor-to-generate-quiz-questions/
    │   └── 001-build-time-generation.png
    └── tutorial-platform-feature-cookbook.md

sap-tutorials/meta-tutorials-Contribution/       (NEW repo, parallels meta-tutorials)
└── tutorials/
    ├── use-codecheck-to-ai-grade-reader-code.rules.vr
    ├── use-validate-to-ai-grade-free-text-answers.rules.vr
    └── use-autoauthor-to-generate-quiz-questions.rules.vr
    (cookbook has no rules.vr — auto_validation: false)
```

### Mission registration (post-publish)

The mission itself is a `Missions` row in HANA, created via `/admin-ui/#missions-display` after the four tutorials successfully publish:

| Field | Value |
|-------|-------|
| Title | Tutorial Platform Features for Authors |
| Slug | `tutorial-platform-features-for-authors` |
| Experience level | Intermediate |
| Tutorials (ordered) | 1. `use-codecheck-to-ai-grade-reader-code`<br>2. `use-validate-to-ai-grade-free-text-answers`<br>3. `use-autoauthor-to-generate-quiz-questions`<br>4. `tutorial-platform-feature-cookbook` |
| Description | Short paragraph linking back to the writing-tutorials docs |
| Primary tag | `tutorial>intermediate` |
| Secondary tag | `software-product-function>sap-developer-center` (verify presence; fall back to closest if not in taxonomy) |

Mission slugs are subject to the same `@assert.unique.slug` constraint as tutorial slugs ([project_fix_duplicate_slugs]). The chosen slug is unlikely to collide but the constraint will surface any conflict at insert time.

## Pipeline change: folder-scoped allowlist

The single substantive code change is in [scripts/parsers/github.ts](../../../scripts/parsers/github.ts).

**Current state** (line 25):
```ts
export const EXCLUDED_REPOS = new Set(['tutorials-ims', 'meta-tutorials'])
```

`meta-tutorials` is currently excluded wholesale; both `discoverAllTutorials` paths (lines 432 and 483) skip it.

**Target state:**
```ts
export const EXCLUDED_REPOS = new Set(['tutorials-ims'])
export const REPO_PATH_FILTERS: Record<string, RegExp> = {
  // meta-tutorials hosts admin run-books and tutorial-system meta-skills.
  // Only the tutorials/ subfolder participates in the public tutorial build.
  'meta-tutorials': /^tutorials\//,
}
```

Every code path that today skips a repo via `EXCLUDED_REPOS.has(...)` is augmented with: when the repo has a path filter, also skip any file whose path doesn't match the filter regex. The two relevant call sites are inside the `for (const repo of repos)` loops at [scripts/parsers/github.ts:432](../../../scripts/parsers/github.ts#L432) and [scripts/parsers/github.ts:483](../../../scripts/parsers/github.ts#L483); both iterate per-file inside the repo and need to consult `REPO_PATH_FILTERS[repo.name]` before deciding to enqueue a file.

The `<repo>-Contribution` resolver already keys off the base repo name, so `meta-tutorials-Contribution` is automatically picked up as the source of `rules.vr` files for tutorials sourced from `meta-tutorials/tutorials/`.

## Tutorial-by-tutorial content

Each tutorial follows the standard frontmatter + intro + steps shape from [docs/authors/writing-tutorials.md](../../authors/writing-tutorials.md). The actual prose is written during implementation; this section sets the structure.

### Tutorial 1 — `use-codecheck-to-ai-grade-reader-code`

**Pitch:** Let an AI grade the code your reader writes, against a reference solution.

**Frontmatter:**
```yaml
parser: v2
auto_validation: true
primary_tag: tutorial>intermediate
tags: [tutorial>intermediate, software-product-function>sap-developer-center]
time: 15
author_name: <author>
author_profile: <gh url>
```

**Steps:**
1. **What the `[CODECHECK_N]` directive does** — reader-facing experience (paste-code text area, AI feedback inline). Screenshot.
2. **The `rules.vr` block format** — code fence showing a `[CODECHECK_3]` block with `referenceCode`, `language`, `criteria`. Cross-link to the spec.
3. **A worked example** — author wants the reader to write 3-line YAML frontmatter. Step shows reference solution + the rules.vr block.
4. **Try it yourself** — *live demo.* Reader pastes a small CDS entity definition. Companion `rules.vr` has a real `[CODECHECK_4]` block. AI grades.
5. **Enabling code-check on your tutorial** — admin-toggle gotcha: `ChatSettings.codeCheckEnabled` must be on. Notes the per-step rate-limit (5/5min) and per-user (30/hr).

**Companion `rules.vr`:** one `[CODECHECK_4]` block matching step 4 with a small CDS entity reference solution.

### Tutorial 2 — `use-validate-to-ai-grade-free-text-answers`

**Pitch:** Ask open-ended questions; AI grades for correctness, not exact match.

**Frontmatter:** same shape as Tutorial 1, `time: 10`.

**Steps:**
1. **Why free-text grading?** — vs MCQ.
2. **The `[VALIDATE_N]` text-style block** — code fence showing the rules.vr syntax with a question, expected concept, and grading criteria.
3. **Worked example: explaining "group" vs "mission"** — author shows the rules.vr they would write.
4. **Try it yourself** — *live demo.* Asks the reader: "In your own words, what's the difference between a *group* and a *mission* in the tutorial system?" Real text input + AI grader.
5. **What good criteria look like** — best practices for the `criteria` field. Anti-patterns ("don't expect exact wording", "give multiple acceptable concepts").

**Companion `rules.vr`:** one `[VALIDATE_4]` text-style block with the group-vs-mission question.

### Tutorial 3 — `use-autoauthor-to-generate-quiz-questions`

**Pitch:** Tag a step with `[AUTOAUTHOR_N]` and the build pipeline generates the quiz for you.

**Frontmatter:** `time: 15`.

**Steps:**
1. **What `[AUTOAUTHOR_*]` does** — single sentence: build calls an LLM with the step body and writes a `ValidationQuestion` for you. Notes build-time vs runtime distinction.
2. **The directive forms** — `[AUTOAUTHOR_N]`, `[AUTOAUTHOR_N:mcq]`, `[AUTOAUTHOR_N:text]`, `[AUTOAUTHOR_ALL]`. Precedence rules (hand-authored always wins).
3. **The build cap and cache** — `AI_AUTHOR_ENABLED`, per-tutorial content-hash cache, `seed-ai-quizzes` script. Cache-bust gotcha when changing models.
4. **Demo step with auto-generated MCQ** — body has substantive content about parsers (V2 vs legacy V1). Companion `rules.vr` has `[AUTOAUTHOR_4:mcq]`.
5. **Demo step with auto-generated free-text** — `[AUTOAUTHOR_5:text]`.
6. **When to use AUTOAUTHOR vs hand-authored** — guidance.

**Companion `rules.vr`:** `[AUTOAUTHOR_4:mcq]` and `[AUTOAUTHOR_5:text]` directives only.

### Tutorial 4 — `tutorial-platform-feature-cookbook`

**Pitch:** Six new authoring features at a glance, with copy-pasteable demos.

**Frontmatter:** `time: 20`, `auto_validation: false` (no rules.vr).

**Steps:**
1. **OS-conditional content** — uses `[OPTION BEGIN [Windows]]` / `[OPTION BEGIN [Mac and Linux]]` for the step body itself. Live demo: reader sees one variant per their detected OS; global picker functional.
2. **Generic option blocks** — `[OPTION BEGIN [JSON]] / [OPTION BEGIN [XML]]` per-step tabs (independent of OS picker).
3. **Branched tutorials with `[BRANCH_BEGIN ...]`** — actually creates a real branch group inside this step ("HANA Cloud" vs "PostgreSQL"). Reader picks one. Cross-link to [branched-tutorials.md](../../authors/branched-tutorials.md).
4. **Skip-runs with `skipIf`** — shows the per-step frontmatter syntax. (Single-tutorial context can only show syntax, not full skip-run behavior.)
5. **Mermaid diagrams** — `{{< mermaid >}}` shortcode with a small flowchart. Renders inline with Horizon palette.
6. **Codetabs (multi-language code blocks)** — same code in `js`, `ts`, `cds`. Cross-tab sync.
7. **Glossary tooltips** — first-mention of an SAP acronym (CDS, CAP, BTP) auto-decorates with a popover.
8. **Lightbox on images** — single screenshot embedded; clicking opens the full-size lightbox with zoom/pan.

## Feature flag handling

| Flag | Where set | Required for | Action before merge |
|------|-----------|--------------|---------------------|
| `ChatSettings.codeCheckEnabled` | HANA `ChatSettings` row, admin-toggled | Tutorial 1 (CODECHECK live demo) | Confirm `true` on DEV; verify via `/admin-ui/#operations-display`. Same on prod before prod-ship. ([feedback_check_chatsettings_after_deploy]) |
| `AI_AUTHOR_ENABLED` env var | CI workflow `rebuild-content.yml` | Tutorial 3 (AUTOAUTHOR live demo) | Add to workflow `env:` block. Run `npm run seed-ai-quizzes` once on DEV to pre-warm cache. |
| `AI_AUTHOR_BUILD_CAP` | CI env var | Tutorial 3 | Cap at 50 per build (sufficient for 4 tutorials × ~6 steps × 2 question-types). |

The free-text grader has no separate enable-flag — it inherits the same enable path as MCQ validation. No flag flip needed for Tutorial 2.

## Validation gates

1. **Hugo build** — `npm run build:all` must complete with no errors against the new tutorials.
2. **`npm run lint:tutorial-markdown`** — markdown linter ([project_tutorial_markdown_lint]) passes on each file.
3. **rules.vr parses cleanly** — `parseRulesVrEnriched` covers this; malformed rules.vr fails the build.
4. **github.ts unit test** — new test exercises the path filter: `meta-tutorials/README.MD` excluded; `meta-tutorials/tutorials/foo.md` included.
5. **Live deploy validation history** — added to the tutorials-ims PR per [feedback_default_off_flags_need_live_smoke]:

| Tutorial | "Did it work?" check on DEV |
|---|---|
| `use-codecheck-to-ai-grade-reader-code` | Open the rendered page. Step 4 paste-code area visible. Submit a deliberately wrong CDS entity → AI returns specific feedback identifying the error. Submit reference solution → "looks good." |
| `use-validate-to-ai-grade-free-text-answers` | Step 4 text input visible. Submit gibberish → low score + reason. Submit a correct group-vs-mission definition → high score. |
| `use-autoauthor-to-generate-quiz-questions` | After CI build with `AI_AUTHOR_ENABLED=true`, the rendered page's `<script id="tutorial-data">` JSON contains real questions for steps 4–5 with `aiAuthored: true`. Visible MCQ + text-style widgets render. |
| `tutorial-platform-feature-cookbook` | OS picker functional. BRANCH picker on step 3 functional. Mermaid renders. Codetabs sync. Glossary tooltip on first SAP acronym. Lightbox opens on image click. |

## PR scope

### `sap-tutorials/tutorials-ims` PR

| File | Change |
|------|--------|
| [scripts/parsers/github.ts](../../../scripts/parsers/github.ts) | Remove `'meta-tutorials'` from `EXCLUDED_REPOS`; add `REPO_PATH_FILTERS` map; apply filter in both `discoverAllTutorials` paths (lines ~432 and ~483). |
| `scripts/parsers/__tests__/github.test.ts` | Add unit test exercising the filter: meta-tutorials root files (README.MD, run-book/*) excluded; `tutorials/*.md` included. |
| [docs/authors/writing-tutorials.md](../../authors/writing-tutorials.md) | Add "Live examples" callout at top of §3 linking to all 4 tutorial URLs. |
| [.github/workflows/rebuild-content.yml](../../../.github/workflows/rebuild-content.yml) | Add `AI_AUTHOR_ENABLED=true` and `AI_AUTHOR_BUILD_CAP=50` to env block. |
| `docs/superpowers/specs/2026-06-18-meta-tutorials-ai-features-design.md` | This spec. |

### `sap-tutorials/meta-tutorials` PR

The 4 markdown files, image folders, README cross-link to the new `tutorials/` folder, no changes to existing run-book content.

### `sap-tutorials/meta-tutorials-Contribution` PR

Repo creation (one-time) + 3 rules.vr files (cookbook has none).

## Deployment sequence

1. Merge `meta-tutorials-Contribution` PR (rules.vr files).
2. Merge `meta-tutorials` PR (the four .md tutorials + images).
3. Merge `tutorials-ims` PR (the github.ts filter change + this design doc + workflow env vars).
4. CI on tutorials-ims fires (or manual `workflow_dispatch` with `slug=` empty for full rebuild).
5. Center Admin creates the mission via `/admin-ui/#missions-display`. (Mission can't reference tutorials that don't exist yet in `Tutorials` table — order matters.)
6. Smoke-test the 4 slugs per the validation table above.
7. Update [docs/authors/writing-tutorials.md](../../authors/writing-tutorials.md) §3 cross-links if not already merged in step 3.
8. Note in next [docs/authors/center-admin.md](../../authors/center-admin.md) review cycle.

## Risks and open questions

1. **AUTOAUTHOR cache stability** — if the runtime model changes between writing the spec and merge, auto-generated questions for Tutorial 3 shift. Mitigation: accept drift and call it out in the tutorial body itself ("the questions you see may differ from these screenshots if the model has been updated"). Consistent with the design of [project_208_ai_authored_quizzes_shipped].
2. **`auto_validation: false` on the cookbook** — confirm that omitting (or setting false) `auto_validation` doesn't trigger a `404` on `<slug>.rules.vr` fetch. From `fetchRulesVr`'s null-on-miss behavior, this should be benign — but worth a smoke check during implementation.
3. **Mission slug collision** — `tutorial-platform-features-for-authors` is unlikely to collide; `@assert.unique.slug` constraint will catch it at insert time if it does.
4. **Existing meta-tutorials content tripping the build** — the new filter excludes `README.MD` and `run-book/`, but anything else under `tutorials/` would auto-fetch. Since we're creating that folder fresh, low risk. Monitor the next CI run for unexpected fetched files.
5. **Tag presence** — `software-product-function>sap-developer-center` may not exist in the platform's tag taxonomy. Verify before mission creation; fall back to `software-product>sap-business-technology-platform` or omit the secondary tag if no exact match.
6. **Self-referential maintenance** — these tutorials describe platform syntax. If syntax changes, they go stale. They should be linked from author docs as living examples and updated when those docs change. Add a one-line note in the cookbook's intro that the tutorial set is co-maintained with [writing-tutorials.md](../../authors/writing-tutorials.md).

## References

- Issue: [sap-tutorials/tutorials-ims#382](https://github.com/sap-tutorials/tutorials-ims/issues/382)
- AI code-check spec: [2026-06-02-ai-code-check-spike-design.md](2026-06-02-ai-code-check-spike-design.md)
- Free-text grader spec: [2026-06-04-209-free-text-grader-design.md](2026-06-04-209-free-text-grader-design.md)
- AI-authored quizzes spec: [2026-06-05-208-ai-authored-quizzes-design.md](2026-06-05-208-ai-authored-quizzes-design.md)
- Validation widget spec: [2026-06-04-212-validation-widget-modernisation-design.md](2026-06-04-212-validation-widget-modernisation-design.md)
- Author writing guide: [docs/authors/writing-tutorials.md](../../authors/writing-tutorials.md)
- Branched tutorials guide: [docs/authors/branched-tutorials.md](../../authors/branched-tutorials.md)
- meta-tutorials repo: <https://github.com/sap-tutorials/meta-tutorials>
- Local meta-tutorials checkout: `D:\projects\meta-tutorials`
