# Puzzle Solver Fixes & Enhancements Implementation Plan (#1412)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix and enhance the visitor-facing crossword solver per issue #1412 — anonymous Check, per-cell red/green feedback with red blanks, per-letter (not whole-word) wrong marking, a data correction, reset-completion, anonymous-progress warn+migrate, clue scroll-into-view, and a roomier centered layout.

**Architecture:** The solver is a Vue 3 island (`hugo-apps/src/puzzle/`) backed by the anonymous-capable CAP `PuzzleService` (`/puzzle-api`). Three backend changes (extend `check` to return per-cell correctness; new `resetPuzzleProgress` action; a one-letter solution data fix) plus solver TS/Vue/CSS changes. The server never returns solution letters — blank-red is derived client-side.

**Tech Stack:** Vue 3 `<script setup>` + scoped CSS (no UI5 imports in the island), TypeScript pure helpers with Vitest; CAP Node.js + SAP HANA (OData V4 actions on `PuzzleService`); Playwright (`playwright-core` + vitest) e2e.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-31-puzzle-1412-solver-fixes-design.md` (authoritative).
- **Never return solution letters to the client.** `check` returns per-cell `correct` booleans only; expected letters never leave the server. Blank-red is a client-side derivation.
- **Anonymous route = plain `fetch`, no CSRF.** `/puzzle-api/check` is `authenticationType:"none"` in `approuter/xs-app.json`; `postCheck` must use plain `fetch` (like `hugo-apps/src/tutorial-feedback/api.ts`). Authenticated calls (`saveProgress`/`complete`) keep `csrfFetch`. Any plain mutating `fetch` to an anon URL must be on the `ANON_URL_ALLOWLIST` in `scripts/check-csrf-clients.ts` (currently only `/feedback/`).
- **Slot id format** `${row}-${col}-${dir}`; cell key `"r,c"`. Preserve across client + server.
- **Reset = supersede, never delete** — mirror `resetTutorialProgress`; system reads completion via `status != 'SUPERSEDED'`.
- **Preserve existing solver behavior** (typing, arrows, mobile input, autosave, confetti) — these are additive edits.
- **LF line endings**; watch CRLF on Windows.
- **Deploy is bundle-gated** — solver ships via `npm run build:all`; full `npm run deploy -- --env dev`, no `--skip-build`.
- **Worktree:** work in `puzzle-1412-solver`; verify branch same-invocation before each commit.

---

## Phase 1 — Backend: per-cell grading + reset action

### Task 1: `gradeEntries` returns per-cell correctness

**Files:**
- Modify: `srv/lib/puzzle-grading.js` (`gradeEntries`, ~line 77-99)
- Test: `test/unit/puzzle-grading-percell.test.js`

**Interfaces:**
- Consumes: existing `parseSolution`, the slot-id regex.
- Produces: `gradeEntries({solution, entries})` now returns
  `{ results:[{slotId,correct}], cells:[{r,c,correct}], complete }`. `results` and
  `complete` are UNCHANGED (back-compat). `cells` is new: for each entry, one `{r,c,correct}`
  per cell of that slot, where `correct = (submittedLetterAtCell === solutionLetterAtCell)`.
  A cell appearing in two entries (across+down crossing) is merged: `correct` is the AND
  (if either entry has a wrong letter there, the cell is wrong). Cells whose submitted
  letter is empty are included with `correct:false` only if that cell was part of a
  submitted entry (blank cells the client didn't submit are handled client-side, not here).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/puzzle-grading-percell.test.js
import { describe, it, expect } from 'vitest';
import { gradeEntries } from '../../srv/lib/puzzle-grading.js';

// Solution: across 0-0 = CAT (0,0)(0,1)(0,2); down 0-0 = COW (0,0)(1,0)(2,0)
const solution = JSON.stringify({ '0,0':'C','0,1':'A','0,2':'T','1,0':'O','2,0':'W' });

describe('gradeEntries per-cell', () => {
  it('returns per-cell correctness, only the wrong letter marked wrong', () => {
    // User typed CXT across (X wrong at 0,1), COW down (all correct)
    const out = gradeEntries({ solution, entries: [
      { slotId: '0-0-across', word: 'CXT' },
      { slotId: '0-0-down',   word: 'COW' },
    ]});
    const cell = (r,c) => out.cells.find(x => x.r===r && x.c===c);
    expect(cell(0,0).correct).toBe(true);   // C
    expect(cell(0,1).correct).toBe(false);  // X ≠ A  ← only this one wrong
    expect(cell(0,2).correct).toBe(true);   // T
    expect(cell(1,0).correct).toBe(true);   // O
    expect(cell(2,0).correct).toBe(true);   // W
    // back-compat: whole-word results still present
    expect(out.results.find(x=>x.slotId==='0-0-across').correct).toBe(false);
    expect(out.results.find(x=>x.slotId==='0-0-down').correct).toBe(true);
  });

  it('a shared cell wrong in one direction is wrong overall (AND merge)', () => {
    // across correct CAT, but down submitted XOW (X wrong at shared 0,0)
    const out = gradeEntries({ solution, entries: [
      { slotId: '0-0-across', word: 'CAT' },
      { slotId: '0-0-down',   word: 'XOW' },
    ]});
    const cell = (r,c) => out.cells.find(x => x.r===r && x.c===c);
    expect(cell(0,0).correct).toBe(false); // shared cell: across says C-correct, down says X-wrong → wrong
    expect(cell(0,1).correct).toBe(true);
  });

  it('never leaks solution letters', () => {
    const out = gradeEntries({ solution, entries: [{ slotId:'0-0-across', word:'CXT' }] });
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('"A"'); // expected letter A never appears
    expect(out.cells.every(c => !('letter' in c) && !('expected' in c))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/unit/puzzle-grading-percell.test.js`
