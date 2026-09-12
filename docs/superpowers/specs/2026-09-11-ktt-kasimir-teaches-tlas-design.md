# KTT — Kasimir Teaches TLAs — Design

**Date:** 2026-09-11
**Status:** Design approved; pending spec review before implementation planning
**Route:** `/explore/ktt/` (new page under the "Explore" nav)

## 1. Summary

KTT ("Kasimir Teaches TLAs") is a mostly-fun, tongue-in-cheek page on
developers.sap.com that teaches the enormous set of SAP three-letter
acronyms through a Duolingo-style, **story-heavy** experience narrated by
an animated Professor Kasimir (SAP's cat mascot). The core loop is
**story-driven** (Kasimir teaches with dialogue and jokes) with
**quiz drills mixed in** (multiple-choice / match / type). Lessons are
grouped into a skill-tree of 3–4 units covering ~50–60 acronyms for v1.

Kasimir is rendered as an original **stylized/flat SVG** recreation of
SAP's Kasimir (grey tuxedo cat, white blaze/muzzle/chest/paws, big blue
eyes, pink nose, dark collar + blue SAP-arrow tag), rigged and animated
in code (CSS keyframes + SMIL). It is not a photoreal reproduction of the
3D-rendered character; the art lives behind a component interface so it
can later be swapped for a commissioned Lottie / rendered asset without
touching lesson logic.

## 2. Goals & non-goals

**Goals (v1):**
- A skill-tree map with 3–4 themed units, ~50–60 TLAs total.
- Story-first lessons with drills interspersed; wrong answers re-queued.
- An animated Kasimir present on every screen, driven by a small mood
  state machine.
- Progress that works logged-out (local) and follows a signed-in user
  (synced to HANA), reusing the existing completion model so KTT lessons
  appear in MyCompletions and unit rollups.
- Content that is correct on the facts and fun in the voice.

**Non-goals (v1):**
- "Endless mode" over the full acronym firehose — **seam left in**, not built.
- NGDS autosend for KTT completions — **explicitly excluded** for v1.
- Per-acronym `STEP`-level completion rows — mastery stays inside the
  lesson / local state for v1.
- Photoreal 3D Kasimir, commissioned Lottie, or badges/leaderboard beyond
  what MyCompletions/gameboard give for free.

## 3. Architecture

Chosen approach: **Hugo page + a single Vue 3 island** (the established
platform pattern; ~17 islands already build into `hugo/static/js/`).

```text
/explore/ktt/  (Hugo page — SSR shell so the route is not an empty div)
  └─ mounts one Vue 3 island: the KTT game
        ├─ Landing / hero
        ├─ Skill-tree map (units → lesson nodes)
        ├─ Lesson (story beats + drills)
        └─ Progress / results
     island talks to CAP only for:
        (1) progress sync when logged in
        (2) live Kasimir "banter" line (AI, fail-open)

Content: hugo/data/ktt_lessons.json  (build-time AI-drafted, human-reviewed)
Backend: srv/ktt-service.cds  (@path:'/ktt')  — thin
Progress rows: reuse com.sap.developers.ims.TaskRecords (new taskType KTT_LESSON)
```

The island inherits Hugo nav, the Horizon theme, and the site build
pipeline. The CAP surface stays deliberately small.

## 4. Screens & UX flow

Four screens inside the one island:

1. **Landing / hero** — Kasimir (idle animation) introduces himself with a
   tongue-in-cheek line; "Start / Continue" CTA; streak + XP badge.
2. **Skill-tree map** — Duolingo-style path: 3–4 units, each a chain of
   lesson nodes (locked → available → completed). Suggested units:
   *Core Platform*, *Data & HANA*, *Security & Identity*,
   *ABAP & Extensibility*. Kasimir reacts alongside progress.
3. **Lesson** — the core loop:
   - **Story beats** — Kasimir teaches a cluster of TLAs with dialogue +
     jokes (scripted lines; occasional live-AI banter for freshness).
   - **Drills** — interspersed: multiple-choice, match-the-expansion,
     type-the-acronym. Wrong answers re-queued Duolingo-style; Kasimir
     facepalms then encourages.
   - **Lesson complete** — Kasimir celebrates (hop + confetti), XP awarded,
     next node unlocks.
4. **Progress / results** — streak, XP, acronyms mastered, per-unit
   completion; feeds local + HANA sync.

## 5. Content model & pipeline

