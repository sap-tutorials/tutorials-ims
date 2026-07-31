# Puzzle Solver Fixes & Enhancements (Issue #1412)

**Date:** 2026-07-31
**Status:** Design approved; ready for implementation plan
**Issue:** [#1412](https://github.com/sap-tutorials/tutorials-ims/issues/1412) — 7 items on the visitor-facing puzzle **solver** (Vue island + public `PuzzleService`), not the admin builder.

## Background

The public crossword solver is a Vue 3 island at `hugo-apps/src/puzzle/` (`App.vue` +
`lib/geometry.ts` + `lib/server.ts`), hosted by `hugo/layouts/puzzles/single.html`,
backed by the anonymous-capable CAP `PuzzleService` at `/puzzle-api`. This change fixes
7 reported problems. Two require backend changes (`check` response contract; a new reset
action) and one is a data correction; the rest are solver/CSS.

Key architectural facts (verified in code):

- `/puzzle-api/check` is an **anonymous** approuter route (`xs-app.json`,
  `authenticationType:"none"`); `saveProgress`/`getProgress`/`complete` are
  `@requires:'authenticated-user'`.
- The server **never returns solution letters** — `puzzle-grading.js` grades and returns
  per-slot booleans only. This security property must be preserved.
- Anonymous solving state lives **only in `localStorage`** (`puzzle-answers-<slug>`); the
  server progress store is keyed by DB `user_ID` and 401s for anonymous users.
- Tutorials already have a reset pattern: `resetTutorialProgress`
  (`srv/developer-service.js:232-309`) = **supersede live TaskRecords + start new
  attempt**, never delete. The whole system reads completion by filtering
  `status != 'SUPERSEDED'`.

## Approved decisions

1. **Check coloring (items 4 + 6, unified):** per-cell. Correct letters green; wrong
   letters red (only the actual wrong cell, not the whole word); blank white cells that
   should contain a letter → red. Requires the server to return per-cell correctness.
2. **Anonymous progress (item 3):** warn **and** migrate. Show a persistent
   not-logged-in banner; on login, if server progress is empty but localStorage has a
   grid, upload it via `saveProgress`.
3. **Data fix (item 6):** fix both the seed file **and** the live DEV stored solution.
4. **Check API shape:** extend `check` — keep `results:[{slotId,correct}]` (back-compat)
   and add `cells:[{r,c,correct}]`. Do not replace.
5. **Blank-cell reveal:** never return expected letters. Blanks that should have a letter
   are marked wrong (red) without revealing the answer.

## Items & implementation

### Item 1 — Check fails when logged out (client-only)

`postCheck` (`hugo-apps/src/puzzle/lib/server.ts:89-102`) uses `csrfFetch`, which for a
POST first does `GET /auth/user` expecting an `x-csrf-token` response header. That header
is only emitted for **authenticated** sessions, so an anonymous user gets
`status=200, header absent` → `CsrfFetchError` before the check POST is ever sent.

`/puzzle-api/check` is an anonymous route needing no CSRF token. **Fix:** `postCheck`
uses plain `fetch` (mirroring `hugo-apps/src/tutorial-feedback/api.ts:12-19`).
`postSaveProgress`/`postComplete` keep `csrfFetch` (they hit the xsuaa route and the user
is logged in). No approuter change. Verify `/puzzle-api/check` is allowlisted by
`scripts/check-csrf-clients.ts` (if that guard flags plain mutating fetches).

### Items 4 + 6 — per-cell check coloring + per-letter wrong

**Backend (`srv/lib/puzzle-grading.js` + `srv/puzzle-service.js`):**
- `gradeEntries` gains a per-cell dimension. For each submitted entry, walk the slot's
  cells against the solution and emit `{r,c,correct}` per cell (correct = submitted
  letter at that cell === solution letter). Return
  `{ results:[{slotId,correct}], cells:[{r,c,correct}], complete }` — `results` unchanged
  for back-compat; `cells` is new.
- The `check` handler (`puzzle-service.js:35-62`) currently only grades whole entries.
  Change the client to submit slots with **≥1 filled cell** (not only full slots) so
  partial words get per-cell feedback. Server dedups cells (a cell shared by across+down
  is correct only if the letter matches — same letter, so no conflict; if two entries
  disagree on a shared cell, `correct=false` wins).
- Expected letters are never included in the response.

**Frontend (`lib/server.ts` + `App.vue`):**
- `buildCheckEntries` (`server.ts:20-32`): include slots with ≥1 filled cell (drop the
  `every` full-slot filter; keep only non-empty slots), so blanks within a partially
  filled word are still submitted for their filled neighbors.
- New `CheckResult.cells: Array<{r,c,correct}>`. `buildCellStatus` rewritten to consume
  `cells` (per-cell) instead of fanning a slot boolean across all cells
  (`server.ts:41-56`).
- **Blank-red (item 4):** after applying per-cell correct/wrong from the response,
  `checkPuzzle` (`App.vue:200-213`) marks every **white, non-black cell that is empty**
  as `'wrong'` in `cellStatus` (client-side; the server can't see blanks it wasn't sent).
  This turns unfilled squares red on Check. Existing `.cell-correct`/`.cell-wrong` CSS
  (`App.vue:660-672`) already styles green/red.
- Recompute is on-demand (only after a Check); typing into a red cell clears its status
  for that cell (so red doesn't persist misleadingly) — clear `cellStatus[r,c]` in the
  letter-entry handler.

**Data fix (item 6):** clue `4-12-down` "golden ratio" should be PHI; stored solution has
cell `(5,12)="S"` (PSI) — must be `"H"`. Cell `(5,12)` has no crossing across-word (safe).
- Edit `scripts/seed/poc-puzzle.answers.json` `"5,12":"S"` → `"H"` (fresh envs).
- Correct the **live DEV** stored `Puzzles.solution` via the admin builder draft-save
  (load puzzle → fix the letter → save), since the seeder is insert-only and won't
  overwrite deployed data. Verify post-fix: `POST /puzzle-api/check {slotId:'4-12-down',
  word:'PHI'}` returns `correct:true`.

### Item 2 — reset completion (backend action + solver button)

**Backend:** new `@requires:'authenticated-user'` action `resetPuzzleProgress(slug)` on
`PuzzleService` (`srv/puzzle-service.cds` + handler in `srv/puzzle-service.js`), mirroring
`resetTutorialProgress`:
- Resolve user (401 if anon) + slug→puzzle.
- Supersede the live PUZZLE `TaskRecord` (`UPDATE ... SET status='SUPERSEDED'` where
  `user_ID`, `taskLegacyId=puzzle.legacyId`, `taskType='PUZZLE'`, `status!='SUPERSEDED'`).
- Reset `PuzzleProgress`: clear `filledGrid` to `'{}'` and bump `attemptNumber`.
- Return `{ newAttemptNumber, previousCompletionDate, supersededRecordCount }`.
- Optional: `cds.emit('PuzzleProgressReset', {...})` for audit parity (only if tutorials'
  event is consumed somewhere — otherwise omit, YAGNI).

**Frontend:** a "Reset" button in the solver, shown when the puzzle is completed AND the
user is authed. On click: confirm, call `resetPuzzleProgress`, then clear the local grid
(`answers={}`, `cellStatus={}`, `solved=false`, clear `localStorage`).

### Item 3 — anonymous progress: warn + migrate

**Warn:** a persistent banner in `App.vue` shown when `!authed.value`: "You're not logged
in — your progress won't be saved to your account. Log in to save your progress." `authed`
already exists (`App.vue:54`) but is never rendered.

**Migrate:** fix the `resumeProgress` early-return seam (`App.vue:130-151`). Currently when
authed it loads server progress and `return`s even when the server grid is empty, orphaning
any localStorage grid from a pre-login anonymous session. New logic:
- If authed and server `filledGrid` is non-empty → load it (server wins).
- If authed and server is empty BUT localStorage has a grid → adopt the local grid AND
  immediately `postSaveProgress` to migrate it into the account, then continue.
- If anonymous → load localStorage as today.

### Item 5 — scroll active clue into view

`handleCellClick` (`App.vue:249-269`) sets cursor/dir but never scrolls. The clue columns
are scrollable (`.puzzle-clues-col { max-height:32rem; overflow-y:auto }`,
`App.vue:537-543`) but clue items have no refs.
- Add a template ref keyed by slot id on each clue `<li>`.
- `watch(activeSlot, ...)`: when it changes, `scrollIntoView({block:'nearest',
  behavior:'smooth'})` the active clue's element within its column. Guard for null.

### Item 7 — adaptable layout, more clue space, center

`App.vue` scoped CSS only (`:516-548`). Layout is 3-column flex
`[Across][Grid+Actions][Down]`, currently left-aligned (`align-items:flex-start`, no
horizontal centering), clue columns capped `max-width:16rem`.
- Center the whole layout on the page (`justify-content:center` on `.puzzle-layout`, or a
  centered wrapper with `margin-inline:auto` + `max-width`).
- Give clues more room: raise the clue-column `max-width` (e.g. 20-24rem) / `flex` basis;
  keep the grid cell size fixed (`--puzzle-cell-size` unchanged) so the grid doesn't shrink.
- Preserve the `<900px` responsive stack.

## Error handling

- **Check (anon):** plain `fetch`; on non-2xx, `statusMsg` shows the error (unchanged
  surfacing). No CSRF path for the anonymous route.
- **Migrate:** server save failure on migration is swallowed (local copy still valid),
  same as existing autosave.
- **Reset:** 401 for anon (button only shown when authed); network error → toast, local
  state unchanged until the server confirms.
- **Blank-red:** purely client-side derivation; never depends on the server returning
  letters.

## Testing & verification

- **Unit** (`hugo-apps/src/puzzle/__tests__/`): `buildCheckEntries` (≥1-filled inclusion),
  `buildCellStatus` (per-cell mapping from `cells`), the blank-red derivation helper (a
  pure function that, given grid + answers + cellStatus, returns the set of empty white
  cells to mark wrong), and the migration-decision helper (authed + empty-server +
  local-present → migrate).
- **Backend unit** (`test/unit/`): `gradeEntries` per-cell output (correct/wrong cells,
  shared-cell conflict → wrong, no letters leaked); `resetPuzzleProgress` supersede logic.
- **Backend hybrid** (`test/hybrid/`): `resetPuzzleProgress` against real HANA
  (supersedes the PUZZLE TaskRecord, bumps attempt) using `cds.connect.to` (not
  unauthenticated fetch — the auth-gap lesson from the GridTemplates hybrid test).
- **e2e** (`test/e2e/`, committed, self-skipping): solver flow — load puzzle, check while
  logged out (no CSRF error), per-cell red/green + red blanks, click a cell scrolls its
  clue into view. Mirrors the existing `test/e2e/puzzle-solve.test.js` harness
  (`playwright-core` + vitest, `describe.skipIf`).
- **Live browser verification on DEV** (the real entry point, per project rule): check
  logged-out; per-letter red (PHI vs the corrected answer); blank cells red; clue
  scroll; reset button; not-logged-in banner + login migration; centered/roomier layout.

## Deploy notes

- Solver island + CSS ship via `npm run build:all` (Hugo + hugo-apps) → **bundle-gated
  full deploy** (`npm run deploy -- --env dev`, no `--skip-build`).
- Backend (`check` contract, `resetPuzzleProgress`) ships in `tutorials-srv`.
- Data fix: seed edit is for fresh envs; the **live DEV** correction is a manual
  admin-builder save (or targeted patch) after deploy — call it out in the PR.
- Version bumps: minor (new reset action + solver features) in `.deploy/mta.yaml`; bump
  the solver island version if the project tracks it (hugo-apps has no per-app manifest
  cache like the admin UI5 fragment cache — verify during planning).

## Out of scope / open items for planning

- Whether `resetPuzzleProgress` emits an audit event (only if a consumer exists).
- Exact clue-column widths for item 7 — tune during implementation against the real DOM.
- The deferred admin-builder grid-template Delete (spec §D of the prior feature) is
  unrelated and stays out of this change.
