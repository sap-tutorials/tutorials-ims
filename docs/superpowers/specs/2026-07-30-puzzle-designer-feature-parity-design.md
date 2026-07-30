# Puzzle Designer — Feature Parity with Original POC

**Date:** 2026-07-30
**Status:** Design approved; ready for implementation plan
**Scope:** Port the missing feature set from the original cryptic-crossword POC into the current admin-UI puzzle designer, at full parity, while keeping our current extras (per-slot cryptic hint types, OData draft/publish flow, HANA persistence).

## Background

The original POC (`D:/projects/cryptic-puzzle-maker/`, live at
`https://cryptic-crossword.cfapps.eu10.hana.ondemand.com/`) is a **React 19 + Vite +
Express + Postgres** app. Our replacement (`app/admin/puzzles/`) is a **freestyle
SAPUI5** app inside the admin ToolPage shell, backed by **CAP + SAP HANA**. This is a
cross-stack re-implementation, not a copy.

The current builder is a capable but *answer-first* editor: create/list/edit puzzles,
design the black-square grid (180° symmetry + auto-numbering), hand-type letters, enter
clues + a per-slot cryptic hint type, save via the OData V4 draft-activate flow, and
share a public `/puzzles/<slug>` URL.

The POC is *word-list-first*: paste candidate words, auto-fill builds the grid, live
per-slot suggestions assist, and the author refines. The seven user-named "missing"
features all hang off that model.

### Gap analysis (POC → current admin builder)

| Feature | POC | Current | Gap |
|---|---|---|---|
| Word-list panel (textarea + live count) | yes | — | Missing |
| Word-list upload (.txt/.csv) | yes | — | Missing |
| Import (JSON) | yes | — | Missing |
| Export (JSON) | yes | — | Missing |
| Print / Export | `window.print()` + print CSS | — | Missing |
| Clear Grid / Clear Words | two buttons | per-cell Backspace only | Missing buttons |
| Instructions / help | inline + modal hints | — | Missing |
| Grid templates (Select/Save Grid) | 10 presets + user-saved | — | Missing |
| Auto-fill (Fill Grid / Just Fill) | 2 Web-Worker solvers | — | Missing |
| Live per-slot suggestions | yes | — | Missing |
| Grid sizing (rows/cols) | yes | yes (on new only) | Minor |
| Black-cell design + 180° symmetry | yes | yes | Parity |
| Clue entry Across/Down | yes | yes (+ hint types) | Parity+ |
| Publish + public URL | yes | yes (draft-activate) | Parity |
| Published-puzzle manager (Load/Unpublish) | table | list only | Partial |

## Approved decisions

1. **Scope:** full parity + keep our extras (hint types, draft/publish, HANA).
2. **Authoring model:** unify — auto-fill, suggestions, and hand-typing all write the
   same `b>/answers` map. One data path; clue/hint panels and save are agnostic to how
   letters were produced.
3. **Import/Export format:** our own clean JSON (not POC-compatible). Includes
   `answers` + `hints`, which the POC format lacks.
4. **Auto-fill dictionary:** bundled as a static asset served from our approuter
   (no runtime GitHub fetch — avoids approuter CSP `connect-src` issues).
5. **Solver location:** client-side Web Worker (off-thread, streaming progress,
   cancelable), with a chunked main-thread fallback if CSP blocks classic workers.
6. **Grid templates:** shared, persisted in HANA via a new CAP entity (built-in presets
   seeded; author-saved templates shared across authors), not browser localStorage.

## Architecture

Extend the existing single-`sap.m.Page` builder in place — do not rewrite. The geometry
lib (`lib/crossword-geometry.js`) already exports `makeEmptyGrid`, `setBlack`,
`findSlots`, `numberGrid`, `slotFilled`, `slotHasCrossing`, `placeWord`, `removeWord`,
`canFit` — the exact primitives the solver and suggestions need, so most new work is
orchestration.

### Frontend (`app/admin/puzzles/webapp/`)

- `controller/Builder.controller.js` — extend with new handlers: word-list parse/upload/
  clear, auto-fill (start/stop/apply), suggestions, template select/save/delete, clear
  grid/words, import, export, print, help.