Lesson content is **one reviewed JSON file**, `hugo/data/ktt_lessons.json`,
committed to git as the source of truth (regenerable, but never generated
live at build).

Shape (approximate):

```jsonc
{
  "units": [
    {
      "id": "core-platform",
      "title": "Core Platform",
      "icon": "...",
      "order": 1,
      "lessons": [
        {
          "id": "core-platform-1",
          "legacyId": 90001,          // stable int, used for TaskRecords + rollup tokens
          "title": "Meet the Platform",
          "acronyms": [
            { "tla": "BTP", "expansion": "Business Technology Platform",
              "blurb": "…", "category": "platform" }
          ],
          "beats": [
            { "type": "story", "kasimir": "…", "mood": "teaching" },
            { "type": "drill", "kind": "mc", "tla": "BTP",
              "prompt": "BTP stands for…", "answer": "Business Technology Platform",
              "distractors": ["…", "…"],
              "kasimirRight": "…", "kasimirWrong": "…" }
          ]
        }
      ]
    }
  ]
}
```

**Build-time generation** — `scripts/generate-ktt-lessons.ts`:
- Seeds from a **hand-curated acronym → expansion + category list**. The
  facts (TLA → expansion) are **generated by Claude but grounded against
  `sap-devs-server` / `cds-mcp` / official docs — not invented from
  training data** — and are reviewed by a human before commit
  (per the project rule: never rely on training data for SAP facts).
- AI drafts **only** Kasimir's personality lines and plausible-but-wrong
  distractors; these land in the JSON for human review.
- Wired as an **explicit `build:all` step** (not a `pre/post` hook — those
  are silenced by the global `ignore-scripts=true`).

**Endless-mode seam:** the lesson engine reads beats from a **pluggable
source** (data file now; a CAP-backed acronym feed later), so a future
"endless mode" over the full acronym set drops in without a rewrite.

## 6. Animated Kasimir — `KasimirStage` component

A self-contained Vue component wrapping **one rigged inline SVG** of
stylized Kasimir. Parts (ears, eyelids, pupils, mouth, whiskers, tail,
front paws, head) are separate SVG groups so they animate independently.

- **State machine** prop: `idle | teaching | thinking | correct | wrong |
  celebrate`, driven with CSS keyframes + SMIL:
  - idle — breathing + tail flick + periodic blink
  - teaching — gentle gesture, eyes toward content
  - thinking — ear twitch, eyes up
  - correct — ears perk, eye sparkle
  - wrong — facepalm paw, flattened ears
  - celebrate — hop + confetti burst
- **Accessibility:** honors `prefers-reduced-motion` (freezes to a calm
  pose); the SVG is decorative (`aria-hidden`), while Kasimir's teaching
  text lives in real DOM for screen readers.
- **Swappable art:** the SVG sits behind the component interface, so a
  future commissioned Lottie / rendered Kasimir replaces the innards
  without touching lesson logic.
- **Themed** to Horizon tokens so it fits `sap_horizon`.

## 7. Backend — reuse the completion model

The completable unit is a **KTT lesson**. It reuses the existing
completion machinery rather than a new progress entity.

### 7.1 Progress rows — `TaskRecords`

- Each completed lesson writes a `com.sap.developers.ims.TaskRecords` row
  (`db/schema.cds:188`) with `taskType:'KTT_LESSON'`, `status`, `progress`,
  `completionDate`.
- Upserted on the de-facto tuple **`(user_ID, taskLegacyId, taskType)`**
  (same convention as `puzzle-service.js` / `petoberfest-upload.js`), so
  re-completion updates rather than duplicates.

### 7.2 Catalog entity — `KttLessons`

- One lightweight entity (id, `legacyId`, slug, unit, title), seeded from
  `ktt_lessons.json`, mirroring how `Tutorials` / `Puzzles` /
  `Petoberfests` exist so a completion row can join to its metadata for
  MyCompletions.
- New persisted entity → add a `db/persistence.cds` journal entry;
  run `cds deploy --to sqlite::memory:` before committing the model.

### 7.3 Unit rollups (free)

- Each unit is modeled as a mission-style parent via `CompletionPathItems`
  whose children are `KTT_LESSON:<legacyId>` tokens.
- `srv/lib/completion-rollup.js` already matches mission parents by
  `{taskType, taskLegacyId}` (`:159`) and upserts the parent GROUP/MISSION
  row — so "unit mastered" appears with **no rollup-code changes**.

