# Meta-Tutorials Showcase for AI Features — Design Spec

**Status:** Draft for review
**Tracking issue:** [sap-tutorials/tutorials-ims#382](https://github.com/sap-tutorials/tutorials-ims/issues/382)
**Date:** 2026-06-18
**Author:** Tom Jung (with Claude)

## Summary

Build a **mission** titled *"Tutorial Platform Features for Authors"* containing four self-referential tutorials that demonstrate the platform's recently shipped AI features and new authoring syntax. Source markdown lives in a new `tutorials/` folder inside the existing `sap-tutorials/meta-tutorials` repo (currently excluded from the build), with each tutorial in its own `tutorials/<slug>/<slug>.md` folder per platform convention. Removing `meta-tutorials` from `EXCLUDED_REPOS` is sufficient to bring the new content into the build — the discovery layer already only reads the `tutorials/` subtree, so `run-book/`, `task-interview-coach/`, and root-level files like `README.MD` remain invisible without any extra filter. Quiz/validation companion files live in a new `sap-tutorials/meta-tutorials-Contribution` repo with the same folder-per-slug layout. The mission is registered post-publish by a Center Admin via `/admin-ui/#missions-display`.

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
sap-tutorials/meta-tutorials/                                          (existing repo)
├── README.MD                                                          (unchanged, NOT fetched)
├── run-book/                                                          (unchanged, NOT fetched — sibling of tutorials/)
├── task-interview-coach/                                              (unchanged, NOT fetched — sibling of tutorials/)
└── tutorials/                                                         (NEW — fetched)
    ├── use-codecheck-to-ai-grade-reader-code/
    │   ├── use-codecheck-to-ai-grade-reader-code.md
    │   ├── 001-rules-vr-overview.png
    │   └── 002-codecheck-grading-result.png
    ├── use-validate-to-ai-grade-free-text-answers/
    │   ├── use-validate-to-ai-grade-free-text-answers.md
    │   └── 001-text-answer-feedback.png
    ├── use-autoauthor-to-generate-quiz-questions/
    │   ├── use-autoauthor-to-generate-quiz-questions.md
    │   └── 001-build-time-generation.png
    └── tutorial-platform-feature-cookbook/
        └── tutorial-platform-feature-cookbook.md
        (no images — all-text demo)

sap-tutorials/meta-tutorials-Contribution/                             (NEW repo, parallels meta-tutorials)
└── tutorials/
    ├── use-codecheck-to-ai-grade-reader-code/
    │   └── rules.vr
    ├── use-validate-to-ai-grade-free-text-answers/
    │   └── rules.vr
    └── use-autoauthor-to-generate-quiz-questions/
        └── rules.vr
    (cookbook has no rules.vr — auto_validation: false)
```

The folder-per-slug layout matches the platform convention enforced by [scripts/parsers/github.ts:445](../../../scripts/parsers/github.ts#L445) (`entries.filter(e => e.type === 'tree')`) and the fetch URL at [scripts/fetch-tutorials.ts:135](../../../scripts/fetch-tutorials.ts#L135) (`tutorials/<slug>/<slug>.md`). The contribution-repo `rules.vr` lookup at [scripts/parsers/github.ts:774](../../../scripts/parsers/github.ts#L774) (`tutorials/<slug>/rules.vr`) mirrors this shape.

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

## Pipeline change

The single substantive code change is one line in [scripts/parsers/github.ts](../../../scripts/parsers/github.ts).

**Current state** (line 25):

```ts
export const EXCLUDED_REPOS = new Set(['tutorials-ims', 'meta-tutorials'])
```

**Target state:**

```ts
export const EXCLUDED_REPOS = new Set(['tutorials-ims'])
```

That's the entire change. No new filter machinery is needed because the discovery layer already only reads the `tutorials/` subtree of each repo:

- The GraphQL discovery path queries `object(expression: "HEAD:tutorials")` ([scripts/parsers/github.ts:397](../../../scripts/parsers/github.ts#L397)) — sibling content like `run-book/`, `task-interview-coach/`, `README.MD`, `LICENSE.txt` is never visible.
- The REST discovery path requests `/contents/tutorials` ([scripts/parsers/github.ts:495](../../../scripts/parsers/github.ts#L495)) — same property.
- Both then `entries.filter(e => e.type === 'tree')` (line 445 / 503), so only **subdirectories** of `tutorials/` are enqueued. A stray top-level file in `tutorials/` would also be ignored.

The `<repo>-Contribution` resolver at [scripts/parsers/github.ts:774](../../../scripts/parsers/github.ts#L774) already keys off the base repo name, so `meta-tutorials-Contribution` is automatically picked up as the source of `rules.vr` files for tutorials sourced from `meta-tutorials/tutorials/`.

**Why "no filter is good enough" is safe.** The only way unintended content from `meta-tutorials` could ship to production after this change is if someone added a directory under `meta-tutorials/tutorials/` that wasn't an actual tutorial. The same risk exists today for every repo in `sap-tutorials/*` — the platform relies on repos under that org being tutorial-shaped by convention. No new control needed for `meta-tutorials` specifically.

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
4. **github.ts unit test** — new test asserts that with the `EXCLUDED_REPOS` change, a fixture repo named `meta-tutorials` containing `tutorials/foo/`, `tutorials/bar/` directories yields the expected slug list. Documents the discovery contract in tests so future refactors can't silently re-exclude the repo.
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
| [scripts/parsers/github.ts](../../../scripts/parsers/github.ts) | Remove `'meta-tutorials'` from `EXCLUDED_REPOS` (one-line change at line 25). |
| `scripts/parsers/__tests__/github.test.ts` | Add unit test exercising the discovery filter against a fixture: a repo named `meta-tutorials` with `tutorials/<slug>/` subdirectories yields one `DiscoveredTutorial` per slug. (Sibling content like `run-book/` is invisible to the discovery query in the first place — the test asserts the slugs that ARE found, not the ones that aren't.) |
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
2. **`auto_validation: false` on the cookbook** — confirmed safe: mission completion is tracked per-tutorial via TaskRecord, independent of whether the tutorial has a quiz. The cookbook completes on reaching its last step. `fetchRulesVr` returns null on miss, so the cookbook's missing rules.vr file is benign.
3. **Mission slug collision** — `tutorial-platform-features-for-authors` is unlikely to collide; `@assert.unique.slug` constraint will catch it at insert time if it does.
4. **Existing meta-tutorials content tripping the build** — discovery only reads the `tutorials/` subtree, so siblings (`run-book/`, `task-interview-coach/`, `README.MD`, `LICENSE.txt`) are invisible without any new filter. The only risk path is a directory under `tutorials/` that isn't actually tutorial-shaped — same risk as exists today for every other repo in the org. Monitor the next CI run for unexpected fetched slugs from `meta-tutorials`.
5. **Tag presence** — `software-product-function>sap-developer-center` may not exist in the platform's tag taxonomy. Verify before mission creation; fall back to `software-product>sap-business-technology-platform` or omit the secondary tag if no exact match.
6. **Self-referential maintenance** — these tutorials describe platform syntax. If syntax changes, they go stale. They should be linked from author docs as living examples and updated when those docs change. Add a one-line note in the cookbook's intro that the tutorial set is co-maintained with [writing-tutorials.md](../../authors/writing-tutorials.md).
7. **BRANCH_BEGIN inside the cookbook tutorial** — branched-tutorials syntax is explicitly designed for step-level branches *within* one tutorial ([docs/authors/branched-tutorials.md](../../authors/branched-tutorials.md)). Cookbook step 3 creating a 2-key branch group is in scope of the feature; the branch picker UX renders independently of any mission-level alt-group. Confirm at smoke-test time.

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
