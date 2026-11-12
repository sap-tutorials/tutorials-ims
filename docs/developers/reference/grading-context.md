# Tutorial-level AI Grading Context (`[GRADING_CONTEXT]`)

**Issue:** [#3090](https://github.com/sap-tutorials/tutorials-ims/issues/3090)
**Design:** [`docs/superpowers/specs/2026-11-12-grading-context-design.md`](../../superpowers/specs/2026-11-12-grading-context-design.md)

## What it is

A tutorial-wide block in a `-Contribution` `rules.vr` file that supplies
domain grounding to the AI graders. Without it, graders reason generically
about a learner's answer. With it, the grader knows the tutorial's domain,
what a correct submission looks like in that context, and what mistakes
learners typically make.

The block is **tutorial-wide** — one block per `rules.vr`, not one per
step. It applies to **all three** AI graders for that tutorial:
`validate-answer`, `code-check`, and `challenge-grade`.

## Authoring syntax

Add a `[GRADING_CONTEXT]` block anywhere in the tutorial's `rules.vr`
file (conventionally at the top, before any `[VALIDATE_N]` or
`[CODECHECK_N]` blocks):

```
[GRADING_CONTEXT]
###Domain
<Describe the tutorial's subject area — what technology/tool/concept a
correct submission is working with.>
###GradingCriteria
<Describe what a correct submission looks like in this domain. Focus on
structural or semantic properties the grader should verify, not on
reproducing the expected answer.>
###CommonMistakes
<Describe typical learner errors in this domain that should influence the
verdict.>
```

All three sub-sections are **optional**. An empty `[GRADING_CONTEXT]`
block, or omitting the block entirely, gives today's behavior: grading
without domain grounding.

### Example (n8n workflows)

```
[GRADING_CONTEXT]
###Domain
This tutorial teaches building n8n workflows in Joule Studio. Submissions
are n8n workflow JSON exported from the canvas.
###GradingCriteria
A correct workflow starts with a Trigger node, connects nodes via the
"connections" map (not just placing them), and ends with an action that
produces the tutorial's stated output. Node naming is free-form; wiring
is not.
###CommonMistakes
Learners often paste disconnected nodes, omit the trigger, or submit the
canvas screenshot's text instead of the exported JSON.
```

## How it is published

The parser (`scripts/parsers/rules.ts`) assembles the sub-sections into
one context string (order: Domain → GradingCriteria → CommonMistakes,
empties omitted) at parse time. The assembled string is stored in the
server-only `TutorialGradingContext` entity (one row per tutorial,
upserted on slug) as part of the existing `validate-answer-specs` publish
call. There is no separate publish endpoint.

## Runtime injection

At grading time, `srv/lib/grading-context-loader.js`
(`defaultLoadGradingContext(slug)`) reads the assembled string and passes
it to each grader's `buildUserMessage()` as a fenced section labeled
*"Tutorial grading context (domain guidance for your judgment only — do
not quote)"*, inserted before the per-step reference/expected answer.

This injection is **gated by `ChatSettings.gradingContextEnabled`**
(default **OFF**). To enable on a given environment:

```bash
# In a hybrid CAP shell or via the Admin-UI Joule Settings tile
await UPDATE('com.sap.developers.ims.ChatSettings').set({ gradingContextEnabled: true });
```

The Admin-UI Settings tile (`/admin-ui/#joule-display`) exposes the
toggle next to the `validateAnswerEnabled` / `codeCheckEnabled` toggles.

## Fail-open contract

A missing context row, a DB read error, or a `gradingContextEnabled:
false` flag all degrade silently to today's behavior: the grade proceeds
without domain grounding. The grading call is never blocked or failed
by a missing context.

## Anti-goals (authoring guidelines)

- **Do not embed per-question reference answers** in `[GRADING_CONTEXT]`.
  The block is domain guidance for the grader's judgment, not a shortcut
  to supply per-step answers. The existing `redactReferenceLeaks` guard
  does **not** scan the context block, so embedding answers there would
  bypass that protection.
- **Treat the block as guidance for the LLM's judgment**, not as
  instructions for the LLM to follow. The system prompt reinforces this.

## Admin-UI read-only display

The assembled context string is visible (read-only) on the Tutorial
object page in the Admin-UI, in the AI-Grading facet group. There is no
write path in the UI — authoring is always through `rules.vr` and the
content publish pipeline.

## Reference

- Parser: [`scripts/parsers/rules.ts`](../../../scripts/parsers/rules.ts)
  (look for `GRADING_CONTEXT` section handling)
- Loader: [`srv/lib/grading-context-loader.js`](../../../srv/lib/grading-context-loader.js)
- DB entity: [`db/schema.cds` — `TutorialGradingContext`](../../../db/schema.cds)
- Grader prompts:
  - [`srv/lib/validate-answer-prompt.js`](../../../srv/lib/validate-answer-prompt.js)
    (`buildUserMessage` — also used by `challenge-grade`)
  - [`srv/lib/code-check-llm.js`](../../../srv/lib/code-check-llm.js) (`buildUserMessage`)
- Publish integration: [`srv/lib/validate-answer-spec-publish.js`](../../../srv/lib/validate-answer-spec-publish.js)
- Sibling docs:
  - [Free-text grader](../architecture/free-text-grader.md) — `validate-answer` AI grading
  - [Validation widget](../architecture/validation-widget.md) — the base widget this extends