### 7.4 `KttService` (`srv/ktt-service.cds`, `@path:'/ktt'`)

- `completeLesson` (XSUAA-scoped write) — writes the `TaskRecords` row and
  calls `rollUpParentsForCompletion({ task:{ taskType:'KTT_LESSON', … } })`
  (same call shape as `puzzle-service.js:223`).
- `syncProgress` — merges local ↔ HANA on login: union of mastered TLAs,
  max of XP/streak; idempotent via the upsert tuple.
- `banter(context)` — `@cap-js/ai` action returning a short in-character
  line. `AICore-mocked` locally, `AICore-btp` in hybrid/prod. **Fail-open:**
  any error/timeout returns a scripted line from the data file; rate-limited
  and length-capped; runs edge-side, never inside a progress transaction.

### 7.5 Progress: local-first + hybrid

- Logged-out: everything lives in `localStorage`; the game is fully playable.
- On login: local completions replay through `completeLesson` as
  `TaskRecords` rows; the upsert tuple prevents double-counting.

### 7.6 Concrete edit sites

- `db/schema.cds:195` — add `KTT_LESSON` to `TaskRecords.taskType`
  (NVARCHAR column; **no `.hdbmigrationtable` ALTER needed** — see comment
  at `:191`).
- `db/schema.cds:19` — add `KTT_LESSON` to `type TaskType` so KTT lessons
  pass the `@assert.range` at `:418` when used as `CompletionPathItems`
  children.
- `srv/lib/user-progress.js` (~`:175`, `:183`, `:213`) — add `KTT_LESSON`
  to the MyCompletions `taskType IN (…)` list, an ID bucket, a metadata
  SELECT against `KttLessons`, and a `kind:'ktt'` branch.
- New `KttService` handlers per 7.4.
- **Not changed for v1:** `srv/lib/ngds-client.js` (NGDS autosend excluded),
  `featured-resolve.js`, `admin-service.js`, exports — revisit only if KTT
  later joins those flows.

### 7.7 Feature flag

- KTT gated by an `ImsConfig` DB flag registered in
  `feature-flags/registry.js` (`kind:'db'`) so it surfaces in the admin
  Feature Flags UI and toggles without redeploy. **Default OFF** until
  DEV-verified. Flag off ⇒ `/explore/ktt/` fails closed (coming-soon / 404
  per convention).

## 8. Error handling & resilience

- **AI banter non-blocking** — timeout + try/catch; falls back to a scripted
  line. Lesson loop never stalls on the model.
- **Progress sync best-effort** — a failed `TaskRecords` write shows a quiet
  toast, never loses local state, retries on next completion; never throws
  into the rollup transaction.
- **Data file validated at build** — `generate-ktt-lessons.ts` + a unit test
  assert: every drill has a correct answer and ≥2 distractors, every acronym
  has an expansion, `legacyId`s are unique. Malformed lessons fail the build.
- **Reduced-motion** honored by `KasimirStage`.

## 9. Testing

- **Unit (in-memory SQLite):** `completeLesson` writes a `TaskRecords` row on
  the `(user, legacyId, KTT_LESSON)` tuple; re-completion upserts (no dupes);
  unit-parent rollup produces the mission/group row via existing
  `completion-rollup.js`; `getMyCompletions` returns the `kind:'ktt'` entry.
  Guard the model with `cds deploy --to sqlite::memory:` pre-commit.
- **Lesson-engine unit tests:** drill scoring, wrong-answer re-queue,
  XP/streak math, local↔HANA merge (union mastered, max XP/streak).
- **Island component tests:** `KasimirStage` state transitions; run via
  `--project unit` from repo root (hugo-apps `.vue` gotcha).
- **AI banter:** mocked (`AICore-mocked`) locally; test the fail-open path
  explicitly.
- **e2e (post-deploy, self-skipping):** committed Playwright spec — load
  `/explore/ktt/`, start a lesson, answer a drill, see Kasimir react.
- **srv-qa cp-list audit** if any KTT helper lands under `srv/lib/` reachable
  from `content-store.js`.

## 10. Open items for implementation planning

- Final unit list and the ~50–60 acronym set (drafted grounded, human-reviewed).
- Exact XP/streak formula and re-queue policy.
- Whether the landing SSR shell needs any crawler-facing acronym content.
- Confirm `/explore/ktt/` nav placement and label wording under "Explore".
