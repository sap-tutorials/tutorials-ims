# Randomize the order of quiz answers — design

**Issue:** [sap-tutorials/tutorials-ims#2558](https://github.com/sap-tutorials/tutorials-ims/issues/2558)
**Date:** 2026-09-30
**Author:** Tom Jung (design driven with Claude)
**Classification:** Architectural (multi-component; touches a data contract two islands depend on)

## Problem

Quiz answer options render in a fixed order (the order authored in the
`rules.vr` sidecar). Because the order is stable, a learner can pass the
answer to another learner as a positional hint — "it's the third option" /
"the answer is C" — and it stays valid for everyone, indefinitely. The issue
asks that answer order be **randomized** so positional answer-sharing stops
working.

## Threat model (decided)

**Display-only client-side shuffle.** We randomize the *display order* of
multiple-choice options in the browser at page load. We explicitly do **not**
attempt to hide the correct answer from page source.

Rationale, and an important pre-existing fact this design does NOT change:
for every non-AI multiple-choice question the correct answer is **already
fully exposed** in the public `<script id="tutorial-data">` JSON and graded
client-side. That is a documented, accepted trade-off
(`hugo-apps/src/validation/grading.ts:1-8`). Randomizing order does not close
that hole and is not intended to — a determined learner can still read the
answer from source today, exactly as before.

What order-shuffle *does* defeat is the cheap, common vector named in the
issue: verbal/positional answer-sharing ("choose the 3rd one"). Each page
load produces a fresh order, so a positional hint is worthless to the next
learner. Moving grading server-side (to truly hide the answer) was considered
and rejected as out of scope for this issue — it is a large change to
grading, DB, and rate-limiting, and the issue only asks for order
randomization.

## Scope (decided)

Both quiz widgets:

1. **Validation widget** (`hugo-apps/src/validation/`) — the production quiz
   parsed from `rules.vr`. This is exactly what the issue names.
2. **Challenge widget** (`hugo-apps/src/challenge-render/`) — the newer
   json-render research-spike widget (#2362/#2441). Included for consistent
   behaviour; grades by option **index**, so it needs an index remap the
   validation widget does not.

Out of scope: parser (`scripts/parsers/rules.ts`), Hugo serialization, CAP
services, DB entities, the publish pipeline, the AI/free-text grading path.
None are touched.

## Where the shuffle happens, and why

**At the island entry point (`main.ts`), once, before `createApp().mount()`.**

Two rejected alternatives and why:

- **In the parser / at build time** — bakes ONE fixed shuffled order into the
  published HTML. Everyone still sees the same order, so positional sharing
  still works. (This was offered as an option and rejected.)
- **Inside the Vue component, reactively (e.g. a `computed`)** — options would
  re-shuffle on every reactive tick, so options would visibly jump around as
  the learner clicks. Bad UX and, for the challenge widget, would desync the
  selected index.

Mount-time in `main.ts` gives: a fresh order on every page load; a stable
order for the entire interaction (mount runs once); and — critically — leaves
both `.vue` components and the grading logic **byte-for-byte unchanged**. The
validation widget's elaborate AI/partial/error state machine is the riskiest
code in this area; not touching it is a deliberate regression-risk reduction.
Both shuffles route through one shared, unit-tested helper.

Shuffle applies in **preview mode too** (decided) — one code path, no
`isPreview` guard. Authors seeing the shuffled order in preview is acceptable
and confirms the feature works during authoring.

## Components

### New: `hugo-apps/src/shared/shuffle.ts`

```ts
// Fisher-Yates. Pure: returns a NEW array, never mutates the input.
// rng is injectable so tests can pass a deterministic sequence; production
// callers omit it and get Math.random.
export function shuffleArray<T>(arr: readonly T[], rng: () => number = Math.random): T[]
```

Single responsibility: given an array, return a uniformly-shuffled copy.
Depends on nothing. Testable in isolation with a seeded `rng`.

### Changed: `hugo-apps/src/validation/main.ts`

Before the `createApp(Validation, { … questions: step.validation … })` call,
map `step.validation` to a new array where every `multiple-choice` question
with `options` gets `options: shuffleArray(options)`. All other question
fields (including `correctAnswer` / `correctAnswers`, both **string-valued**)
are copied unchanged.

Grading is unaffected: `grading.ts` compares the submitted option **string**
against `correctAnswer` (single) or does an exact **set match** of strings
(multi). Neither depends on option order. `Validation.vue` and `grading.ts`
are not modified.

Text questions (`type === 'text'`) and multi-select are handled by the same
map — text has no `options` so it's a pass-through; multi-select is a string
set-match so shuffling the display order is safe.

### Changed: `hugo-apps/src/challenge-render/main.ts`

Before the `createApp(ChallengeRenderer, { spec: step.challenge … })` call,
map `step.challenge.nodes` to a new array. For each `mcq` node with `options`
**and** a numeric `answerIndex`:

1. Capture the correct option string: `correct = options[answerIndex]`.
2. `shuffledOptions = shuffleArray(options)`.
3. `newAnswerIndex = shuffledOptions.indexOf(correct)`.
4. Emit `{ …node, options: shuffledOptions, answerIndex: newAnswerIndex }`.

This keeps `ChallengeRenderer.vue`'s `s.selected === node.answerIndex`
client-grade correct after the reorder. `ChallengeRenderer.vue` is not
modified. Non-`mcq` nodes (`heading`, `prose`, `freeText`) are copied
unchanged; `freeText` is AI-graded server-side and has no options.

## Data flow

```
#tutorial-data JSON  (unchanged: still ships canonical order + answer)
      │
      ▼
main.ts (validation)   step.validation[]  ── per MCQ ──► shuffleArray(options)
main.ts (challenge)    step.challenge.nodes ── per mcq ─► shuffle + remap answerIndex
      │
      ▼
createApp(...).mount()   component sees an already-shuffled, self-consistent spec
      │
      ▼
grading  (validation: string compare — order-independent)
         (challenge:  index compare — index was remapped to match)
```

## Error handling / edge cases

- **Missing / empty `options`** — `shuffleArray` on `[]` returns `[]`; the
  map guards `type === 'multiple-choice' && options` (validation) /
  `type === 'mcq' && options && answerIndex != null` (challenge) so
  non-MCQ nodes are untouched.
- **`answerIndex` out of range** (malformed challenge spec) — `options[i]`
  is `undefined`, `indexOf(undefined)` is `-1`. Grading then never matches;
  this fails safe (no false pass) and mirrors today's behaviour for a broken
  spec. Documented, not defended further — it is author/generator error.
- **Duplicate option strings in a challenge MCQ** — `indexOf` returns the
  first match, so the remapped `answerIndex` may point at a different but
  string-identical option. Since the grade is `selected === answerIndex` and
  the two options are textually identical, the learner cannot tell.
  Negligible real-world risk (author error to have duplicate options);
  documented, not defended.
- **Single-option question** — shuffle is a no-op; harmless.
- **Preview mode** — shuffle applies (decided); no special-casing.

## Testing

All unit-level; no server, DB, or publish-pipeline involvement.

1. **`hugo-apps/src/shared/shuffle.test.ts`** (new)
   - Returns a permutation: same length, same multiset of elements.
   - Does not mutate the input array.
   - Deterministic under a seeded `rng` (verifies the injection point).
   - `[]` and single-element inputs return equivalent arrays.

2. **`hugo-apps/src/validation/main.test.ts`** (extend)
   - After mount, a MCQ's rendered options are a permutation of the source
     options.
   - Grading the (moved) correct option string still yields a pass — i.e.
     the shuffle did not break string-based grading.
   - Text questions and `correctAnswer`/`correctAnswers` values pass through
     unchanged.

3. **`hugo-apps/src/challenge-render/main.test.ts`** (extend)
   - After mount, an `mcq` node's options are a permutation, and
     `answerIndex` points at the same option string it did before shuffle.
   - Selecting the remapped `answerIndex` grades correct; selecting any other
     index grades incorrect.
   - `freeText` / `heading` / `prose` nodes pass through unchanged.

Because `shuffleArray` takes an injectable `rng`, the `main.test.ts` tests can
force a known permutation (e.g. a reversing RNG) and assert exact positions
rather than relying on probabilistic reshuffles.

## Files touched

| File | Change |
|------|--------|
| `hugo-apps/src/shared/shuffle.ts` | **new** — Fisher-Yates helper |
| `hugo-apps/src/shared/shuffle.test.ts` | **new** — helper unit tests |
| `hugo-apps/src/validation/main.ts` | shuffle MCQ `options` before mount |
| `hugo-apps/src/challenge-render/main.ts` | shuffle `options` + remap `answerIndex` before mount |
| `hugo-apps/src/validation/main.test.ts` | extend — shuffle + grading-still-passes |
| `hugo-apps/src/challenge-render/main.test.ts` | extend — shuffle + index-remap |

Unchanged (explicitly): `Validation.vue`, `grading.ts`,
`ChallengeRenderer.vue`, `scripts/parsers/*`, all of `srv/`, `db/`, the
publish pipeline.

## Non-goals

- Hiding the correct answer from page source (pre-existing exposure, unchanged).
- Moving MCQ grading server-side.
- Randomizing question order (only *answer* order is in scope).
- Any change to AI / free-text grading.
