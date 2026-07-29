# Puzzles (Cryptic Crossword) — Design Spec

**Date:** 2026-07-29
**Issue:** #644 (foundation, closed) → this is the full-feature follow-up
**Status:** Approved design, ready for implementation planning

## Summary

Implement a fully-functional **Puzzle** task type (first instance: a cryptic
crossword), building on the existing `#644` foundation (`Puzzles` entity,
`taskType='PUZZLE'`, `PuzzleTaskRecords`, `AdminService.Puzzles`). A POC exists
at `github.com/thecodester/cryptic-puzzle-maker` (React 19 + Vite + PostgreSQL);
we adapt its ideas — **not** its code wholesale — to this stack.

Users **solve** puzzles at public URLs and earn task-completion records like
tutorials. Authors **create/edit** puzzles in a new Admin UI builder tool beside
Missions and Groups. There is **no public discovery or search page** — puzzles
are always linked from other activities; only the builder lists them.

### Guiding invariant

**The answer key (`solution`) never leaves the server.** Grading, Joule hints,
and resume are all designed so this holds *by construction*, not by policy.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Framework | **Port to Vue 3 (public solver island) + freestyle UI5 (admin builder)**. No React runtime shipped. |
| Storage | **JSON columns on the existing `Puzzles` entity**: `layout` (public), `solution` (server-only). `LargeString`/NCLOB on the regular column table. |
| In-DB JSON processing | **Not used in v1.** HANA JSON functions (`JSON_TABLE`, document-store parsing) require a **JSON Document Store collection** — a distinct table type needing the feature enabled. That is a deliberate, additive future opt-in (a collection sidecar), *not* something the NCLOB columns provide implicitly. Ref: help.sap.com JSON Document Store guide. |
| Grading | **Server-side correctness checks with a responsive client** (hybrid). Answers never shipped. |
| Check granularity | **Slot-level** (whole-word), not per-cell — makes brute-forcing 26^n instead of 26/cell, and matches how solvers commit answers. |
| Public delivery | **Static Hugo shell + island fetch.** New puzzles go live on publish; no site rebuild. |
| Builder auto-fill | **Manual grid + clue entry.** No word-list/web-worker auto-fill engine (POC's heaviest, riskiest code). Cryptic clues are hand-written regardless. |
| Joule support | **Gated hint tool; answer never enters Joule's context.** Returns only safe material (clue text, enumeration, correct crossing letters, authored wordplay type). Default off via `ChatSettings` flag. |
| Completion | **Server-confirmed full solve** writes `TaskRecord(taskType='PUZZLE')`. **Plus server-side in-progress `PuzzleProgress`** for cross-device resume. |
| Linking | **Slug links** + add `PUZZLE` to `CompletionPathItems.taskType` so puzzles can be formal path steps. |
| Seed | **Seed the POC's "Devtoberfest Cryptic Crossword"** (15×15, 45 clues) via a transform script → CSV, so it need not be recreated by hand. |

## Architecture

```
ADMIN (authoring)
  app/admin/puzzles/  — freestyle UI5 grid editor (auto-discovered)
    · grid design (black-cell toggle, 180° symmetry), auto-numbering
    · per-slot answer + clue + optional hint-metadata (wordplay type)
    · lists all puzzles by title/tag/status + copyable public URL
        │ OData V4 writes (layout + solution)
        ▼
  AdminService.Puzzles  (@requires Admin, @odata.draft.enabled)

BACKEND (CAP)
  db: Puzzles += slug, layout(NCLOB), solution(NCLOB)
      PuzzleProgress entity (per-user partial grid, resume)
      CompletionPathItems.taskType += PUZZLE
  PuzzleService  @path:/api/puzzles  (public; layout-only projection)
    · GET  Puzzles(:slug)               → layout, NEVER solution
    · action check(slug, entries[])     → per-slot correct booleans + complete
    · action saveProgress / function getProgress   (authed)
    · action complete(slug)             → writes TaskRecord (authed)
  srv/lib/kg/joule-tool-puzzle-hint.js  (gated; safe hint material only)

PUBLIC (solving)
  hugo/layouts/puzzles/single.html  — static shell + shared header + theme
  hugo-apps/src/puzzle/             — Vue 3 island
    · responsive fill/highlight client-side
    · slot-level correctness checks + completion via PuzzleService
    · resume: localStorage (anon) / PuzzleProgress (authed)
  URL: /puzzles/:slug  (approuter → CAP, authless read)
```

### Four independently-buildable units

1. **Data model** (`db/`) — columns + `PuzzleProgress` + enum additions. Verified with `cds deploy --to sqlite::memory:`.
2. **PuzzleService** (`srv/`) — public read/check/progress/complete + Joule hint tool. Unit + hybrid tested, no UI.
3. **Admin builder** (`app/admin/puzzles/`) — freestyle UI5 grid editor. Auto-discovered by the admin-shell build.
4. **Solver island** (`hugo-apps/src/puzzle/` + Hugo layout) — Vue 3, talks only to PuzzleService public endpoints.

Puzzles are structured JSON served **as data**, so they do **not** touch the
tutorial/concept `content-store.js` BLOB publish/serve pipeline.

## Data Model

Extend the existing entity in `db/schema.cds` (no new peer entity):

```cds
entity Puzzles : TaskBase {
  slug      : String(255) @assert.unique;   // canonical lowercase; public URL key
  layout    : LargeString;                   // JSON: {rows,cols,grid:[[{black,number}]],clues,wordLengths,enumeration}
  solution  : LargeString;                   // JSON: {"r,c":"LETTER"} — SERVER ONLY
}
```

New entity — cross-device resume:

```cds
entity PuzzleProgress : cuid, managed {
  user          : Association to Users   @mandatory;
  puzzle        : Association to Puzzles @mandatory;
  filledGrid    : LargeString;   // JSON {"r,c":"LETTER"} — the user's own guesses
  attemptNumber : Integer default 1;
  // @assert.unique on (user, puzzle): one live grid per user per puzzle
}
```

Storing the user's guesses is not a leak — grading still compares server-side
against `solution`.

**Enum additions:**
- `CompletionPathItems.taskType`: `TUTORIAL | GROUP | CHECKPOINT` **+ `PUZZLE`**.
- `FeaturedTasks.taskType`: **unchanged** (no homepage feature / discovery in v1).

**Migration:** column additions + `PuzzleProgress` regenerate `.hdbmigrationtable`
artifacts via `cds build --production` — never hand-edited. `@assert.unique` is
CAP-runtime only (not a DB constraint), so both read and write paths
lowercase-canonicalize the slug; run `cds deploy --to sqlite::memory:` before
committing schema changes.

## PuzzleService (public backend)

`@path: '/api/puzzles'`, separate from `AdminService` to keep the public surface
small and auditable.

```cds
service PuzzleService @(path: '/api/puzzles') {
  @readonly entity Puzzles as projection on ims.Puzzles {
    ID, slug, title, description, primaryTag, experienceTag,
    averageTimeToComplete, layout           // NO solution — physically absent
  };

  action check(slug: String, entries: many { slotId: String; word: String; })
    returns { results: many { slotId: String; correct: Boolean; }; complete: Boolean; };

  action   saveProgress(slug: String, filledGrid: LargeString) returns Boolean;
  function getProgress(slug: String) returns { filledGrid: LargeString; attemptNumber: Integer; };
  action   complete(slug: String) returns { recorded: Boolean; alreadyComplete: Boolean; };
}
```

**Handlers** (`srv/puzzle-service.js`):

- **`check`** — loads `solution` server-side, compares each **whole submitted
  word** against the slot's answer, returns per-slot `correct: Boolean` + a
  `complete` flag. **Never returns correct letters.** Partially-typed slots are
  not checkable (client only offers "check" on fully-filled words). Unknown slot
  ids / partial words → ignored gracefully, never a 500.
- **`saveProgress`** — upserts the `PuzzleProgress` row for `(user, puzzle)`.
- **`getProgress`** — returns the caller's stored grid.
- **`complete`** — server re-grades the full grid against `solution`; only on
  100% correct writes `TaskRecords(taskType='PUZZLE', status='COMPLETED',
  progress=100)`, mirroring `completeStep`. Idempotent (`alreadyComplete`).
  Auto-provisions the `Users` row like the tutorial path.

**Auth posture:**
- `GET` layout + `check` → **anonymous allowed** (public, linked from anywhere).
- `saveProgress` / `getProgress` / `complete` → **`@requires: 'authenticated-user'`**.

Anonymous visitors can solve + check; logged-in users additionally get
cross-device resume and a completion record — matching tutorial behavior.

**Approuter wiring** (`approuter/xs-app.json`): `^/api/puzzles/(.*)$` → `srv-api`,
`authenticationType: "none"`; the authed actions enforce auth at the CAP layer
via `@requires` (401 without JWT). Follow the existing `/api/advocates` route
pattern for consistency.

**Note on `getMyCompletions`:** currently TUTORIAL-only (`srv/lib/user-progress.js`).
Extending it to surface completed puzzles is **out of scope for v1** unless the
completion records need to appear in a "my completions" list; flagged for the plan.

## Admin Builder (freestyle UI5)

New auto-discovered component `app/admin/puzzles/` — **freestyle UI5, not Fiori
Elements** (a grid editor is a custom canvas, not a form). The admin-shell build
discovers any folder with `webapp/Component.js` + `webapp/manifest.json`.

**Registration touch points:**
- `app/admin/puzzles/webapp/` — `Component.js`, `manifest.json` (namespace
  `sap.tutorials.admin.puzzles`, `mainService` → `/admin/`), freestyle `sap.m` view.
- `app/admin-shell/webapp/model/navigation.json` — `{ "key": "puzzles", "title": "Puzzles" }` in the `content` group.
- `app/admin-shell/webapp/controller/Shell.controller.js` — `puzzles` in `NAV_KEY_TO_ROUTE` + `NAV_KEY_TO_TITLE`.
- `app/admin-shell/scripts/admin-shell-overrides.js` — slot into `order[]`, unique hash prefix (e.g. `'pz'`).

**Builder UI:**
- **Puzzle list** — `sap.m.Table` (title, slug, tag, status, copyable public URL) + Create/Edit/Delete.
- **Grid editor** — click toggles black cells with **180° rotational symmetry**; auto-numbers slots. Reuses the POC's `crossword.js` **pure functions** (`setBlack`, `findSlots`, etc.) as framework-agnostic modules.
- **Slot panel** — per across/down slot: answer (→ `solution`), clue text (→ `layout.clues`), optional enumeration/`wordLengths`, optional **hint metadata** (wordplay type dropdown → Joule tool).
- **Save** — assembles `layout` + `solution` JSON, writes via `AdminService.Puzzles` (draft-locked).

`AdminService.Puzzles` gains `@odata.draft.enabled` + field-level exposure of
`layout`/`solution`/`slug`/hint fields in `app/admin-annotations.cds`. Because
the builder is freestyle, it drives OData writes directly — only field-level
exposure is needed, not `@UI.LineItem`/`Facets`.

**Theme:** inherits `sap_horizon` + auto dark/light from the admin shell.

**Deploy:** full `npm run deploy -- --env <env>` (NO `--skip-build`, NO `-m`);
Step 3.5 (`check-shipped-admin-bundle.cjs`) verifies the shipped bundle.

## Solver Island (Vue 3) + Joule hints

**Page** — `hugo/layouts/puzzles/single.html`, a thin static shell inheriting
header/footer/theme from `baseof.html`, `data-page-kind="puzzle"`:

```html
{{ define "main" }}
<main id="puzzle-mount" data-slug="{{ .Params.slug }}" data-api="/api/puzzles"></main>
<noscript>This puzzle requires JavaScript.</noscript>
<script type="module" src="{{ "/js/puzzle.js" | relURL }}"></script>
{{ end }}
```

The page carries no puzzle data; the island fetches `layout` by slug at load.

**Island** — `hugo-apps/src/puzzle/` (`main.ts` + `App.vue` + components), a Vite
input entry with its own gzip budget. Ported from the POC solver (`Puzzle.jsx`),
Vue 3 + our theme:
- Renders grid from fetched `layout`; across/down clue lists; click-to-focus,
  arrow/tab navigation, type-to-fill.
- **Client-side (responsive):** fill state, current-slot highlight, word-complete
  detection — no answers needed.
- **Check:** a "check" affordance lights up only for fully-filled slots → POST
  `check` with slot-level entries → green/red per checked slot.
- **Resume:** anon → `localStorage`; authed → debounced `saveProgress`/`getProgress`.
- **Completion:** on all-correct → POST `complete` (writes TaskRecord for authed
  users) + confetti flourish (retained from POC).
- **Theme:** uses CSS vars (`sap-theme-vars.css` / dark overrides); no hardcoded
  colors. UI5 web components come from the global bootstrap — the island must
  **not** re-import them (bundle bloat, per the islands pattern; use render
  functions, not string templates — Vite ships runtime-only Vue).

**Joule hint tool** — `srv/lib/kg/joule-tool-puzzle-hint.js`, gated by a new
`ChatSettings` flag (matching the existing KG-tool + flag pattern). Given
`slug` + `slotId`, returns **only safe material**: clue text, enumeration/length,
the user's already-correct crossing letters, and the authored wordplay type. The
`solution` letters **never enter the tool's return value or Joule's context** —
so no prompt can extract them. Joule coaches on cryptic technique. Fail-open: any
throw → generic coaching, never a chat error. Default **off** until verified
(flipped by an admin like `communityPeersEnabled`).

## Error Handling

- **Answer-leak guard (critical):** unit test asserts the `PuzzleService.Puzzles`
  payload has **no `solution` field**, and `check` returns only booleans, never
  letters. Regression tripwire for the whole answer-hiding design.
- **Malformed grid JSON:** a CAP `before` handler on `AdminService.Puzzles`
  create/update validates `layout`/`solution` shape (parseable JSON, grid dims
  match, every white cell has an answer letter) — rejects with a clear error.
- **Missing/invalid slug:** public read → **404 JSON** (not the HTML 404 shell).
- **Grading edge cases:** partial/unknown submissions ignored gracefully.
- **Joule tool:** fail-open to generic coaching.

## Testing

- **Unit** (in-memory SQLite): projection leak guard; slot-level `check` grading;
  `complete` idempotency + TaskRecord write; JSON validation handler;
  `taskType='PUZZLE'` accepted; `CompletionPathItems.taskType` accepts `PUZZLE`.
- **Hybrid** (real HANA via `cds bind`): NCLOB round-trip for `layout`/`solution`;
  `PuzzleProgress` upsert uniqueness; slug canonicalization.
- **e2e** (post-deploy Playwright, per #1378): load a seeded puzzle through the
  approuter, fill + check a word, verify red/green. User-facing UI change → wants
  a committed spec.
- **TDD** (superpowers): projection guard + grading tests written before handlers.

## Seed Data — POC puzzle

Seed the POC's **"Devtoberfest Cryptic Crossword"** (15×15, 45 clues, full answer
key — already captured from the POC repo).

- A one-time transform script converts the POC's `public_data` + `answers` JSON
  into our `layout`/`solution` shape, emitted as `db/data/*.Puzzles.csv` with a
  stable `legacyId` + slug `devtoberfest-cryptic-crossword`.
- **CSV-wipe caution:** seed CSVs replace admin-editable columns on every deploy
  where the hash changes. Since authors edit puzzles in the builder, treat this
  seed as **dev-bootstrap only** — gate it so it doesn't clobber edited rows, or
  document it as a one-time load. Exact mechanism (CSV vs. guarded seed handler)
  decided during planning, flagging the trade-off.

## Out of Scope (v1)

- Public discovery / search / index page for puzzles.
- Homepage featuring (`FeaturedTasks`) of puzzles.
- Word-list auto-fill engine (POC web-workers).
- HANA JSON Document Store collection (future opt-in for in-DB JSON queries).
- `getMyCompletions` puzzle surfacing (flagged; decide in planning).
- Puzzle types beyond cryptic crossword (the model is crossword-shaped in v1).

## Key File Paths

- Schema: `db/schema.cds` (Puzzles, PuzzleProgress, enums), `db/views.cds` (Tasks UNION, TaskRecordsAnalytics — already include PUZZLE)
- Backend: `srv/puzzle-service.cds` + `srv/puzzle-service.js` (new); `srv/admin-service.cds` + `app/admin-annotations.cds` (draft + field exposure); `srv/lib/kg/joule-tool-puzzle-hint.js` (new)
- Admin builder: `app/admin/puzzles/**` (new); `app/admin-shell/webapp/model/navigation.json`; `app/admin-shell/webapp/controller/Shell.controller.js`; `app/admin-shell/scripts/admin-shell-overrides.js`
- Public: `hugo/layouts/puzzles/single.html` (new); `hugo-apps/src/puzzle/**` (new); `hugo-apps/vite.config.ts` (input entry + budget); `approuter/xs-app.json` (route)
- Seed: transform script + `db/data/*.Puzzles.csv` (new)
