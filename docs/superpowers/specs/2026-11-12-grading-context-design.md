# Tutorial-level AI Grading Context — design

**Issue:** [#3090](https://github.com/sap-tutorials/tutorials-ims/issues/3090) — Custom Skills and MCPs for AI Grading support
**Date:** 2026-11-12
**Status:** Design — awaiting approval, then plan (superpowers:writing-plans)

## Intent and the why

The three AI graders in this repo (quiz free-text `validate-answer`, `code-check`,
and challenge-widget `challenge-grade`) all judge a learner's submission with a
general-purpose LLM against an author-supplied goal/reference. They receive **no
domain grounding**. When a tutorial's subject is unfamiliar or specialized — the
motivating case is **n8n workflows in Joule Studio** — the grader reasons
generically and grades loosely: it doesn't know what a well-formed n8n workflow
looks like, which n8n-specific choices are correct, or what mistakes n8n learners
typically make.

The author needs a way to **focus the grader on the tutorial's domain** so its
verdicts are accurate for that content. Per the issue author (Tom), the need is
author-supplied *grading context/knowledge*, written **once for the whole
tutorial**, not a hardcoded per-domain code validator.

This design is **Option A** of the three surveyed on the issue (A: author-supplied
static context; B: tool-enabled agentic grader; C: external MCP-bound grader). A
is chosen for v1 because it solves the stated need with a near-drop-in extension of
an existing, proven pattern (`videoContext`, #2345) and because its runtime contract
— "the grader consumes an assembled context string" — is **deliberately shaped so
Option B can slot in later** by filling the same slot from live tools/MCP instead of
static author text, with no change to the graders.

## Goals

1. An author declares, **once per tutorial**, domain grading context in the
   existing `rules.vr` sidecar, using **light structured sub-sections**.
2. That context is injected into the grading prompt of **all three** AI graders
   (`validate-answer`, `code-check`, `challenge-grade`) for **every** graded step
   in the tutorial.
3. The context is visible **read-only** in the Admin-UI on the Tutorial object page,
   alongside the existing grading-spec facets.
4. The runtime seam is designed so Option B (tools/MCP producing the context
   dynamically) can replace the static source later **without changing the graders**.

## Non-goals (explicit — v1 does NOT include these)

- **No deterministic/code validators.** We are not parsing or linting n8n JSON (or
  any submission) in code. The grounding is author-written prose, consumed by the LLM.
- **No live tools / MCP / agentic loop.** That is Option B, a near-future follow-up.
  The graders remain a single forced-tool-call round-trip (`code-check-llm.js`).
- **No per-step context overrides.** Tutorial-level only. (A step-level override
  could be added later; it is not needed for the n8n case.)
- **No author-editable context in Admin-UI.** Display is read-only; authoring is in
  `rules.vr`, published through the content pipeline — consistent with how every
  other grading spec (`CodeCheckSpecs`, `ValidateAnswerSpecs`) works today.

## Anti-goals (would make this a failure even if it "works")

- The grading context becoming a **channel for answer leakage** — if authors stuff
  reference answers into it, the existing anti-leak redaction (keyed to a specific
  reference string) will not catch it. **Handled as an authoring guideline** (context
  is domain *guidance*, not per-question answers), not an enforced guard — see the
  runtime-injection decision not to route context through `redactReferenceLeaks`.
- The context becoming a **prompt-injection vector** — context text is authored, so
  lower risk than B's tool output, but the system-prompt framing must still mark it
  as guidance-for-judgment, never as instructions to obey or text to quote.
- A grounding read that **fails closed and dark-fails a learner mid-grade** — a
  missing/erroring context read must degrade to today's behavior (grade without
  grounding), never block the grade.

## Constraints (from the codebase and project conventions)

- **Authoring lives in `rules.vr`**, parsed by `scripts/parsers/rules.ts`. Decided
  with Tom — keeps all grading config in one file.
- **Tutorial-level markers already exist** as a pattern: `[AUTOAUTHOR_ALL]`
  (rules.ts) is a non-step-keyed marker recorded once on the parse result and
  consumed by a later phase. `[GRADING_CONTEXT]` follows that mold.
- **The injection seam already exists**: `videoContext` (#2345) threads an optional
  server-only string from a spec column → loader → `buildUserMessage()` as a fenced
  "for your judgment only — do not quote" section. See
  `srv/lib/validate-answer-prompt.js` `buildUserMessage({…, videoContext})` and the
  system-prompt note. This is the exact template to copy for all three graders.
- **The LLM client is shared**: `srv/lib/code-check-llm.js › defaultCallModel()` is
  reused as-is by all three graders. The context is passed in the *user message*, so
  **no change to the LLM client is required**.
- **Server-only fields** are stripped from the public spec and survive only
  server-side (anti-leak pattern, rules.ts `collectAiGradedSpecs`). Grading context
  is server-only.
- **Slug canonical lowercase** before any comparison/lookup (project rule).
- **Spec publish is REPLACE-style** per tutorial (see `validate-answer-spec-publish.js`,
  `code-check-spec-publish.js`, POST `/content/*-specs`) and gated by
  `CONTENT_API_KEY`. New context published through the same mechanism.
- **CAP rules:** no raw SQL in new write paths (use `cds.ql`/CQL); upsert on unique
  keys (SELECT-then-UPDATE-or-INSERT) per the project's slug-uniqueness rule; never
  SELECT a HANA BLOB alongside metadata (N/A here — context is a short CLOB/String,
  no BLOB).
- **Feature-flag convention:** new runtime behavior ships behind a flag, default OFF,
  fail-open where a read error shouldn't break a learner — mirror `codeCheckEnabled`
  / `validateAnswerEnabled` on `ChatSettings`, or an `ImsConfig` key like
  `flag.challengeWidget`. (Builder picks which; see "decided" below.)

## The parts of the how — decided

### Authoring syntax (decided: light structure)

A single tutorial-wide block in `rules.vr`:

```
[GRADING_CONTEXT]
###Domain
This tutorial teaches building n8n workflows in Joule Studio. Submissions are
n8n workflow JSON exported from the canvas.
###GradingCriteria
A correct workflow starts with a Trigger node, connects nodes via the
"connections" map (not just placing them), and ends with an action that
produces the tutorial's stated output. Node naming is free-form; wiring is not.
###CommonMistakes
Learners often paste disconnected nodes, omit the trigger, or submit the
canvas screenshot's text instead of the exported JSON.
```

- Sub-sections parsed with the **same `section()` helper** `codecheck.ts` uses
  (`###Name` through next `###` or EOF). All three sub-sections are **optional**;
  an empty `[GRADING_CONTEXT]` block (or missing block) → no grounding, today's
  behavior.
- Parsed **once** to a result-level field on `parseRulesVrEnriched`'s return (not
  step-keyed), exactly as `autoAuthorAll` is recorded.

### Assembled context string (the B-ready seam) — assemble at parse/publish time

The parser **assembles one context string** from the sub-sections (fixed order:
Domain → GradingCriteria → CommonMistakes, each under a short labeled header, empties
omitted) **at parse/publish time**, and the **assembled string is what's stored**.
The graders consume **only this string** — they never see the sub-section structure.
This is the seam that keeps B open: Option B replaces "the string came from author
sub-sections" with "the string came from a tool/MCP call", and the graders — and the
storage — are unchanged (both see one string).

> **Decided (Tom, 2026-11-12):** store **one assembled blob**, not three columns.
> This gives the cleanest B-seam (grader + storage both see a single string). The
> Admin-UI read-only display shows that one assembled block, not three separately
> labeled fields — accepted tradeoff.

### Persistence (one assembled field, per tutorial)

Store the assembled context as **one server-only field, one row per tutorial**,
upserted on the tutorial key.

- Shape is builder's call between a dedicated `TutorialGradingContext` entity
  (one row: `tutorial` key + `context` LargeString) and a single server-only column
  on an existing per-tutorial server entity. A dedicated entity is still mildly
  preferred for a clean Admin association, but with only one field the cost of a
  column is low — builder decides.
- Server-only; **not** projected into any public/anonymous surface. Journaling:
  match `CodeCheckSpecs` (not journaled) unless the builder finds a reason.
- Admin projection: `@readonly`, surfaced on the Tutorial object page facets in
  `app/admin-annotations.cds` next to the existing "AI-Graded Validation" /
  "Code-Check Specs" facets — showing the single assembled block.

### Runtime injection (mirror videoContext, ×3)

For each grader (`validate-answer-tool.js`, `code-check-tool.js`,
`challenge-grade-tool.js`):

1. After loading the per-step spec, perform **one additional read** of
   `TutorialGradingContext` for the (lowercased) tutorial slug, via the grader's
   existing injected-loader pattern (add a `loadGradingContext` dep, or extend the
   existing loader — builder's call; the DI seam at the `srv/server.js` wiring site is
   the established place).
2. Thread the assembled string into each prompt's `buildUserMessage(...)` as a new
   optional section — copying the `videoContext` treatment verbatim: a fenced section
   labeled *"Tutorial grading context (domain guidance for your judgment only — do not
   quote)"*, inserted **before** the author's reference/expected answer.