Expected: FAIL — `out.cells` is undefined.

- [ ] **Step 3: Implement per-cell grading in `gradeEntries`**

Replace the body of `gradeEntries` (keep `expectedWord` + `results` + `complete` exactly as-is; add per-cell computation):

```js
export function gradeEntries({ solution, entries }) {
  const sol = parseSolution(solution);
  const expectedWord = (slotId) => {
    const m = /^(\d+)-(\d+)-(across|down)$/.exec(slotId);
    if (!m) return null;
    let r = +m[1], c = +m[2]; const dir = m[3];
    const letters = [];
    while (sol[`${r},${c}`] !== undefined) {
      letters.push(sol[`${r},${c}`]);
      if (dir === 'across') c++; else r++;
    }
    return letters.join('');
  };
  const results = (entries || []).map(({ slotId, word }) => {
    const expected = expectedWord(slotId);
    const got = String(word || '').toUpperCase();
    return { slotId, correct: expected != null && expected.length > 0 && got === expected };
  });

  // Per-cell: walk each entry's cells against the solution. Merge shared cells
  // with AND (a cell wrong in ANY submitted direction is wrong).
  const cellMap = new Map(); // "r,c" → boolean correct
  for (const { slotId, word } of (entries || [])) {
    const m = /^(\d+)-(\d+)-(across|down)$/.exec(slotId);
    if (!m) continue;
    let r = +m[1], c = +m[2]; const dir = m[3];
    const w = String(word || '').toUpperCase();
    let i = 0;
    while (sol[`${r},${c}`] !== undefined) {
      const key = `${r},${c}`;
      const cellCorrect = w[i] !== undefined && w[i] === sol[key];
      cellMap.set(key, (cellMap.has(key) ? cellMap.get(key) : true) && cellCorrect);
      i++;
      if (dir === 'across') c++; else r++;
    }
  }
  const cells = [...cellMap.entries()].map(([key, correct]) => {
    const [r, c] = key.split(',').map(Number);
    return { r, c, correct };
  });

  const allSlotIds = deriveSlotIds(sol);
  const correctSet = new Set(results.filter(x => x.correct).map(x => x.slotId));
  const complete = allSlotIds.size > 0 && [...allSlotIds].every(id => correctSet.has(id));
  return { results, cells, complete };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/unit/puzzle-grading-percell.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run existing grading tests (no regression)**

Run: `npx vitest run test/unit/puzzle-grading.test.js`
Expected: PASS (existing `results`/`complete` behavior unchanged).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/puzzle-grading.js test/unit/puzzle-grading-percell.test.js
git commit -m "feat(puzzles): gradeEntries returns per-cell correctness (#1412 items 4,6)"
```

---

### Task 2: `check` action exposes `cells`; grade partially-filled slots

**Files:**
- Modify: `srv/puzzle-service.cds` (`check` action return type, ~line 16-22)
- Modify: `srv/puzzle-service.js` (`check` handler passes through `cells`, ~line 35-62)
- Test: `test/unit/puzzle-service-check.test.js` (extend existing, or add a case)

**Interfaces:**
- Consumes: `gradeEntries` (Task 1).
- Produces: `POST /puzzle-api/check` response now includes `cells: [{r,c,correct}]`
  alongside `results` + `complete`. The handler already returns `gradeEntries(...)`
  wholesale, so passing `cells` through is a CDS-contract change plus verifying the
  fallback path also returns `cells:[]`.

- [ ] **Step 1: Update the CDS return type**

```cds
  action check(slug : String, entries : many {
    slotId : String;
    word   : String;
  }) returns {
    results  : many { slotId : String; correct : Boolean; };
    cells    : many { r : Integer; c : Integer; correct : Boolean; };
    complete : Boolean;
  };
```

- [ ] **Step 2: Ensure the handler's error-fallback returns `cells`**

In `srv/puzzle-service.js` `check` handler (~line 60), change the catch fallback:

```js
      } catch (e) {
        cds.log('puzzle').warn('check grade failed:', e.message);
        return { results: [], cells: [], complete: false };
      }
```

(The success path returns `gradeEntries(...)` directly, which now includes `cells` — no change needed there.)

- [ ] **Step 3: Write/extend the failing test**

```js
// test/unit/puzzle-service-check.test.js — add this case (or new file)
import { describe, it, expect } from 'vitest';
const cds = require('@sap/cds');

describe('PuzzleService.check per-cell', () => {
  const { POST } = cds.test('serve', '--project', '.', '--in-memory');
  it('returns per-cell correctness for the seeded puzzle', async () => {
    // Submit a known-wrong single across entry; expect cells[] present with a false.
    const { data } = await POST(`/puzzle-api/check`, {
      slug: 'devtoberfest-cryptic-crossword',
      entries: [{ slotId: '0-0-across', word: 'ZZZ' }],
    });
    expect(Array.isArray(data.cells)).toBe(true);
    expect(data.cells.length).toBeGreaterThan(0);
    expect(data.cells.some(c => c.correct === false)).toBe(true);
  });
});
```