- `view/Builder.view.xml` — add (a) a **word-list panel** as a left column in edit mode,
  (b) an **edit-mode `OverflowToolbar`** holding the new action buttons, (c) a **fill
  status strip** with a Stop button, (d) a **suggestions list** beside the focused slot.
  Keep the grid host + Across/Down slot panels as-is.
- `lib/solver-core.js` *(new)* — pure backtracking-MRV solver functions; no `self`/DOM.
  Shared by the worker and unit tests. Deterministic (fixed exploration order, no
  `Math.random`).
- `lib/fill-worker.js` *(new)* — Web Worker shell wrapping `solver-core`; two modes
  (`wordlist` = author's words, 12s cap; `dictionary` = bundled list, 30s cap). Streams
  `progress` / `heartbeat` / `result` / `error`; terminable for Stop.
- `static/dictionary/common-english.txt` *(new asset)* — ~10k common English words,
  served same-origin from the approuter.
- App-level print CSS — hide shell chrome + toolbar when printing; lay out grid + clues.

### Backend (CAP)

- **New entity `GridTemplates`** exposed on `AdminService`, draft-enabled, seeded with the
  POC's ~10 symmetric 15×15 presets.
  - Fields: `ID (UUID key)`, `name : String`, `rows : Integer`, `cols : Integer`,
    `blacks : LargeString` (JSON array of `[r,c]` pairs), `isBuiltin : Boolean`.
  - Built-in rows are read-only in the UI; author-saved rows are deletable.
  - CSV/seed handling must respect the project's `.hdbtabledata` column-wipe gotcha
    (delete seed CSV + add to `db/undeploy.json` if columns are admin-editable — here
    templates are not admin-edited field-by-field, so a stable seed CSV is acceptable;
    confirm during planning).
- **`Puzzles` layout/solution model unchanged.** Auto-fill/suggestions/hand-typing all
  write `b>/answers`; `onSave` already serializes that to the `solution` JSON and the
  grid/clues/hints/wordLengths to the `layout` JSON.

### Unification point

```
word list ─┐
suggestion ─┼─→ write letters → b>/answers ("r,c"→LETTER) → _recomputeSlots() → _renderGrid()
auto-fill ─┘                                                        │
hand-type ─────────────────────────────────────────────────────────┘
                                        onSave → layout JSON + solution JSON  [UNCHANGED]
```

## Components & behaviors

### A. Word-list panel
- `TextArea` bound to `b>/wordText`; live "N words" count.
- Parser: split on `/[\n,;]+/`, uppercase, strip non-A–Z (POC parity).
- **Upload**: `FileReader` reads `.txt`/`.csv` text into the textarea (client-side, no
  server round-trip). Non-text/oversized → toast, textarea untouched.
- **Clear** (word list): empties textarea; visible only when non-empty.

### B. Auto-fill
- **Fill Grid**: worker `mode:'wordlist'` over `b>/wordText`, 12s cap.
- **Just Fill**: worker `mode:'dictionary'` over bundled list, 30s cap.
- Live progress streams placed letters into the grid; **Stop** terminates the worker.
- On `result`: merge letters into `b>/answers`, `_recomputeSlots()`, `_renderGrid()`.
- On timeout / no-solution / error: toast; grid stays at last good state (never commit a
  half-written grid silently).

### C. Live per-slot suggestions
- When a slot/cell is focused, compute candidates from `b>/wordText` matching slot length
  and already-placed crossing letters (reuse `canFit`).
- Render a small clickable list beside the focused slot; click → `placeWord` into
  `/answers` → recompute + render.

### D. Grid templates (HANA-persisted)
- **Select Grid**: dialog listing `AdminService.GridTemplates` (built-ins + user-saved)
  with mini-grid previews; click loads black-cells into the current grid, then renumber.
- **Save Grid**: serialize current black-cells → new `GridTemplates` row via the existing
  draft-activate + `_withCsrf` flow. Delete removes user templates; built-ins read-only.

### E. Clear controls (toolbar)
- **Clear Grid**: reset to empty grid at current rows/cols (keep title/slug).
- **Clear Words**: wipe all letters from `/answers`, keep black cells + clues.
- Both re-render.

### F. Import / Export (clean JSON)
- **Export**: download current puzzle as
  `{ rows, cols, grid, wordText, clues, hints, wordLengths, answers, title, slug }`.
- **Import**: file picker → validate `rows`/`cols`/`grid` shape → restore full model.
  Malformed → `MessageBox.error`, model untouched.

### G. Print / Export
- **Print**: `window.print()`; app print CSS hides shell chrome + toolbar, lays out grid +
  Across/Down clue lists.

### H. Instructions / Help
- Help button (`sap-icon://sys-help`) → `MessagePopover`/dialog covering design-vs-fill,
  180° symmetry, suggestions, auto-fill, import/export.
- Concise inline hint line (POC parity).

### Published-puzzle manager parity
- Add **Load into Editor** and **Unpublish** row actions to the existing list table so it
  matches the POC's Published tab.

### Explicitly NOT ported
- POC browser-`localStorage` grid storage (superseded by HANA `GridTemplates`).
- POC runtime GitHub dictionary fetch (superseded by bundled static asset).

## Error handling summary

- **Solver**: timeout / no-solution / worker error → toast; last good grid preserved.
- **Import**: shape-validate before apply; malformed → `MessageBox.error`, model intact.
- **Templates**: draft-activate failures surface via existing `_withCsrf` error path.
- **Upload**: non-text/oversized → toast, textarea intact.

## CSP / runtime hazards

- Worker loaded as a **same-origin classic worker**
  (`new Worker(sap.ui.require.toUrl("sap/tutorials/admin/puzzles/lib/fill-worker.js"))`),
  **not** `import()` of ESM. The approuter CSP forbids `'unsafe-eval'`;
  `import(toUrl(...))` evaluates module source as a string and is blocked — the failure
  documented in `Builder.controller.js` and the `ui5-csp-blocks-dynamic-import` memory.
- **Fallback**: if the classic-worker path is also CSP-blocked on DEV, use a chunked
  main-thread solver that yields via `setTimeout` between backtracking batches. Decision
  made by live verification on DEV, not assumption.

## Testing & verification

Follows the project's "test the actual thing through the real entry point" rule and the
committed-e2e-spec pattern (post-DEV-deploy Playwright job; #1371/#1378 lesson).

1. **Unit** (`test/unit/`): `solver-core` (solves a known grid, respects crossings, times
   out gracefully, deterministic), word-list parser, import/export round-trip, template
   serialize/deserialize. Pure, fast, in-memory.
2. **Backend** (hybrid, `cds bind`): `GridTemplates` draft CRUD + built-in seed presence.
3. **E2E** (`test/e2e/`, committed spec): drive the real admin UI in a browser — create
   puzzle → paste word list → upload file → Fill Grid → click a suggestion → apply a
   template → Clear → export → re-import → save → verify via public `/puzzles/<slug>`.
4. **Manual pre-"done" verification**: load the deployed admin UI in Playwright with the
   maintainer's session; exercise every new button; screenshot.

## Deploy notes

- Admin-UI changes are **bundle-gated**: deploy with a full `npm run deploy -- --env dev`
  (NO `--skip-build`, NO `-m` scoping) or a stale admin bundle ships (#1348). Step 3.5
  bundle diff must pass.
- The new `static/dictionary/common-english.txt` asset MUST be added to the approuter
  `static/*` list in `.deploy/mta.yaml`, and to the content-rebuild Assemble list if
  applicable (rebuild tarball atomically replaces approuter static — #1239), or it won't
  ship.
- Schema change (`GridTemplates`): run `cds build --production` for `db/last-dev/` and
  regenerate the `.hdbmigrationtable` via the targeted `cds build --for hana` path; never
  hand-author the ALTER (migration-counter poisoning gotcha).
- MTA version bump: minor (new feature) in `.deploy/mta.yaml`.

## Out of scope / open items for planning

- Exact `GridTemplates` seed mechanism (CSV vs programmatic seed) — confirm against the
  `.hdbtabledata` column-wipe gotcha during planning.
- Whether to bump `sap.app.applicationVersion` in `manifest.json` to bust the admin UI5
  fragment IndexedDB cache after deploy (likely yes — fragment/view changes).