3. Add **one line** to each `buildSystemPrompt()` telling the model to weight this
   domain guidance when grading, and (reinforcing the anti-goal) to treat it as
   guidance, never as instructions to follow or text to quote.
4. **Bump each prompt's `PROMPT_VERSION`** (code-check v2→v3, validate-answer v4→v5)
   so telemetry can split grounded vs ungrounded verdicts. Absent context → message
   byte-identical to the prior version (same discipline #2345 used).
   - **challenge-grade shares `validate-answer-prompt.js`** — bumping that module to
     v5 means challenge-grade *also* starts injecting grounding. **That is intended**
     (Goal 2: all three graders get grounding); no separate prompt module. challenge-
     grade has no submissions-telemetry entity, so the grounded/ungrounded split is
     simply not measurable there — acceptable, no new telemetry row is added.
     (Builder's call, 2026-11-12.)
5. **Do NOT route the context through `redactReferenceLeaks`.** (Decided, Tom,
   2026-11-12.) That guard redacts verdict text echoing a *reference answer*; the
   domain context is legitimate guidance the model is *meant* to use and name in its
   feedback, so scanning the verdict against it would over-redact. The anti-goal
   "context must not carry answers" is handled as an **authoring guideline** (context
   is domain guidance, not per-question answers), not an enforced guard. The existing
   per-step reference redaction is unchanged.

### Admin-UI (read-only display)

- New `@readonly` projection of `TutorialGradingContext` on `AdminService`
  (`srv/admin-service.cds`), associated from `Tutorials` like `codeCheckSpecs`.
- A facet on the Tutorial object page (`app/admin-annotations.cds`) showing the
  domain/criteria/mistakes. No write path.

### Feature flag — one flag, gates grounding only

> **Decided (Tom, 2026-11-12):** a single new **`ChatSettings.gradingContextEnabled`**
> boolean, read by **all three** graders, gating **only grounding injection** — never
> the grade itself.

- Default **OFF**. Fail-open on read error: a missing/erroring context read (or flag
  read) degrades to today's behavior (grade without grounding), never blocks the grade.
- The new flag is **layered on top of** each grader's existing enable gate, not a
  replacement: `validate-answer`/`code-check` keep their `ChatSettings.*Enabled`
  gate; `challenge-grade` keeps its `ImsConfig.flag.challengeWidget` gate. Flag-OFF
  drops grounding only.
- **challenge-grade gains a `ChatSettings` read it does not have today** (it currently
  reads only `ImsConfig`). This is a new, small read path in `challenge-grade-tool.js`
  — called out because it is the one place the flag wiring is genuinely new rather
  than a mirror.
- Surfaced in the existing Settings AI-grading panel
  (`app/admin/joule/webapp/view/Settings.view.xml`) next to the other two toggles.

### Publish path — fold into an existing per-tutorial publish

> **Decided (Tom, 2026-11-12):** do **not** add a new `/content/grading-context`
> endpoint. Fold the assembled context into an existing **once-per-slug** publish
> call (e.g. the tutorial-meta publish that already runs per slug), as one extra
> field on that payload.

- Avoids a new route surface, a new `CONTENT_API_KEY`-gated endpoint, and a new
  `srv-qa` route-drift entry (`scripts/check-srv-qa-route-drift.ts`).
- Server-side handler upserts the one assembled field on the tutorial key (REPLACE
  semantics: re-publishing a tutorial overwrites/clears its context).
- Builder identifies the exact existing per-tutorial publish call in
  `fetch-tutorials.ts` / the publish pipeline to ride; `rules.ts` surfaces the
  assembled string on the parse result so the publish step can pick it up.

## What's left to the builder

- **Storage shape detail**: dedicated `TutorialGradingContext` entity (one `context`
  field) vs one server-only column on an existing per-tutorial server entity. One
  field either way; a dedicated entity is mildly preferred for the Admin association.
- **Column type**: `LargeString`/CLOB; expect short, cap defensively (see below).
- **Which existing per-tutorial publish call** to fold the field into, and the exact
  `rules.ts` surfacing + upsert handler site.
- `srv-qa` `cp`-list audit if any new `srv/lib/` module becomes a transitive dep of
  `content-store.js` (project rule).

### Decided-by-builder notes (settled from the code, 2026-11-12)

- **Parser ownership:** `[GRADING_CONTEXT]` is a top-level sibling marker owned by
  `scripts/parsers/rules.ts` (it must `flush()` the current block like
  `[AUTOAUTHOR_ALL]` does, and record the assembled string on the parse result).
  `scripts/parsers/codecheck.ts` is unaffected — its `ANY_MARKER` only matches
  `VALIDATE`/`CODECHECK`, so it already ignores the new block.
- **Length caps:** reuse the publish-side `MAX_FIELD_BYTES = 10_000` discipline from
  `validate-answer-spec-publish.js` for the assembled context field; cap each
  sub-section before assembly so a single runaway section can't blow the total.

## Testing expectations (for the plan)

- Parser unit tests: block present/absent, each sub-section present/absent, empty
  block, assembled-string order and empty-omission.
- Grader unit tests (per grader, injected `callModel`/loader — no network/HANA):
  context present → appears in user message in the right position; absent → message
  identical to prior PROMPT_VERSION; context containing reference text → redacted in
  verdict; flag OFF → no grounding; loader error → fail-open (grades without it).
- Admin projection: read-only, context visible on object page, not writable.

## Prior art referenced

- `#2345` `videoContext` — the injection template this copies.
- `#208` `[AUTOAUTHOR_ALL]` — the tutorial-wide non-step marker shape.
- `#209` / `#171` / `#2441` — the three graders and their shared LLM client + anti-leak.