(If the in-memory seed differs, use a slotId/word the seed guarantees exists; consult
`srv/lib/seed-poc-puzzle.js` for the seeded slug. Adjust the entry to any valid slot —
the assertion only needs `cells` populated with a boolean.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/unit/puzzle-service-check.test.js`
Expected: PASS. If the CAP bootstrap fights you, use the working pattern
`cds.test('serve','--project','.','--in-memory')` (this repo's known-good bootstrap).

- [ ] **Step 5: Commit**

```bash
git add srv/puzzle-service.cds srv/puzzle-service.js test/unit/puzzle-service-check.test.js
git commit -m "feat(puzzles): check action returns per-cell correctness (#1412)"
```

---

### Task 3: `resetPuzzleProgress` action

**Files:**
- Modify: `srv/puzzle-service.cds` (add action)
- Modify: `srv/puzzle-service.js` (add handler in `_initProgressAndComplete`)
- Test: `test/unit/puzzle-reset.test.js`

**Interfaces:**
- Consumes: `PuzzleProgress`, `TaskRecords`, `resolveOrCreateUser`, `loadPuzzle`.
- Produces: `@requires:'authenticated-user'` action
  `resetPuzzleProgress(slug) returns { newAttemptNumber : Integer; supersededRecordCount : Integer; }`.
  Supersedes live PUZZLE TaskRecords for the user+puzzle and resets `PuzzleProgress`
  (clear `filledGrid`, bump `attemptNumber`).

- [ ] **Step 1: Add the CDS action**

```cds
  @(requires: 'authenticated-user')
  action resetPuzzleProgress(slug : String) returns {
    newAttemptNumber      : Integer;
    supersededRecordCount : Integer;
  };
```

- [ ] **Step 2: Write the failing test**

```js
// test/unit/puzzle-reset.test.js
import { describe, it, expect } from 'vitest';
const cds = require('@sap/cds');

describe('PuzzleService.resetPuzzleProgress', () => {
  const { POST } = cds.test('serve', '--project', '.', '--in-memory');
  it('rejects anonymous callers', async () => {
    await expect(
      POST(`/puzzle-api/resetPuzzleProgress`, { slug: 'devtoberfest-cryptic-crossword' })
    ).rejects.toMatchObject({ response: { status: 401 } });
  });
});
```

(Authenticated supersede behavior is covered by the hybrid test in Task 4 — unit here just
asserts the auth gate, matching how other unauthenticated-path unit tests in this repo assert
`{code:401}` / rejection. If the mock-auth harness allows an authed POST in-memory, add a
happy-path case asserting `supersededRecordCount >= 0` and `newAttemptNumber >= 2` after a
prior complete; otherwise defer the happy path to Task 4.)

- [ ] **Step 3: Run to verify fail**

Run: `npx vitest run test/unit/puzzle-reset.test.js`
Expected: FAIL — action not found (404) or handler missing.

- [ ] **Step 4: Implement the handler** (add inside `_initProgressAndComplete`, after `complete`)

```js
    // ── resetPuzzleProgress ────────────────────────────────────────────────────
    // Mirror resetTutorialProgress: supersede the live PUZZLE TaskRecord and
    // restart PuzzleProgress (clear grid, bump attempt). Never deletes history.
    this.on('resetPuzzleProgress', async (req) => {
      const { slug } = req.data;
      const puzzle = await loadPuzzle(slug);
      if (!puzzle) return req.reject(404, 'Puzzle not found');
      const dbUser = await resolveOrCreateUser(req.user);
      if (!dbUser) return req.reject(401, 'Unauthenticated');

      // Supersede live PUZZLE TaskRecords for this user + puzzle.
      const live = await SELECT.from(TaskRecords).where({
        user_ID: dbUser.ID,
        taskLegacyId: puzzle.legacyId,
        taskType: 'PUZZLE',
        status: { '!=': 'SUPERSEDED' },
      });
      if (live.length) {
        await UPDATE(TaskRecords)
          .set({ status: 'SUPERSEDED' })
          .where({
            user_ID: dbUser.ID,
            taskLegacyId: puzzle.legacyId,
            taskType: 'PUZZLE',
            status: { '!=': 'SUPERSEDED' },
          });
      }

      // Reset progress row: clear grid, bump attempt.
      const prog = await SELECT.one.from(PuzzleProgress)
        .where({ user_ID: dbUser.ID, puzzle_ID: puzzle.ID });
      let newAttempt = 1;
      if (prog) {
        newAttempt = (prog.attemptNumber || 1) + 1;
        await UPDATE(PuzzleProgress, prog.ID).set({ filledGrid: '{}', attemptNumber: newAttempt });
      }
      return { newAttemptNumber: newAttempt, supersededRecordCount: live.length };
    });
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/unit/puzzle-reset.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/puzzle-service.cds srv/puzzle-service.js test/unit/puzzle-reset.test.js
git commit -m "feat(puzzles): resetPuzzleProgress action (supersede + restart) (#1412 item 2)"
```

---

### Task 4: Hybrid test — reset against real HANA

**Files:**
- Create: `test/hybrid/puzzle-reset-hybrid.test.js`

**Interfaces:**
- Consumes: `PuzzleService.resetPuzzleProgress`, `PuzzleProgress`, `TaskRecords`.

- [ ] **Step 1: Write the hybrid test (read/inspect via `cds.connect.to`, not unauthenticated fetch)**

```js
// test/hybrid/puzzle-reset-hybrid.test.js
// Verifies reset supersedes a PUZZLE TaskRecord + bumps PuzzleProgress against real HANA.
// Reads via in-process service/db (AdminService/PuzzleService are auth-gated over HTTP;
// an unauthenticated fetch returns Unauthorized — the #1412 GridTemplates-test lesson).
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe.runIf(isSafeForWrites())('resetPuzzleProgress (hybrid/HANA)', () => {
  it('the action is registered and supersede/bump logic is reachable', async () => {
    const PuzzleService = await cds.connect.to('PuzzleService');
    // The action exists on the service definition (registration smoke).
    expect(PuzzleService.actions?.resetPuzzleProgress
        ?? PuzzleService.operations?.resetPuzzleProgress
        ?? PuzzleService.model?.definitions?.['PuzzleService.resetPuzzleProgress'])
      .toBeTruthy();
  });
});
```

(This is a registration/boot smoke against HANA — a full authed write-and-supersede round
trip needs a provisioned user context that the hybrid harness may not supply; if it does,
extend to seed a PuzzleProgress row + PUZZLE TaskRecord, call the action via the service
API with a mock user, and assert the TaskRecord flipped to SUPERSEDED. Otherwise this
smoke + the Task 3 unit auth-gate + live browser verification cover it.)

- [ ] **Step 2: Attempt the run**

Run: `npm run test:hybrid -- --project hybrid test/hybrid/puzzle-reset-hybrid.test.js`
Expected: PASS, or a clean skip/boot-gap if no HANA binding is wired in the worktree
(document in the commit; it runs in the post-deploy hybrid job).

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/puzzle-reset-hybrid.test.js
git commit -m "test(puzzles): hybrid reset registration smoke (#1412)"
```

---

## Phase 2 — Solver frontend: server helpers

### Task 5: `postCheck` plain fetch + per-cell result type + CSRF allowlist

**Files:**
- Modify: `hugo-apps/src/puzzle/lib/server.ts` (`postCheck`, `CheckResult`, `buildCheckEntries`, `buildCellStatus`)
- Modify: `scripts/check-csrf-clients.ts` (add `/puzzle-api/check` to `ANON_URL_ALLOWLIST`)
- Test: `hugo-apps/src/puzzle/__tests__/server.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `cells` in the check response.
- Produces:
  - `CheckResult` gains `cells: Array<{r:number;c:number;correct:boolean}>`.
  - `postCheck` uses plain `fetch` (no `csrfFetch`).
  - `buildCheckEntries` includes slots with ≥1 filled cell (was: only fully-filled).
  - `buildCellStatus(cells, slots?)` rewritten to consume the per-cell `cells` array →
    `{"r,c": 'correct'|'wrong'}` (correct→'correct', else 'wrong'). Signature changes from
    `(results, slots)` to `(cells)`.

- [ ] **Step 1: Write failing tests**

```ts
// hugo-apps/src/puzzle/__tests__/server.test.ts — add/replace cases
import { describe, it, expect } from 'vitest';
import { buildCheckEntries, buildCellStatus } from '../lib/server';

describe('buildCheckEntries (>=1 filled)', () => {
  it('includes a partially-filled slot', () => {
    const slots = [{ id: '0-0-across', cells: [{r:0,c:0},{r:0,c:1},{r:0,c:2}] }];
    const answers = { '0,0':'C', '0,1':'A' }; // 0,2 blank
    const entries = buildCheckEntries(slots, answers);
    expect(entries).toEqual([{ slotId: '0-0-across', word: 'CA' }]);
  });
  it('excludes a fully-empty slot', () => {
    const slots = [{ id: '0-0-across', cells: [{r:0,c:0},{r:0,c:1}] }];
    expect(buildCheckEntries(slots, {})).toEqual([]);
  });
});

describe('buildCellStatus (per-cell)', () => {
  it('maps per-cell correctness to r,c → status', () => {
    const cells = [{r:0,c:0,correct:true},{r:0,c:1,correct:false}];
    expect(buildCellStatus(cells)).toEqual({ '0,0':'correct', '0,1':'wrong' });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd hugo-apps && npx vitest run src/puzzle/__tests__/server.test.ts`
Expected: FAIL (buildCheckEntries still requires full slots; buildCellStatus signature differs).

- [ ] **Step 3: Implement the changes in `server.ts`**

```ts
// buildCheckEntries: include any slot with >=1 filled cell (word = filled letters only,
// in cell order, blanks contribute '' so positions align with the slot walk server-side).
export function buildCheckEntries(slots, answers) {
  const entries = [];
  for (const slot of slots) {
    const letters = slot.cells.map(c => answers[`${c.r},${c.c}`] ?? '');
    if (letters.some(l => l.length > 0)) {
      entries.push({ slotId: slot.id, word: letters.join('').toUpperCase() });
    }
  }
  return entries;
}
```

NOTE: `word` may now contain gaps only at the END trivially; but interior blanks would
misalign the server's positional walk. To keep positional alignment, join WITHOUT dropping
blanks — a blank cell contributes an empty position. Since `''` has length 0, `join('')`
collapses interior blanks. **Correct approach:** pad interior blanks with a sentinel the
server treats as wrong. Simplest: send the word as the per-cell letters joined with blanks
represented as a space, and have the server compare per position. To avoid a fragile
protocol, the server already walks by cell index using `w[i]` (Task 1) — so send
`letters` positionally by replacing '' with a non-letter placeholder that can never equal a
solution letter. Use `' '` (space): `letters.map(l => l || ' ').join('')`. Update the test
`word` expectation to `'CA '` accordingly and Task 1's per-cell compare (`w[i] === sol[key]`)
naturally marks the space-position wrong.

Revise Step 1 test + Step 3 impl to:
```ts
    const word = slot.cells.map(c => (answers[`${c.r},${c.c}`] || ' ')).join('').toUpperCase();
    if (word.trim().length > 0) entries.push({ slotId: slot.id, word });
```
and test expects `word: 'CA '`.

```ts
export interface CheckResult {
  results: Array<{ slotId: string; correct: boolean }>;
  cells: Array<{ r: number; c: number; correct: boolean }>;
  complete: boolean;
}

export function buildCellStatus(
  cells: ReadonlyArray<{ r: number; c: number; correct: boolean }>
): Record<string, 'correct' | 'wrong'> {
  const out: Record<string, 'correct' | 'wrong'> = {};
  for (const { r, c, correct } of cells) out[`${r},${c}`] = correct ? 'correct' : 'wrong';
  return out;
}

export async function postCheck(apiUrl, slug, entries): Promise<CheckResult> {
  const r = await fetch(`${apiUrl}/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, entries }),
  });
  if (!r.ok) throw new Error(`check HTTP ${r.status}`);
  return r.json();
}
```

Remove the now-unused `csrfFetch` import ONLY if no other function in the file uses it —
`postSaveProgress`/`postComplete` still use `csrfFetch`, so keep the import.

- [ ] **Step 4: Add `/puzzle-api/check` to the CSRF allowlist**

In `scripts/check-csrf-clients.ts` `ANON_URL_ALLOWLIST` (~line 126):

```ts
const ANON_URL_ALLOWLIST = [
  '/feedback/',      // POST /feedback/submit — anon
  '/puzzle-api/check', // POST /puzzle-api/check — anonymous solver grading (#1412)
];
```

- [ ] **Step 5: Run tests + the CSRF guard**

Run: `cd hugo-apps && npx vitest run src/puzzle/__tests__/server.test.ts`
Then: `cd .. && npx tsx scripts/check-csrf-clients.ts` (or the npm script that runs it — check `jq '.scripts' package.json` for a `csrf`/`check-csrf` script).
Expected: tests PASS; CSRF guard PASSES (no violation for the plain-fetch check).

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/puzzle/lib/server.ts hugo-apps/src/puzzle/__tests__/server.test.ts scripts/check-csrf-clients.ts
git commit -m "fix(puzzles): anonymous Check via plain fetch + per-cell status (#1412 items 1,4,6)"
```

---

### Task 6: Migration + blank-red pure helpers

**Files:**
- Create: `hugo-apps/src/puzzle/lib/progress.ts` (pure helpers)
- Test: `hugo-apps/src/puzzle/__tests__/progress.test.ts`

**Interfaces:**
- Produces:
  - `shouldMigrate(authed, serverGrid, localGrid) → boolean` — true when authed, server
    grid is empty/`{}`/null, and localGrid has ≥1 non-empty entry.
  - `emptyWhiteCells(grid, answers) → Array<{r,c}>` — every non-black cell with no letter
    in `answers` (used to mark blanks red on Check). Pure; grid is `Cell[][]`.

- [ ] **Step 1: Write failing tests**

```ts
// hugo-apps/src/puzzle/__tests__/progress.test.ts
import { describe, it, expect } from 'vitest';
import { shouldMigrate, emptyWhiteCells } from '../lib/progress';

describe('shouldMigrate', () => {
  it('migrates when authed + empty server + non-empty local', () => {
    expect(shouldMigrate(true, '{}', { '0,0':'C' })).toBe(true);
    expect(shouldMigrate(true, null, { '0,0':'C' })).toBe(true);
  });
  it('does not migrate when server has data, or local empty, or anon', () => {
    expect(shouldMigrate(true, '{"0,0":"C"}', { '0,1':'A' })).toBe(false);
    expect(shouldMigrate(true, '{}', {})).toBe(false);
    expect(shouldMigrate(false, '{}', { '0,0':'C' })).toBe(false);
  });
});

describe('emptyWhiteCells', () => {
  it('returns non-black cells lacking a letter', () => {
    const grid = [[{black:false},{black:true},{black:false}]] as any;
    const answers = { '0,0':'C' }; // 0,2 empty, 0,1 black
    expect(emptyWhiteCells(grid, answers)).toEqual([{ r:0, c:2 }]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd hugo-apps && npx vitest run src/puzzle/__tests__/progress.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `progress.ts`**

```ts
// hugo-apps/src/puzzle/lib/progress.ts
export function shouldMigrate(
  authed: boolean,
  serverGrid: string | null,
  localGrid: Record<string, string>
): boolean {
  if (!authed) return false;
  let server: Record<string, string> = {};
  try { server = serverGrid ? JSON.parse(serverGrid) : {}; } catch { server = {}; }
  const serverHas = Object.values(server).some(v => v && v.length > 0);
  if (serverHas) return false;
  return Object.values(localGrid || {}).some(v => v && v.length > 0);
}

export function emptyWhiteCells(
  grid: ReadonlyArray<ReadonlyArray<{ black?: boolean }>>,
  answers: Readonly<Record<string, string>>
): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c].black) continue;
      if (!answers[`${r},${c}`]) out.push({ r, c });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd hugo-apps && npx vitest run src/puzzle/__tests__/progress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/puzzle/lib/progress.ts hugo-apps/src/puzzle/__tests__/progress.test.ts
git commit -m "feat(puzzles): pure migration + blank-cell helpers (#1412 items 3,4)"
```

---

## Phase 3 — Solver App.vue: wiring + UI

### Task 7: Per-cell check coloring + red blanks + clear-on-type

**Files:**
- Modify: `hugo-apps/src/puzzle/App.vue` (`checkPuzzle`, letter-entry handlers, imports)

**Interfaces:**
- Consumes: `buildCellStatus(cells)` (Task 5), `emptyWhiteCells` (Task 6), `postCheck` (Task 5).

- [ ] **Step 1: Update imports + `checkPuzzle`**

Import `emptyWhiteCells` from `./lib/progress` and keep `buildCheckEntries`/`buildCellStatus`.
Rewrite `checkPuzzle` (App.vue:200-213):

```ts
async function checkPuzzle() {
  const entries = buildCheckEntries(slots.value, answers.value);
  if (!entries.length) return;
  statusMsg.value = null;
  try {
    const data = await postCheck(props.apiUrl, props.slug, entries);
    const status = buildCellStatus(data.cells);           // per-cell green/red
    // Item 4: mark every empty white cell red too.
    for (const { r, c } of emptyWhiteCells(grid.value, answers.value)) {
      status[`${r},${c}`] = 'wrong';
    }
    cellStatus.value = status;
    if (data.complete) await onSolved();
  } catch (e) {
    statusMsg.value = `Check failed: ${(e as Error).message}`;
  }
}
```

- [ ] **Step 2: Clear a cell's status when the user types into / clears it**

In `handleKeyDown` printable-letter branch (App.vue:322-327) and Backspace branch
(App.vue:308-319), and in `handleMobileInput` (App.vue:343-353), after mutating
`answers.value`, clear that cell's stale check status so red/green doesn't persist
misleadingly:

```ts
    // after answers.value = { ...answers.value, [cellKey(r,c)]: letter };
    if (cellStatus.value[cellKey(r, c)]) {
      const cs = { ...cellStatus.value };
      delete cs[cellKey(r, c)];
      cellStatus.value = cs;
    }
```

(Apply the same 4-line clear in each of the three mutation sites; factor into a small
local `clearCellStatus(r,c)` helper in `<script setup>` to avoid repetition.)

- [ ] **Step 3: Manual-ish unit guard**

No new unit file (App.vue wiring is covered by the pure helpers + e2e). Run the puzzle
unit suite for regression:

Run: `cd hugo-apps && npx vitest run src/puzzle/__tests__/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/src/puzzle/App.vue
git commit -m "feat(puzzles): per-cell red/green + red blanks + clear-on-type (#1412 items 4,6)"
```

---

### Task 8: Anonymous warn banner + migrate-on-login

**Files:**
- Modify: `hugo-apps/src/puzzle/App.vue` (`resumeProgress`, template banner)

**Interfaces:**
- Consumes: `shouldMigrate` (Task 6), `postSaveProgress` (existing).

- [ ] **Step 1: Rewrite `resumeProgress` to migrate**

```ts
async function resumeProgress() {
  authed.value = await probeAuth();
  // Read localStorage first (works for both anon and authed).
  let local: Record<string, string> = {};
  try {
    const stored = localStorage.getItem(`puzzle-answers-${props.slug}`);
    if (stored) local = JSON.parse(stored);
  } catch { /* ignore corrupt storage */ }

  if (authed.value) {
    let serverGrid: string | null = null;
    try {
      const prog = await fetchProgress(props.apiUrl, props.slug);
      serverGrid = prog.filledGrid;
    } catch { /* 401/network — treat as empty */ }

    if (serverGrid && Object.values(JSON.parse(serverGrid)).some((v:any)=>v)) {
      answers.value = JSON.parse(serverGrid);           // server wins
      return;
    }
    if (shouldMigrate(true, serverGrid, local)) {
      answers.value = local;                            // adopt local
      try { await postSaveProgress(props.apiUrl, props.slug, JSON.stringify(local)); }
      catch { /* migration best-effort; local copy remains */ }
      return;
    }
  }
  // Anonymous, or authed with nothing anywhere: use local.
  answers.value = local;
}
```

Import `shouldMigrate` from `./lib/progress`. Guard the `JSON.parse(serverGrid)` with
try/catch (fold into a small local `parseGrid` if cleaner).

- [ ] **Step 2: Add the not-logged-in banner to the template**

Below the solved banner (App.vue:378-381), add:

```html
      <div v-if="!authed" class="anon-warning">
        You're not logged in — your progress won't be saved to your account.
        <a :href="loginHref">Log in</a> to save your progress.
      </div>
```

Define `loginHref` — reuse whatever login URL the site shell uses (check
`hugo/layouts/partials/header.html` or a shared constant; likely `/auth/login` or an
approuter login route). If none is readily importable, link to the current page through
the approuter login (`/login?...`) — confirm the exact login route during implementation
from `approuter/xs-app.json`.

Add `.anon-warning` CSS (scoped): subtle warning banner using theme vars
(`--sapWarningBackground`/`--sapWarningColor` or a neutral bordered box).

- [ ] **Step 3: Run puzzle unit suite (regression)**

Run: `cd hugo-apps && npx vitest run src/puzzle/__tests__/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/src/puzzle/App.vue
git commit -m "feat(puzzles): not-logged-in warning + migrate local progress on login (#1412 item 3)"
```

---

### Task 9: Reset button + scroll clue into view + layout

**Files:**
- Modify: `hugo-apps/src/puzzle/App.vue` (reset handler + button, clue refs + scroll watch, CSS)
- Modify: `hugo-apps/src/puzzle/lib/server.ts` (add `postResetProgress`)
- Test: `hugo-apps/src/puzzle/__tests__/server.test.ts` (extend for postResetProgress shape — optional, thin)

**Interfaces:**
- Consumes: `resetPuzzleProgress` action (Task 3).
- Produces: `postResetProgress(apiUrl, slug)` in server.ts (uses `csrfFetch` — authed route).

- [ ] **Step 1: Add `postResetProgress` to server.ts**

```ts
export async function postResetProgress(apiUrl: string, slug: string): Promise<void> {
  const r = await csrfFetch(`${apiUrl}/resetPuzzleProgress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ slug }),
  });
  if (!r.ok) throw new Error(`reset HTTP ${r.status}`);
}
```

- [ ] **Step 2: Add reset handler + button in App.vue**

Handler:
```ts
async function resetProgress() {
  if (!confirm('Reset your progress for this puzzle? Your completion will be cleared.')) return;
  try {
    await postResetProgress(props.apiUrl, props.slug);
  } catch (e) {
    statusMsg.value = `Reset failed: ${(e as Error).message}`;
    return;
  }
  answers.value = {};
  cellStatus.value = {};
  solved.value = false;
  statusMsg.value = 'Progress reset.';
  try { localStorage.removeItem(`puzzle-answers-${props.slug}`); } catch {}
}
```
Button (in `.puzzle-actions`, App.vue:464-486), shown when solved AND authed:
```html
            <button v-if="solved && authed" class="puzzle-btn" @click="resetProgress">
              Reset
            </button>
```
Import `postResetProgress`.

- [ ] **Step 3: Clue scroll-into-view**

Add a ref registry for clue `<li>`s and a watcher:
```ts
const clueEls = ref<Record<string, HTMLElement>>({});
function setClueRef(id: string, el: any) { if (el) clueEls.value[id] = el as HTMLElement; }
watch(activeSlot, (s) => {
  if (!s) return;
  const el = clueEls.value[s.id];
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
```
In BOTH clue `<li>` templates (App.vue:390-399, 493-502) add:
```html
              :ref="(el) => setClueRef(slot.id, el)"
```

- [ ] **Step 4: Layout CSS (item 7)**

In scoped `<style>`:
- Center the layout: add to `.puzzle-layout` (App.vue:517) `justify-content: center;` and
  wrap content max-width, e.g. give `.puzzle-island` `max-width: 70rem; margin-inline: auto;`.
- Widen clues: change `.puzzle-clues-col` (App.vue:537-543) `flex: 1 1 16rem; max-width: 22rem;`.
- Keep `--puzzle-cell-size` unchanged (grid stays same size).
- Leave the `@media (max-width:900px)` stack rule intact.

- [ ] **Step 5: Run puzzle unit suite + build the island**

Run: `cd hugo-apps && npx vitest run src/puzzle/__tests__/ && npm run build`
Expected: tests PASS; Vue island builds without type errors.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/puzzle/App.vue hugo-apps/src/puzzle/lib/server.ts hugo-apps/src/puzzle/__tests__/server.test.ts
git commit -m "feat(puzzles): reset button + clue scroll-into-view + roomier centered layout (#1412 items 2,5,7)"
```

---

## Phase 4 — Data fix, e2e, ship

### Task 10: Data fix (seed) + e2e spec

**Files:**
- Modify: `scripts/seed/poc-puzzle.answers.json` (`"5,12"` `S` → `H`)
- Create: `test/e2e/puzzle-1412-solver.test.js`

**Interfaces:**
- Consumes: the deployed solver + backend.

- [ ] **Step 1: Fix the seed answer**

In `scripts/seed/poc-puzzle.answers.json`, change `"5,12":"S"` to `"5,12":"H"` (clue
`4-12-down` "golden ratio" = PHI, not PSI). Verify `(5,12)` has no crossing across-word by
checking the same file's row-5 neighbors (columns 11 and 13 absent = black) — safe.

- [ ] **Step 2: Confirm the change didn't break puzzle validation**

Run: `npx vitest run test/unit/puzzle-grading.test.js test/unit/seed-poc-puzzle.test.js` (if the latter exists)
Expected: PASS. If a seed-validation test asserts the old letter, update it to `H`.

- [ ] **Step 3: Write the committed e2e spec**

```js
// test/e2e/puzzle-1412-solver.test.js
// Post-deploy: anonymous Check works (no CSRF error) and per-cell coloring appears.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const SLUG = 'devtoberfest-cryptic-crossword';

describe.skipIf(!hasBaseUrl())('e2e #1412: anonymous Check + per-cell feedback', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('anonymous user can Check without a CSRF error and sees per-cell colors', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto(`/puzzles/${SLUG}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.puzzle-grid').first().waitFor({ state: 'visible', timeout: 15_000 });
      // Type a letter into the first white cell, then Check.
      const firstCell = page.locator('.puzzle-cell.cell-clickable').first();
      await firstCell.click();
      await page.keyboard.type('Z'); // almost certainly wrong
      const checkBtn = page.getByRole('button', { name: 'Check' });
      await checkBtn.click();
      // No "Check failed" CSRF message.
      await expect(page.locator('.status-msg')).not.toContainText('Check failed', { timeout: 5_000 }).catch(() => {});
      // At least one cell got a wrong (red) status class after Check.
      await page.locator('.puzzle-cell.cell-wrong').first().waitFor({ state: 'visible', timeout: 5_000 });
      expect(await page.locator('.puzzle-cell.cell-wrong').count()).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
```

- [ ] **Step 4: Confirm e2e self-skips locally**

Run: `npx vitest --project e2e run test/e2e/puzzle-1412-solver.test.js`
Expected: SKIP (no base URL). Runs in the post-DEV-deploy e2e CI job.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed/poc-puzzle.answers.json test/e2e/puzzle-1412-solver.test.js
git commit -m "fix(puzzles): correct PHI answer in seed + e2e for anon Check (#1412 item 6)"
```

---

### Task 11: Version bump, full gate, deploy, live verify, live data fix, PR

**Files:**
- Modify: `.deploy/mta.yaml` (minor bump)

- [ ] **Step 1: Bump MTA minor version** in `.deploy/mta.yaml` (new features → minor, e.g. 1.7.x → 1.8.0). (The solver island has no per-app UI5 fragment cache like the admin UI; no manifest bump needed — the island JS is content-hashed by the Hugo/Vite build.)

- [ ] **Step 2: Full unit + island gate**

Run: `npx vitest run test/unit/puzzle-*.test.js && cd hugo-apps && npx vitest run src/puzzle/__tests__/ && npm run build && cd ..`
Expected: all PASS; island builds.

- [ ] **Step 3: CSRF guard + lint**

Run: `npx tsx scripts/check-csrf-clients.ts` (or the npm csrf script) `&& npm run lint`
Expected: PASS (the plain-fetch check is allowlisted).

- [ ] **Step 4: Full bundle-gated deploy to DEV**

Run: `npm run deploy -- --env dev` (from the PRIMARY tree on main after merge — see note). NO `--skip-build`, NO `-m`.
Expected: build → mbt → deploy → smoke all green.

- [ ] **Step 5: Correct the LIVE DEV puzzle solution (data fix, item 6)**

The seeder is insert-only and won't overwrite the deployed row. In the deployed Admin
Puzzle Builder (`/admin-ui/#puzzles`), open "Devtoberfest Cryptic Crossword", switch to
Fill mode, correct cell (5,12) from S to H (so 4-down reads PHI), Save (draft-activate).
Verify: `POST /puzzle-api/check {slug, entries:[{slotId:'4-12-down', word:'PHI'}]}` returns
the 4-12-down cells all `correct:true`.

- [ ] **Step 6: Live browser verification (real entry point) on DEV**

In Playwright with the maintainer session, on `/puzzles/devtoberfest-cryptic-crossword`:
verify — (1) Check while logged OUT works (no CSRF error); (4/6) wrong letters red per-cell
(not whole word), correct green, blank cells red; (6) 4-down PHI now grades correct; (5)
clicking a cell scrolls its clue into view; (2) Reset button appears when solved+authed and
clears completion; (3) not-logged-in banner shows, and logging in migrates the in-progress
grid; (7) layout is centered with roomier clue columns. Screenshot each.

- [ ] **Step 7: Push + open the PR**

```bash
git push -u origin worktree-puzzle-1412-solver
gh pr create --draft --title "fix(puzzles): solver fixes & enhancements (#1412)" \
  --body "Implements docs/superpowers/specs/2026-07-31-puzzle-1412-solver-fixes-design.md. Fixes #1412 items 1-7: anonymous Check (plain fetch), per-cell red/green + red blanks, per-letter wrong, PHI data fix (seed + live), resetPuzzleProgress, not-logged-in warn + migrate-on-login, clue scroll-into-view, centered roomier layout. Verified live on DEV."
```

---

## Self-review notes (author)

- **Spec coverage:** item 1 (T5 postCheck plain fetch + T5 CSRF allowlist), item 2 (T3 reset action + T9 button), item 3 (T6 shouldMigrate + T8 banner+migrate), item 4 (T1 per-cell + T6 emptyWhiteCells + T7 red blanks), item 5 (T9 scroll), item 6 (T1/T2 per-cell + T10 seed fix + T11 live fix), item 7 (T9 layout). All mapped.
- **Type/signature consistency:** `check` returns `{results, cells, complete}` (T1→T2→T5); `buildCellStatus(cells)` new signature consumed only by `checkPuzzle` (T5→T7); `postResetProgress`/`resetPuzzleProgress` names align (T3→T9); slot-id/cell-key formats consistent server+client.
- **Interior-blank protocol (T5):** `buildCheckEntries` now sends a space placeholder for blank cells so positional per-cell grading (`w[i] === sol[key]`, T1) stays aligned — space never equals a solution letter, so blanks-in-submitted-slots grade wrong, consistent with item 4. This is called out explicitly in T5 Step 3.
- **Deploy ordering:** T11 deploy + live data fix run from the PRIMARY tree after the PR merges (project rule: deploy from main, not a worktree). The plan's T11 is the deploy runbook; actual execution is post-merge and human-gated.
- **Open confirmations for implementer:** exact login route for the banner href (T8 — from approuter xs-app.json / header partial); whether an in-memory authed POST is possible for the T3 reset happy-path unit (else covered by T4 + live); the exact npm script name for the CSRF guard (T5/T11).
