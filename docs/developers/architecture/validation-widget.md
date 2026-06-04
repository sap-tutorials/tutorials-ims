# Validation Widget

The `[VALIDATE_N]` validation widget renders quiz questions on tutorial steps.
Authors mark steps with `[VALIDATE_N]` blocks in their `rules.vr` files;
those parse into a per-step `validation` array on the Hugo frontmatter,
which the build serializes into the public `<script id="tutorial-data">`
JSON on each tutorial page. The Vue island reads from there.

## Architecture

- **Mount point:** `<div class="step-validation-mount" data-step="{N}">` in
  `hugo/layouts/shortcodes/tutorial-step.html` (line 17). Rendered for
  every step; the island's `main.ts` only mounts on steps where the
  parsed `validation` array is non-empty.
- **Bundle:** `hugo-apps/src/validation/` → `validation.js` (~2 KB gzipped,
  8 KB budget enforced by Vite plugin).
- **Loaded by:** `hugo/layouts/tutorials/u1-object-page.html` via
  `<script type="module" src="/js/validation.js" defer>` inside
  `{{ if not site.Params.previewMode }}` block. NOT the
  `qa AND previewMode` block — validation runs in QA mode so authors
  previewing their `[VALIDATE_N]` blocks see them rendered.
- **Done-button gate:** `hugo/assets/js/tutorial.ts` defines
  `initDoneButtonGate()`. It disables Done buttons for validation-gated
  steps at module init, and re-enables them via two paths:
  - **Initial-load (persisted-correct) path:** `validation.js` is a
    `defer`-loaded ES module that runs in document order, *before*
    `DOMContentLoaded`. Its `onMounted` sets `data-validated="true"`
    **synchronously** on the `.tutorial-step` element and then dispatches
    `step-validated`. Because the `step-validated` listener is only
    attached inside `DOMContentLoaded`, that event is lost. The DOM
    attribute is not lost. `initDoneButtonGate` therefore does a second
    pass after the disable loop: it iterates the validation-gated steps
    and re-enables the Done button for any step where
    `data-validated="true"` is already set. This covers returning
    learners whose correct answer was persisted in `localStorage`.
  - **Live-submit path:** the `step-validated` `CustomEvent` listener
    (attached after both passes) handles new correct submissions during
    the same page visit. The event payload is `{ stepNumber: number }`.
  The `data-validated="true"` attribute is therefore the **source of
  truth for initial load**; the event handles live submits.

## Question types

- **Multiple-choice:** rendered as `<ui5-radio-button>` per option, scoped
  by question name (`q-${stepNumber}-${qi}`). Exact-match grading.
- **Text:** rendered as `<ui5-textarea>`. Case-insensitive equality grading
  after trim.

Both types are graded **all-or-nothing per step**: ALL questions in a
step's `validation` array must be correct for the step to pass.

## Persistence

A learner who answers correctly is not re-quizzed on reload. The flag
lives in `localStorage` under key `tutorial-validation-${slug}-${stepNumber}`,
where `slug` is read from `document.documentElement.dataset.pageSlug`
(the project's standard convention used by `cmd-palette` and
`tutorial-breadcrumbs` islands):

```json
{ "correct": true, "timestamp": 1717459200000 }
```

Only `correct: true` is persisted. Failed attempts don't get cached;
the learner can keep trying without state.

`readPersisted` and `writePersisted` are tolerant of localStorage
failures (private mode, quota exceeded) — both return null/silently
on error.

## Anti-leak: documented trade-off

The widget grades client-side, which means the `correctAnswer` field
ships in the public `<script id="tutorial-data">` JSON. This is a
known trade-off; it's been there since the rules.vr loader was written.

Server-side AI grading (issue #209) addresses this for any text question
the author marks with `###Grading: ai-judged`. Multiple-choice and plain
exact-match text questions stay client-side.

## Adding a new question type

To add (say) a "match this regex" question type:

1. Extend `ValidationQuestion` in `hugo-apps/src/validation/grading.ts`
   to include a new `type: 'regex'` case.
2. Update `gradeAnswers` to handle the new type. Add a unit test in
   `test/unit/validation-grading.test.js`.
3. Add a `<template v-else-if="q.type === 'regex'">` branch in
   `Validation.vue` rendering the appropriate input.
4. Update the parser at `scripts/parsers/rules.ts` to emit the new type.

For AI-graded variants, see issue #209's design at
`docs/superpowers/specs/2026-06-04-209-free-text-grader-design.md`.

## Reference

- Module: [`hugo-apps/src/validation/grading.ts`](../../../hugo-apps/src/validation/grading.ts)
- Component: [`hugo-apps/src/validation/Validation.vue`](../../../hugo-apps/src/validation/Validation.vue)
- Mount: [`hugo/layouts/shortcodes/tutorial-step.html:17`](../../../hugo/layouts/shortcodes/tutorial-step.html#L17)
- Done-button gate: [`hugo/assets/js/tutorial.ts`](../../../hugo/assets/js/tutorial.ts) — search for `initDoneButtonGate`
- Spec: [`docs/superpowers/specs/2026-06-04-212-validation-widget-modernisation-design.md`](../../superpowers/specs/2026-06-04-212-validation-widget-modernisation-design.md)
- Tracking: [sap-tutorials/tutorials-ims#212](https://github.com/sap-tutorials/tutorials-ims/issues/212)
