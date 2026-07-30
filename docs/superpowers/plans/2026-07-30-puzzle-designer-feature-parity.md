# Puzzle Designer Feature-Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the admin-UI puzzle designer (`app/admin/puzzles/`) to full feature parity with the original cryptic-crossword POC — word list, upload, import/export, print, clear controls, grid templates, auto-fill, live suggestions, and help — while keeping our per-slot hint types, OData draft/publish flow, and HANA persistence.

**Architecture:** Extend the existing freestyle-SAPUI5 builder in place (single `sap.m.Page`, `JSONModel` "b", hand-rendered HTML grid). All fill paths (hand-type, suggestion, auto-fill) write the existing `b>/answers` map so `onSave`/publish stay untouched. A pure backtracking-MRV solver runs in a same-origin classic Web Worker (chunked main-thread fallback if CSP blocks it). Grid templates persist in a new HANA-backed `GridTemplates` entity on `AdminService`.

**Tech Stack:** SAPUI5 1.136 (freestyle, `sap.ui.define` AMD modules), CAP Node.js + SAP HANA (OData V4, draft-enabled entities), Vitest (unit + hybrid), Playwright (e2e). Web Worker + `FileReader` browser APIs.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-07-30-puzzle-designer-feature-parity-design.md` (authoritative).
- **Never `import()` ESM in the browser** — approuter CSP forbids `'unsafe-eval'`; `import(toUrl(...))` is blocked. Load helpers as `sap.ui.define` AMD via dependency arrays; load the worker as a same-origin **classic** `new Worker(url)`, and have the worker pull shared logic via `importScripts` (allowed under `script-src 'self'`).
- **Single-source the solver (no duplication).** `solver-core.js` is authored as a **UMD module**: when `sap.ui.define` exists (controller + vm unit tests) it self-registers as an anonymous AMD module; when loaded via `importScripts` inside the worker (`sap` undefined) it assigns `self.SolverCore`. The worker contains NO copy of the solve body — it `importScripts` the same file and calls `self.SolverCore.solve`. One source of truth, unit-tested once.
- **All new frontend files live under `app/admin/puzzles/webapp/`** — `copy-components.js` recursively copies each admin child app's whole `webapp/` into `dist/components/<name>/`, which ships to `static/admin-ui/components/puzzles/`. No separate `.deploy/mta.yaml` static entry is needed for assets kept under `webapp/`.
- **Unification invariant:** every letter-producing path writes `b>/answers` keyed `"r,c"` → then calls `_recomputeSlots()` + `_renderGrid()`. `onSave` serialization is NOT modified.
- **`Puzzles` layout/solution model unchanged.** Only new backend artifact is `GridTemplates`.
- **Solver determinism:** fixed exploration order, no `Math.random`/`Date.now` inside solving (so unit tests are reproducible).
- **Schema change discipline:** after editing `db/schema.cds`, run `npx cds deploy --to sqlite::memory:` before committing (`@assert.unique.*` are runtime-only); regenerate `db/last-dev/` + `.hdbmigrationtable` via the targeted `cds build --for hana` path — never hand-author the ALTER.
- **Admin-UI deploys are bundle-gated:** full `npm run deploy -- --env dev` (NO `--skip-build`, NO `-m`); Step 3.5 bundle diff must pass. Bump `manifest.json` `sap.app.applicationVersion` to bust the UI5 fragment IndexedDB cache.
- **Windows/CRLF:** author new files LF; JS regex `$` excludes CR — normalize at boundaries if parsing uploaded text.
- **Worktree:** work in the `puzzle-designer-parity` worktree already created; verify branch same-invocation before each commit.

---

## Phase 1 — Solver core (pure, testable, no UI)

### Task 1: Pure backtracking-MRV solver module

**Files:**
- Create: `app/admin/puzzles/webapp/lib/solver-core.js`
- Test: `test/unit/puzzle-solver-core.test.js`

**Interfaces:**
- Consumes: geometry via injected dependency (pure functions passed in, so the module is testable without UI5 AMD). The solver takes `slots` + `crossings` already computed by the caller.
- Produces:
  - `solve(opts) → { status, grid, placed }` where `opts = { slots, words, grid, rows, cols, timeLimitMs, onProgress }`.
    - `slots`: array of `{ id, dir, len, cells:[{r,c}] }` (from `geom.findSlots`).
    - `words`: array of UPPERCASE strings.
    - `grid`: 2-D array of `{ black, letter, number }` (letters may be pre-filled; solver respects them).
    - `status`: `'solved' | 'partial' | 'timeout' | 'nosolution'`.
    - `grid`: new grid with letters placed (never mutates input).
    - `placed`: map `"r,c" → LETTER` for the letters the solver added.
    - `onProgress(partialGrid)`: optional callback invoked as cells fill (throttled by caller/worker, not here).
  - `nowFn` injectable via `opts.nowFn` (defaults to a monotonic counter incremented per attempt) so time-limit logic is testable without `Date.now`.

- [ ] **Step 1: Write the failing test — solves a trivial 2-slot grid**

```js
// test/unit/puzzle-solver-core.test.js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

// solver-core is a sap.ui.define AMD module; load it in a vm with a stubbed define.
function loadSolver() {
  const src = readFileSync(
    path.resolve(__dirname, '../../app/admin/puzzles/webapp/lib/solver-core.js'), 'utf8')
  let mod
  // UMD module: prefer the AMD path by providing sap.ui.define; capture the export.
  const sandbox = { sap: { ui: { define: (deps, fn) => { mod = fn() } } }, self: {} }
  vm.runInNewContext(src, sandbox)
  return mod || sandbox.self.SolverCore
}

// A 3x1 across slot + a 3x1 down slot crossing at (0,0).
function makeGrid(rows, cols) {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ black: false, letter: '', number: null })))
}

describe('solver-core', () => {
  it('fills two crossing slots from a word list', () => {
    const solver = loadSolver()
    const grid = makeGrid(3, 3)
    // black out everything except the top row and left column
    grid[1][1].black = true; grid[1][2].black = true
    grid[2][1].black = true; grid[2][2].black = true
    const slots = [
      { id: '0-0-across', dir: 'across', len: 3, cells: [{r:0,c:0},{r:0,c:1},{r:0,c:2}] },
      { id: '0-0-down',   dir: 'down',   len: 3, cells: [{r:0,c:0},{r:1,c:0},{r:2,c:0}] }
    ]
    const res = solver.solve({
      slots, words: ['CAT', 'COW', 'DOG'], grid, rows: 3, cols: 3, timeLimitMs: 5000
    })
    expect(res.status).toBe('solved')
    // Both slots share (0,0); the only consistent pair is CAT across + COW down (both start C)
    expect(res.placed['0,0']).toBe('C')
    expect(res.placed['0,1']).toBe('A')
    expect(res.placed['0,2']).toBe('T')
    expect(res.placed['1,0']).toBe('O')
    expect(res.placed['2,0']).toBe('W')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/puzzle-solver-core.test.js`
Expected: FAIL — `Cannot find module .../solver-core.js` or `solver.solve is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// app/admin/puzzles/webapp/lib/solver-core.js
// Pure backtracking crossword filler with MRV slot ordering.
// No DOM — deterministic and unit-testable. UMD: registers as an anonymous AMD
// module when sap.ui.define exists (Builder controller + vm unit tests), and as
// self.SolverCore when loaded via importScripts inside the classic Web Worker.
// This is the SINGLE source of the solve logic — the worker does NOT copy it.
(function (root, factory) {
  "use strict";
  if (typeof sap !== "undefined" && sap.ui && sap.ui.define) {
    sap.ui.define([], factory);            // AMD (controller + tests)
  } else {
    root.SolverCore = factory();           // worker global (importScripts)
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Read the current letters at a slot's cells from a "r,c"→LETTER map.
  function slotPattern(slot, letters) {
    return slot.cells.map(function (cell) { return letters[cell.r + "," + cell.c] || ""; });
  }

  // True if `word` fits `slot` given already-placed crossing letters.
  function fits(slot, word, letters) {
    if (word.length !== slot.len) { return false; }
    for (var i = 0; i < slot.len; i++) {
      var cell = slot.cells[i];
      var existing = letters[cell.r + "," + cell.c];
      if (existing && existing !== word[i]) { return false; }
    }
    return true;
  }

  function place(slot, word, letters) {
    slot.cells.forEach(function (cell, i) { letters[cell.r + "," + cell.c] = word[i]; });
  }

  // Remove only the letters this placement added (those not in `before`).
  function unplace(slot, letters, before) {
    slot.cells.forEach(function (cell) {
      var key = cell.r + "," + cell.c;
      if (!(key in before)) { delete letters[key]; }
    });
  }

  function countCandidates(slot, words, letters) {
    var n = 0;
    for (var i = 0; i < words.length; i++) { if (fits(slot, words[i], letters)) { n++; } }
    return n;
  }

  // opts.nowFn: monotonic clock. When omitted, a per-attempt counter is used and
  // timeLimitMs is an attempt budget (deterministic for unit tests). The worker
  // passes { nowFn: () => Date.now(), timeLimitMs: <wall-clock ms> } for real time.
  function solve(opts) {
    var slots = opts.slots;
    var words = (opts.words || []).map(function (w) { return String(w).toUpperCase(); });
    var timeLimitMs = opts.timeLimitMs != null ? opts.timeLimitMs : 12000;
    var onProgress = opts.onProgress;
    var counter = 0;
    var nowFn = opts.nowFn || function () { return (counter += 1); };
    var start = nowFn();
    var deadline = start + timeLimitMs;

    // Seed letters from any pre-filled grid cells.
    var letters = {};
    if (opts.grid) {
      for (var r = 0; r < opts.grid.length; r++) {
        for (var c = 0; c < opts.grid[r].length; c++) {
          var cell = opts.grid[r][c];
          if (cell && !cell.black && cell.letter) { letters[r + "," + c] = cell.letter.toUpperCase(); }
        }
      }
    }

    var used = {};
    var timedOut = false;

    function backtrack() {
      if (nowFn() > deadline) { timedOut = true; return false; }
      // Pick the unfilled slot with the fewest candidates (MRV).
      var target = null, best = Infinity;
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        var pat = slotPattern(s, letters);
        var full = pat.every(function (ch) { return ch; });
        if (full) { continue; }
        var cnt = countCandidates(s, words, letters);
        if (cnt < best) { best = cnt; target = s; if (cnt === 0) { break; } }
      }
      if (!target) { return true; }          // all slots filled → solved
      if (best === 0) { return false; }        // dead end

      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        if (used[word]) { continue; }
        if (!fits(target, word, letters)) { continue; }
        var before = {};
        target.cells.forEach(function (cell) {
          var k = cell.r + "," + cell.c; if (k in letters) { before[k] = letters[k]; }
        });
        place(target, word, letters);
        used[word] = true;
        if (onProgress) { onProgress(Object.assign({}, letters)); }
        if (backtrack()) { return true; }
        unplace(target, letters, before);
        used[word] = false;
        if (timedOut) { return false; }
      }
      return false;
    }

    var ok = backtrack();

    // Rebuild grid with placed letters (never mutate input).
    var outGrid = (opts.grid || []).map(function (row) {
      return row.map(function (cell) { return Object.assign({}, cell); });
    });
    Object.keys(letters).forEach(function (key) {
      var parts = key.split(","); var rr = +parts[0], cc = +parts[1];
      if (outGrid[rr] && outGrid[rr][cc]) { outGrid[rr][cc].letter = letters[key]; }
    });

    var status = ok ? "solved" : (timedOut ? "timeout" : "nosolution");
    return { status: status, grid: outGrid, placed: letters };
  }

  return { solve: solve, fits: fits, slotPattern: slotPattern };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/puzzle-solver-core.test.js`
Expected: PASS.

- [ ] **Step 5: Add tests for timeout, no-solution, and pre-filled respect**

```js
  it('respects pre-filled letters and reports nosolution when impossible', () => {
    const solver = loadSolver()
    const grid = makeGrid(1, 3)
    grid[0][0].letter = 'X' // no word starts with X in the list
    const slots = [{ id:'0-0-across', dir:'across', len:3, cells:[{r:0,c:0},{r:0,c:1},{r:0,c:2}] }]
    const res = solver.solve({ slots, words:['CAT','DOG'], grid, rows:1, cols:3, timeLimitMs:5000 })
    expect(res.status).toBe('nosolution')
    expect(res.grid[0][0].letter).toBe('X') // pre-filled letter preserved
  })

  it('reports timeout when the attempt budget is exhausted', () => {
    const solver = loadSolver()
    const grid = makeGrid(1, 3)
    const slots = [{ id:'0-0-across', dir:'across', len:3, cells:[{r:0,c:0},{r:0,c:1},{r:0,c:2}] }]
    // timeLimitMs=0 with the default counter → first nowFn() call exceeds budget.
    const res = solver.solve({ slots, words:['CAT'], grid, rows:1, cols:3, timeLimitMs:0 })
    expect(res.status).toBe('timeout')
  })
```

- [ ] **Step 6: Run all solver tests**

Run: `npx vitest run test/unit/puzzle-solver-core.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add app/admin/puzzles/webapp/lib/solver-core.js test/unit/puzzle-solver-core.test.js
git commit -m "feat(puzzles): pure backtracking-MRV crossword solver core"
```

---

### Task 2: Word-list parser + import/export serializer (pure)

**Files:**
- Create: `app/admin/puzzles/webapp/lib/puzzle-io.js`
- Test: `test/unit/puzzle-io.test.js`

**Interfaces:**
- Produces (AMD module returning):
  - `parseWordList(text) → string[]` — split on `/[\r\n,;]+/`, uppercase, strip non-A–Z, drop empties. (Include `\r` so Windows uploads parse.)
  - `countWords(text) → number` — `parseWordList(text).length`.
  - `exportPuzzle(state) → object` — `{ formatVersion:1, rows, cols, grid, wordText, clues, hints, wordLengths, answers, title, slug }` where `grid` cells are `{ black, number }` (no letters — letters live in `answers`).
  - `importPuzzle(obj) → { ok, error?, state? }` — validate `rows`,`cols` are ints ≥1 and `grid` is a `rows×cols` array; on success return a normalized `state` with the same keys `exportPuzzle` produced (missing optional maps default to `{}` / `""`).

- [ ] **Step 1: Write failing tests**

```js
// test/unit/puzzle-io.test.js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

function loadIo() {
  const src = readFileSync(
    path.resolve(__dirname, '../../app/admin/puzzles/webapp/lib/puzzle-io.js'), 'utf8')
  let mod
  vm.runInNewContext(src, { sap: { ui: { define: (d, fn) => { mod = fn() } } } })
  return mod
}

describe('puzzle-io', () => {
  it('parses newline/comma/semicolon separated words, uppercased, A-Z only', () => {
    const io = loadIo()
    expect(io.parseWordList('cat, dog\r\nCOW; fi-sh')).toEqual(['CAT','DOG','COW','FISH'])
    expect(io.countWords('a\nb\nc')).toBe(3)
  })

  it('round-trips export → import', () => {
    const io = loadIo()
    const state = {
      rows: 2, cols: 2,
      grid: [[{black:false,number:1},{black:true,number:null}],
             [{black:false,number:2},{black:false,number:null}]],
      wordText: 'AB\nCD', clues: {'0-0-across':'x'}, hints: {'0-0-across':'anagram'},
      wordLengths: {'0-0-across':2}, answers: {'0,0':'A'}, title: 'T', slug: 't'
    }
    const exported = io.exportPuzzle(state)
    expect(exported.formatVersion).toBe(1)
    const res = io.importPuzzle(JSON.parse(JSON.stringify(exported)))
    expect(res.ok).toBe(true)
    expect(res.state.answers['0,0']).toBe('A')
    expect(res.state.clues['0-0-across']).toBe('x')
  })

  it('rejects malformed import', () => {
    const io = loadIo()
    expect(io.importPuzzle({ rows: 2 }).ok).toBe(false)
    expect(io.importPuzzle({ rows: 2, cols: 2, grid: [[{}]] }).ok).toBe(false) // wrong dims
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/unit/puzzle-io.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```js
// app/admin/puzzles/webapp/lib/puzzle-io.js
sap.ui.define([], function () {
  "use strict";

  function parseWordList(text) {
    return String(text || "")
      .split(/[\r\n,;]+/)
      .map(function (w) { return w.toUpperCase().replace(/[^A-Z]/g, ""); })
      .filter(function (w) { return w.length > 0; });
  }

  function countWords(text) { return parseWordList(text).length; }

  function exportPuzzle(state) {
    var grid = (state.grid || []).map(function (row) {
      return row.map(function (cell) {
        return { black: !!cell.black, number: cell.number || null };
      });
    });
    return {
      formatVersion: 1,
      rows: state.rows, cols: state.cols, grid: grid,
      wordText: state.wordText || "",
      clues: state.clues || {}, hints: state.hints || {},
      wordLengths: state.wordLengths || {}, answers: state.answers || {},
      title: state.title || "", slug: state.slug || ""
    };
  }

  function importPuzzle(obj) {
    if (!obj || typeof obj !== "object") { return { ok: false, error: "Not an object" }; }
    var rows = obj.rows, cols = obj.cols;
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
      return { ok: false, error: "rows/cols must be positive integers" };
    }
    if (!Array.isArray(obj.grid) || obj.grid.length !== rows) {
      return { ok: false, error: "grid must have " + rows + " rows" };
    }
    for (var r = 0; r < rows; r++) {
      if (!Array.isArray(obj.grid[r]) || obj.grid[r].length !== cols) {
        return { ok: false, error: "grid row " + r + " must have " + cols + " cells" };
      }
    }
    return {
      ok: true,
      state: {
        rows: rows, cols: cols,
        grid: obj.grid.map(function (row) {
          return row.map(function (cell) {
            return { black: !!(cell && cell.black), letter: "", number: (cell && cell.number) || null };
          });
        }),
        wordText: obj.wordText || "",
        clues: obj.clues || {}, hints: obj.hints || {},
        wordLengths: obj.wordLengths || {}, answers: obj.answers || {},
        title: obj.title || "", slug: obj.slug || ""
      }
    };
  }

  return { parseWordList: parseWordList, countWords: countWords, exportPuzzle: exportPuzzle, importPuzzle: importPuzzle };
});
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/unit/puzzle-io.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/admin/puzzles/webapp/lib/puzzle-io.js test/unit/puzzle-io.test.js
git commit -m "feat(puzzles): word-list parser + puzzle import/export serializer"
```

---

## Phase 2 — Backend: GridTemplates entity

### Task 3: `GridTemplates` schema + AdminService projection + seed

**Files:**
- Modify: `db/schema.cds` (add entity after `Puzzles`, ~line 136)
- Modify: `srv/admin-service.cds` (add projection near the Puzzles projection, ~line 107)
- Modify: `app/admin-annotations.cds` (draft-enable + labels)
- Create: `db/data/com.sap.developers.ims-GridTemplates.csv` (built-in seed)
- Test: `test/unit/puzzle-grid-templates.test.js` (CAP unit test, in-memory)

**Interfaces:**
- Produces:
  - Entity `com.sap.developers.ims.GridTemplates` with `ID:UUID (key)`, `name:String(255)`, `rows:Integer`, `cols:Integer`, `blacks:LargeString` (JSON `[[r,c],…]`), `isBuiltin:Boolean default false`, plus `managed`.
  - `AdminService.GridTemplates` projection, `@odata.draft.enabled`.
  - Endpoints for the UI: `GET /admin/GridTemplates`, draft create/activate (same flow as Puzzles), `DELETE`.

- [ ] **Step 1: Write the failing CAP test**

```js
// test/unit/puzzle-grid-templates.test.js
const cds = require('@sap/cds')
const { expect } = require('chai')

describe('AdminService.GridTemplates', () => {
  const { GET, POST, DELETE } = cds.test('serve', '--project', '.', '--in-memory')

  it('exposes built-in templates seeded from CSV', async () => {
    const { data } = await GET(`/admin/GridTemplates?$filter=isBuiltin eq true`)
    expect(data.value.length).to.be.greaterThan(0)
    const t = data.value[0]
    expect(t).to.have.property('name')
    expect(t).to.have.property('blacks')
    expect(JSON.parse(t.blacks)).to.be.an('array')
  })

  it('creates and activates a user template via draft flow', async () => {
    const draft = await POST(`/admin/GridTemplates`, {
      name: 'My Grid', rows: 15, cols: 15, blacks: JSON.stringify([[0,0],[14,14]]), isBuiltin: false
    })
    const id = draft.data.ID
    const active = await POST(
      `/admin/GridTemplates(ID=${id},IsActiveEntity=false)/AdminService.draftActivate`, {})
    expect(active.data.IsActiveEntity).to.equal(true)
    await DELETE(`/admin/GridTemplates(ID=${id},IsActiveEntity=true)`)
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/unit/puzzle-grid-templates.test.js --project unit`
Expected: FAIL — entity not in model / 404.

- [ ] **Step 3: Add the entity to `db/schema.cds` (after the `Puzzles` entity, line ~136)**

```cds
// Issue: puzzle-designer parity — reusable grid black-square templates.
// blacks = JSON array of [row,col] black-cell coordinates. Built-ins are seeded
// and read-only in the admin UI; author-saved templates are deletable.
entity GridTemplates : cuid, managed {
  name      : String(255) @mandatory;
  rows      : Integer;
  cols      : Integer;
  blacks    : LargeString;   // JSON [[r,c], ...]
  isBuiltin : Boolean default false;
}
```

- [ ] **Step 4: Add the projection to `srv/admin-service.cds` (after the Puzzles projection, ~line 107)**

```cds
  // Puzzle-designer grid templates (built-in + author-saved).
  entity GridTemplates as projection on ims.GridTemplates;
```

- [ ] **Step 5: Draft-enable + label in `app/admin-annotations.cds` (after the Puzzles block)**

```cds
// Puzzle-designer grid template library.
annotate AdminService.GridTemplates with @odata.draft.enabled;
annotate AdminService.GridTemplates with {
  name      @Common.Label: 'Template Name' @mandatory;
  rows      @Common.Label: 'Rows';
  cols      @Common.Label: 'Cols';
  blacks    @Common.Label: 'Black Cells JSON';
  isBuiltin @Common.Label: 'Built-in';
};
```

- [ ] **Step 6: Seed built-ins — `db/data/com.sap.developers.ims-GridTemplates.csv`**

Port the POC's 10 symmetric 15×15 patterns from `D:/projects/cryptic-puzzle-maker/src/sampleGrids.js`. CSV columns: `ID;name;rows;cols;blacks;isBuiltin`. The `blacks` cell is a JSON array — quote it and escape inner quotes per CSV rules. Example first row (use fixed UUIDs so re-seeds are idempotent):

```csv
ID;name;rows;cols;blacks;isBuiltin
11111111-1111-1111-1111-111111111101;Classic 15x15 A;15;15;"[[0,4],[0,10],[1,4],[1,10],[2,4],[2,10]]";true
```

(Generate the full `blacks` arrays by reading `sampleGrids.js` during implementation; keep all 10 rows.)

- [ ] **Step 7: Validate schema compiles + assert.unique are satisfied**

Run: `npx cds deploy --to sqlite::memory:`
Expected: no compile error; seed loads.

- [ ] **Step 8: Run the CAP test to verify pass**

Run: `npx vitest run test/unit/puzzle-grid-templates.test.js --project unit`
Expected: PASS (2 tests).

- [ ] **Step 9: Regenerate HANA build artifacts + migration table**

Run: `npx cds build --for hana --src db` (regenerates `db/last-dev/` + the `GridTemplates` `.hdbmigrationtable`). Do NOT hand-edit the migration table.
Expected: new `GridTemplates` artifacts appear under `gen/`/`db/last-dev/`.

- [ ] **Step 10: Commit**

```bash
git add db/schema.cds srv/admin-service.cds app/admin-annotations.cds \
        db/data/com.sap.developers.ims-GridTemplates.csv \
        test/unit/puzzle-grid-templates.test.js db/last-dev
git commit -m "feat(puzzles): GridTemplates entity, projection, draft-enable, built-in seed"
```

---

### Task 4: Hybrid test — GridTemplates against real HANA

**Files:**
- Create: `test/hybrid/puzzle-grid-templates-hybrid.test.js`

**Interfaces:**
- Consumes: `AdminService.GridTemplates` from Task 3.

- [ ] **Step 1: Write the hybrid test**

```js
// test/hybrid/puzzle-grid-templates-hybrid.test.js
const cds = require('@sap/cds')
const { expect } = require('chai')

describe('GridTemplates (hybrid/HANA)', () => {
  const { GET } = cds.test(__dirname + '/..')

  it('built-in templates are present and blacks parse as JSON', async () => {
    const { data } = await GET(`/admin/GridTemplates?$filter=isBuiltin eq true&$top=1`)
    expect(data.value.length).to.equal(1)
    expect(() => JSON.parse(data.value[0].blacks)).to.not.throw()
  })
})
```

- [ ] **Step 2: Run against HANA (requires `cf login` + bind)**

Run: `npm run test:hybrid -- --project hybrid test/hybrid/puzzle-grid-templates-hybrid.test.js`
Expected: PASS (or documented skip if no HANA binding available in this environment — note it in the commit).

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/puzzle-grid-templates-hybrid.test.js
git commit -m "test(puzzles): hybrid GridTemplates HANA smoke"
```

---

## Phase 3 — Frontend: word list, clear, import/export, print, help

### Task 5: Word-list panel + live count + upload + clear

**Files:**
- Modify: `app/admin/puzzles/webapp/view/Builder.view.xml` (add word-list panel to edit mode)
- Modify: `app/admin/puzzles/webapp/controller/Builder.controller.js` (add `puzzle-io` dep + handlers + `wordText`/`wordCount` model fields)
- Test: `test/unit/puzzle-builder-wordlist.test.js` (controller-logic unit via vm+stub — mirror `crossword-geometry.test.js`)

**Interfaces:**
- Consumes: `puzzle-io.parseWordList`, `countWords` (Task 2).
- Produces on the controller: `onWordTextChange`, `onUploadWordList(oEvent)`, `onClearWordList`. Model adds `/wordText:""`, `/wordCount:0`.

- [ ] **Step 1: Add model fields in `onInit`** (edit the `JSONModel` literal, add `wordText: "", wordCount: 0` after `answers: {}`).

- [ ] **Step 2: Add `puzzle-io` to the controller dependency array**

```js
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/tutorials/admin/puzzles/lib/crossword-geometry",
  "sap/tutorials/admin/puzzles/lib/puzzle-io"
], function (Controller, JSONModel, MessageToast, MessageBox, geom, io) {
```

- [ ] **Step 3: Write the failing unit test for parse-and-count wiring**

```js
// test/unit/puzzle-builder-wordlist.test.js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

function loadIo() {
  const src = readFileSync(path.resolve(__dirname,
    '../../app/admin/puzzles/webapp/lib/puzzle-io.js'), 'utf8')
  let mod; vm.runInNewContext(src, { sap: { ui: { define: (d, fn) => { mod = fn() } } } })
  return mod
}
describe('wordlist wiring', () => {
  it('countWords matches parseWordList length after upload text', () => {
    const io = loadIo()
    const text = 'SAP\nCAP\nBTP,HANA;ui5'
    expect(io.countWords(text)).toBe(io.parseWordList(text).length)
    expect(io.parseWordList(text)).toContain('UI5')
  })
})
```

- [ ] **Step 4: Run to verify pass** (this validates the pure dep the handlers use)

Run: `npx vitest run test/unit/puzzle-builder-wordlist.test.js`
Expected: PASS.

- [ ] **Step 5: Add handlers to the controller**

```js
    onWordTextChange: function () {
      var b = this.getView().getModel("b");
      b.setProperty("/wordCount", io.countWords(b.getProperty("/wordText")));
    },

    onUploadWordList: function (oEvent) {
      var file = oEvent.getParameter("files") && oEvent.getParameter("files")[0];
      if (!file) { return; }
      if (file.size > 2 * 1024 * 1024) { MessageToast.show("File too large (max 2 MB)"); return; }
      var b = this.getView().getModel("b");
      var self = this;
      var reader = new FileReader();
      reader.onload = function (e) {
        b.setProperty("/wordText", String(e.target.result || ""));
        self.onWordTextChange();
      };
      reader.onerror = function () { MessageToast.show("Could not read file"); };
      reader.readAsText(file);
    },

    onClearWordList: function () {
      var b = this.getView().getModel("b");
      b.setProperty("/wordText", "");
      b.setProperty("/wordCount", 0);
    },
```

- [ ] **Step 6: Add the word-list panel to the view (inside edit-mode VBox, before the grid `FlexBox`)**

```xml
        <!-- Word list panel -->
        <Panel headerText="Word list" class="sapUiSmallMarginBottom" expandable="true" expanded="true">
          <VBox>
            <TextArea id="wordListArea" value="{b>/wordText}" liveChange=".onWordTextChange"
                      rows="6" width="100%" growing="false"
                      placeholder="Paste words here, one per line (or comma/semicolon separated)…"/>
            <FlexBox alignItems="Center" class="sapUiTinyMarginTop">
              <u:FileUploader id="wordUploader" name="wordlist" fileType="txt,csv"
                              buttonText="Upload a file" placeholder="" width="auto"
                              change=".onUploadWordList" style="Transparent"
                              xmlns:u="sap.ui.unified"/>
              <Button text="Clear" press=".onClearWordList" type="Transparent"
                      visible="{= ${b>/wordText}.length > 0 }" class="sapUiTinyMarginBegin"/>
              <Text text="{= ${b>/wordCount} + ' words' }" class="sapUiTinyMarginBegin"/>
            </FlexBox>
          </VBox>
        </Panel>
```

Add `sap.ui.unified` to `manifest.json` `dependencies.libs` (`"sap.ui.unified": {}`).

- [ ] **Step 7: Run full unit suite (no regressions)**

Run: `npx vitest run test/unit/puzzle-io.test.js test/unit/puzzle-builder-wordlist.test.js test/unit/crossword-geometry.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/admin/puzzles/webapp/view/Builder.view.xml \
        app/admin/puzzles/webapp/controller/Builder.controller.js \
        app/admin/puzzles/webapp/manifest.json \
        test/unit/puzzle-builder-wordlist.test.js
git commit -m "feat(puzzles): word-list panel with upload, clear, live count"
```

---

### Task 6: Clear Grid / Clear Words + edit-mode toolbar + Import / Export / Print / Help

**Files:**
- Modify: `app/admin/puzzles/webapp/view/Builder.view.xml` (add `OverflowToolbar` above the grid; hidden file input for import; print CSS class hooks)
- Modify: `app/admin/puzzles/webapp/controller/Builder.controller.js` (handlers)
- Create: `app/admin/puzzles/webapp/css/print.css` + reference from `manifest.json` `sap.ui5.resources.css`
- Test: extend `test/unit/puzzle-io.test.js` with an export-from-model shape assertion (already covered) — no new unit file; behavior verified in e2e (Task 9).

**Interfaces:**
- Consumes: `io.exportPuzzle`, `io.importPuzzle` (Task 2), `geom.makeEmptyGrid`, `geom.numberGrid`.
- Produces: `onClearGrid`, `onClearWords`, `onExport`, `onImportPress`, `onImportFile(oEvent)`, `onPrint`, `onHelp`.

- [ ] **Step 1: Add the toolbar to the view (top of edit-mode VBox, before the word-list Panel)**

```xml
        <OverflowToolbar class="sapUiSmallMarginBottom">
          <Button text="Clear Grid" icon="sap-icon://clear-all" press=".onClearGrid"/>
          <Button text="Clear Words" icon="sap-icon://eraser" press=".onClearWords"/>
          <ToolbarSpacer/>
          <Button text="Import" icon="sap-icon://upload" press=".onImportPress"/>
          <Button text="Export" icon="sap-icon://download" press=".onExport"/>
          <Button text="Print" icon="sap-icon://print" press=".onPrint"/>
          <Button icon="sap-icon://sys-help" tooltip="Help" press=".onHelp"/>
        </OverflowToolbar>
```

- [ ] **Step 2: Add handlers to the controller**

```js
    onClearGrid: function () {
      var b = this.getView().getModel("b");
      var rows = parseInt(b.getProperty("/rows"), 10) || 15;
      var cols = parseInt(b.getProperty("/cols"), 10) || 15;
      b.setProperty("/grid", geom.numberGrid(geom.makeEmptyGrid(rows, cols)));
      b.setProperty("/answers", {});
      this._recomputeSlots();
      this._renderGrid();
    },

    onClearWords: function () {
      var b = this.getView().getModel("b");
      b.setProperty("/answers", {});
      this._recomputeSlots();
      this._renderGrid();
    },

    onExport: function () {
      var b = this.getView().getModel("b");
      var wordLengths = {};
      this._getAllSlots().forEach(function (s) { wordLengths[s.id] = s.len; });
      var obj = io.exportPuzzle({
        rows: b.getProperty("/rows"), cols: b.getProperty("/cols"),
        grid: b.getProperty("/grid"), wordText: b.getProperty("/wordText"),
        clues: b.getProperty("/clues"), hints: b.getProperty("/hints"),
        wordLengths: wordLengths, answers: b.getProperty("/answers"),
        title: b.getProperty("/title"), slug: b.getProperty("/slug")
      });
      var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = (b.getProperty("/slug") || "puzzle") + ".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    onImportPress: function () {
      var input = this.byId("importFileInput").getDomRef();
      if (input) { input.value = ""; input.click(); }
    },

    onImportFile: function (oEvent) {
      var file = oEvent.target.files && oEvent.target.files[0];
      if (!file) { return; }
      var self = this;
      var reader = new FileReader();
      reader.onload = function (e) {
        var parsed;
        try { parsed = JSON.parse(e.target.result); }
        catch (err) { MessageBox.error("Not valid JSON: " + err.message); return; }
        var res = io.importPuzzle(parsed);
        if (!res.ok) { MessageBox.error("Import failed: " + res.error); return; }
        var b = self.getView().getModel("b");
        var s = res.state;
        b.setProperty("/rows", s.rows); b.setProperty("/cols", s.cols);
        b.setProperty("/grid", geom.numberGrid(s.grid));
        b.setProperty("/wordText", s.wordText);
        b.setProperty("/wordCount", io.countWords(s.wordText));
        b.setProperty("/clues", s.clues); b.setProperty("/hints", s.hints);
        b.setProperty("/answers", s.answers);
        b.setProperty("/title", s.title); b.setProperty("/slug", s.slug);
        self._recomputeSlots(); self._renderGrid();
        MessageToast.show("Puzzle imported");
      };
      reader.readAsText(file);
    },

    onPrint: function () { window.print(); },

    onHelp: function () {
      MessageBox.information(
        "Design mode: click a cell to toggle black (mirrored 180°).\n" +
        "Fill mode: click a cell, then type letters; arrows navigate, Backspace clears.\n" +
        "Word list: paste or upload candidate words. Fill Grid auto-solves from your list; " +
        "Just Fill uses a common-English dictionary.\n" +
        "Suggestions appear beside the focused slot — click one to place it.\n" +
        "Select Grid loads a saved black-square template; Save Grid stores the current one.\n" +
        "Import/Export move puzzles as JSON; Print produces a printable grid + clues.",
        { title: "Puzzle Builder Help" });
    },
```

- [ ] **Step 3: Add the hidden native file input to the view (inside edit-mode VBox)**

```xml
        <core:HTML id="importFileInput"
                   content="&lt;input type='file' accept='.json,application/json' style='display:none'/&gt;"/>
```

Wire its `change` in `onAfterRendering` (native input, not a UI5 control):

```js
    onAfterRendering: function () {
      var self = this;
      var host = this.byId("importFileInput");
      var dom = host && host.getDomRef();
      var input = dom && dom.querySelector("input");
      if (input && !input._wired) {
        input._wired = true;
        input.addEventListener("change", function (e) { self.onImportFile(e); });
      }
    },
```

- [ ] **Step 4: Create print CSS — `app/admin/puzzles/webapp/css/print.css`**

```css
@media print {
  /* Hide the admin shell chrome and builder controls; show only grid + clues. */
  .sapTntToolPage .sapTntSideNavigation,
  .sapMPageHeader,
  #builderPage .sapMOTB,           /* OverflowToolbar */
  #builderPage .sapMPanel,          /* word-list panel */
  #builderPage .sapMSegBtn { display: none !important; }
  #builderPage .sapMPageEnableScrolling { overflow: visible !important; }
}
```

Reference it in `manifest.json`:

```json
    "resources": { "css": [ { "uri": "css/print.css" } ] }
```

- [ ] **Step 5: Run unit suite (regression)**

Run: `npx vitest run test/unit/puzzle-io.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/admin/puzzles/webapp/view/Builder.view.xml \
        app/admin/puzzles/webapp/controller/Builder.controller.js \
        app/admin/puzzles/webapp/css/print.css \
        app/admin/puzzles/webapp/manifest.json
git commit -m "feat(puzzles): clear/import/export/print/help toolbar"
```

---

## Phase 4 — Frontend: auto-fill worker + live suggestions + grid templates

### Task 7: Fill worker + Fill Grid / Just Fill / Stop + bundled dictionary

**Files:**
- Create: `app/admin/puzzles/webapp/lib/fill-worker.js` (classic worker; `importScripts` the single-source `solver-core.js` — NO copy of the solve logic)
- Create: `app/admin/puzzles/webapp/assets/common-english.txt` (bundled dictionary)
- Modify: `controller/Builder.controller.js` (start/stop/apply + CSP fallback)
- Modify: `view/Builder.view.xml` (Fill Grid / Just Fill / Stop buttons + status strip)
- Test: `test/unit/puzzle-fill-controller.test.js` (fallback solver path, pure)

**Interfaces:**
- Consumes: `solver-core.solve` (Task 1) — via AMD dep in the controller, via `importScripts` in the worker (same file, UMD).
- Produces on controller: `onFillGrid`, `onJustFill`, `onStopFill`, internal `_runFill(mode)`, `_applyFillResult(placed)`, `_fallbackSolveMainThread(opts)`.
- Worker message protocol: post `{ type:'start', slots, words, grid, rows, cols, timeLimitMs }`; receive `{ type:'progress', placed }`, `{ type:'result', status, placed }`, `{ type:'error', message }`.

- [ ] **Step 1: Bundle the dictionary**

Copy the POC's downloaded list (`google-10000-english-no-swears.txt`) into `app/admin/puzzles/webapp/assets/common-english.txt`, uppercased, one word per line, A–Z only. If the POC repo has it cached, reuse it; otherwise fetch once at build time and commit the file (it ships via `copy-components.js`).

- [ ] **Step 2: Author the worker (imports the single-source solver — no duplication)**

The worker `importScripts` the SAME `solver-core.js` authored in Task 1. Because that
file is UMD, running it in the worker (where `sap` is undefined) assigns
`self.SolverCore`. The worker adds only wall-clock time + throttled progress — it
contains NO copy of `solve()`.

```js
// app/admin/puzzles/webapp/lib/fill-worker.js
// Classic Web Worker — loaded via new Worker(sap.ui.require.toUrl(...)).
// It importScripts the single-source solver-core.js (UMD → self.SolverCore).
// There is NO copy of the solve logic here; solver-core is the one source, unit-tested.
"use strict";
importScripts("./solver-core.js");   // relative to this worker file; same webapp/lib dir

self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg || msg.type !== "start") { return; }
  try {
    var last = 0;
    var res = self.SolverCore.solve({
      slots: msg.slots, words: msg.words, grid: msg.grid,
      rows: msg.rows, cols: msg.cols,
      timeLimitMs: msg.timeLimitMs,
      nowFn: function () { return Date.now(); },     // real wall-clock budget
      onProgress: function (placed) {
        var now = Date.now();
        if (now - last >= 200) { last = now; self.postMessage({ type: "progress", placed: placed }); }
      }
    });
    self.postMessage({ type: "result", status: res.status, placed: res.placed });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && e.message || e) });
  }
};
```

Note: `importScripts("./solver-core.js")` resolves relative to the worker script URL,
so both files must sit in `webapp/lib/` (they do). Verify at Task 10 that the built
bundle keeps them siblings under `components/puzzles/lib/`.

- [ ] **Step 3: Write the failing fallback test (main-thread solve path used when CSP blocks workers)**

```js
// test/unit/puzzle-fill-controller.test.js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
function loadSolver() {
  const src = readFileSync(path.resolve(__dirname,
    '../../app/admin/puzzles/webapp/lib/solver-core.js'), 'utf8')
  let mod; vm.runInNewContext(src, { sap: { ui: { define: (d, fn) => { mod = fn() } } } })
  return mod
}
describe('fill fallback', () => {
  it('solver-core solves the same shape the worker would', () => {
    const solver = loadSolver()
    const grid = Array.from({length:1},()=>Array.from({length:3},()=>({black:false,letter:'',number:null})))
    const slots=[{id:'0-0-across',dir:'across',len:3,cells:[{r:0,c:0},{r:0,c:1},{r:0,c:2}]}]
    const res = solver.solve({slots, words:['CAP'], grid, rows:1, cols:3, timeLimitMs:5000})
    expect(res.status).toBe('solved')
    expect(res.placed['0,2']).toBe('P')
  })
})
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/unit/puzzle-fill-controller.test.js`
Expected: PASS.

- [ ] **Step 5: Add controller handlers with worker + fallback**

```js
    _runFill: function (mode) {
      var self = this;
      var b = this.getView().getModel("b");
      var slots = this._getAllSlots().map(function (s) {
        return { id: s.id, dir: s.dir, len: s.len,
          cells: (geom.findSlots(b.getProperty("/grid"), 2).find(function (x) { return x.id === s.id; }) || {}).cells };
      });
      var timeLimitMs = mode === "dictionary" ? 30000 : 12000;
      var gridSnapshot = b.getProperty("/grid");

      var proceed = function (words) {
        b.setProperty("/fillRunning", true);
        b.setProperty("/fillStatus", "Solving…");
        var opts = { slots: slots, words: words, grid: gridSnapshot,
          rows: b.getProperty("/rows"), cols: b.getProperty("/cols"), timeLimitMs: timeLimitMs };
        try {
          var url = sap.ui.require.toUrl("sap/tutorials/admin/puzzles/lib/fill-worker.js");
          var worker = new Worker(url);              // classic same-origin worker
          self._fillWorker = worker;
          worker.onmessage = function (ev) {
            var m = ev.data;
            if (m.type === "progress") { self._applyFillResult(m.placed, true); }
            else if (m.type === "result") { self._finishFill(m.status, m.placed); worker.terminate(); }
            else if (m.type === "error") { self._finishFill("error", null); worker.terminate(); }
          };
          worker.onerror = function () {              // CSP or load failure → fallback
            worker.terminate(); self._fillWorker = null; self._fallbackSolveMainThread(opts);
          };
          worker.postMessage(Object.assign({ type: "start" }, opts));
        } catch (e) {
          self._fallbackSolveMainThread(opts);        // Worker ctor blocked → fallback
        }
      };

      if (mode === "dictionary") {
        fetch(sap.ui.require.toUrl("sap/tutorials/admin/puzzles/assets/common-english.txt"))
          .then(function (r) { return r.text(); })
          .then(function (t) { proceed(io.parseWordList(t)); })
          .catch(function () { MessageToast.show("Could not load dictionary"); });
      } else {
        proceed(io.parseWordList(b.getProperty("/wordText")));
      }
    },

    _fallbackSolveMainThread: function (opts) {
      // Worker unavailable/CSP-blocked → solve on the main thread using the same
      // solver-core AMD dep (`solver`). Synchronous; acceptable for the fallback path.
      var res = solver.solve(opts);
      this._finishFill(res.status, res.placed);
    },

    _applyFillResult: function (placed, isProgress) {
      var b = this.getView().getModel("b");
      var answers = Object.assign({}, b.getProperty("/answers"), placed);
      b.setProperty("/answers", answers);
      this._renderGrid();
      if (!isProgress) { this._recomputeSlots(); }
    },

    _finishFill: function (status, placed) {
      var b = this.getView().getModel("b");
      b.setProperty("/fillRunning", false);
      if (status === "solved" || status === "partial") {
        if (placed) { this._applyFillResult(placed, false); }
        b.setProperty("/fillStatus", status === "solved" ? "Solved" : "Partially filled");
      } else if (status === "timeout") { b.setProperty("/fillStatus", "Timed out — no complete fill");
      } else if (status === "nosolution") { b.setProperty("/fillStatus", "No solution from this word list");
      } else { b.setProperty("/fillStatus", "Fill error"); }
      this._fillWorker = null;
    },

    onFillGrid: function () { this._runFill("wordlist"); },
    onJustFill: function () { this._runFill("dictionary"); },
    onStopFill: function () {
      if (this._fillWorker) { this._fillWorker.terminate(); this._fillWorker = null; }
      this.getView().getModel("b").setProperty("/fillRunning", false);
      this.getView().getModel("b").setProperty("/fillStatus", "Stopped");
    },
```

Add `solver-core` to the dependency array as `solver` (alongside `geom`, `io`), and add `/fillRunning:false, /fillStatus:""` to the `onInit` model.

- [ ] **Step 6: Add Fill buttons + status strip to the toolbar/view**

```xml
          <Button text="Fill Grid" icon="sap-icon://SAP-icons-TNT/fill" press=".onFillGrid"
                  enabled="{= !${b>/fillRunning} }"/>
          <Button text="Just Fill" press=".onJustFill" enabled="{= !${b>/fillRunning} }"/>
          <Button text="Stop" press=".onStopFill" visible="{b>/fillRunning}"/>
```

Status strip below the grid:

```xml
        <Text text="{b>/fillStatus}" class="sapUiTinyMarginTop" visible="{= ${b>/fillStatus}.length > 0 }"/>
```

- [ ] **Step 7: Run unit suite**

Run: `npx vitest run test/unit/puzzle-fill-controller.test.js test/unit/puzzle-solver-core.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/admin/puzzles/webapp/lib/fill-worker.js \
        app/admin/puzzles/webapp/assets/common-english.txt \
        app/admin/puzzles/webapp/controller/Builder.controller.js \
        app/admin/puzzles/webapp/view/Builder.view.xml \
        test/unit/puzzle-fill-controller.test.js
git commit -m "feat(puzzles): auto-fill via Web Worker (Fill Grid / Just Fill / Stop) with main-thread fallback"
```

---

### Task 8: Live per-slot suggestions + grid template picker/save

**Files:**
- Modify: `controller/Builder.controller.js` (suggestions compute on focus; template dialog handlers)
- Modify: `view/Builder.view.xml` (suggestions list beside slots; Select Grid / Save Grid buttons)
- Create: `app/admin/puzzles/webapp/view/GridPicker.fragment.xml` (template chooser dialog)
- Test: `test/unit/puzzle-suggestions.test.js` (pure candidate-matching)

**Interfaces:**
- Consumes: `solver.fits` or `io.parseWordList` + `geom` slot cells; `AdminService.GridTemplates` (Task 3).
- Produces: `onFocusCell` extended to compute `/suggestions`; `onPickSuggestion(oEvent)`; `onSelectGrid`, `onApplyTemplate(oEvent)`, `onSaveGrid`, `onDeleteTemplate(oEvent)`. Model adds `/suggestions:[]`.

- [ ] **Step 1: Write failing test for candidate matching**

```js
// test/unit/puzzle-suggestions.test.js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
function load(f){ const src=readFileSync(path.resolve(__dirname,'../../app/admin/puzzles/webapp/lib/'+f),'utf8');
  let m; vm.runInNewContext(src,{sap:{ui:{define:(d,fn)=>{m=fn()}}}}); return m }
describe('suggestions', () => {
  it('matches words to a slot pattern honoring crossing letters', () => {
    const solver = load('solver-core.js')
    const letters = { '0,0':'C' } // first cell fixed to C
    const slot = { id:'0-0-across', dir:'across', len:3, cells:[{r:0,c:0},{r:0,c:1},{r:0,c:2}] }
    const words = ['CAT','DOG','COW']
    const matches = words.filter(w => solver.fits(slot, w, letters))
    expect(matches).toEqual(['CAT','COW'])
  })
})
```

- [ ] **Step 2: Run to verify pass** (validates the pure primitive)

Run: `npx vitest run test/unit/puzzle-suggestions.test.js`
Expected: PASS.

- [ ] **Step 3: Extend `onFocusCell` to compute suggestions**

```js
    onFocusCell: function (r, c) {
      this._activeCell = { r: r, c: c };
      this._computeSuggestions(r, c);
      this._renderGrid();
    },

    _computeSuggestions: function (r, c) {
      var b = this.getView().getModel("b");
      var grid = b.getProperty("/grid");
      var slots = geom.findSlots(grid, 2);
      var answers = b.getProperty("/answers") || {};
      // Prefer the across slot containing (r,c); fall back to down.
      var slot = slots.find(function (s) {
        return s.dir === "across" && s.cells.some(function (x) { return x.r === r && x.c === c; });
      }) || slots.find(function (s) {
        return s.cells.some(function (x) { return x.r === r && x.c === c; });
      });
      if (!slot) { b.setProperty("/suggestions", []); return; }
      var words = io.parseWordList(b.getProperty("/wordText"));
      var matches = words.filter(function (w) { return solver.fits(slot, w, answers); }).slice(0, 30);
      this._suggestSlot = slot;
      b.setProperty("/suggestions", matches.map(function (w) { return { word: w }; }));
    },

    onPickSuggestion: function (oEvent) {
      var word = oEvent.getSource().getBindingContext("b").getProperty("word");
      var b = this.getView().getModel("b");
      var answers = Object.assign({}, b.getProperty("/answers"));
      this._suggestSlot.cells.forEach(function (cell, i) { answers[cell.r + "," + cell.c] = word[i]; });
      b.setProperty("/answers", answers);
      this._recomputeSlots();
      this._renderGrid();
    },
```

Add `/suggestions: []` to `onInit`.

- [ ] **Step 4: Add suggestions list to the view (inside the slots ScrollContainer, top)**

```xml
              <Panel headerText="Suggestions" visible="{= ${b>/suggestions}.length > 0 }"
                     class="sapUiTinyMarginBottom">
                <List items="{ path: 'b>/suggestions', templateShareable: false }">
                  <StandardListItem title="{b>word}" type="Active" press=".onPickSuggestion"/>
                </List>
              </Panel>
```

- [ ] **Step 5: Create the grid-picker fragment — `view/GridPicker.fragment.xml`**

```xml
<core:FragmentDefinition xmlns="sap.m" xmlns:core="sap.ui.core">
  <Dialog id="gridPickerDialog" title="Select Grid" contentWidth="40rem">
    <List items="{ path: 'gt>/templates', templateShareable: false }" noDataText="No templates">
      <StandardListItem title="{gt>name}" description="{= ${gt>rows} + '×' + ${gt>cols} }"
        info="{= ${gt>isBuiltin} ? 'built-in' : 'saved' }" type="Active" press=".onApplyTemplate">
      </StandardListItem>
    </List>
    <beginButton><Button text="Close" press=".onCloseGridPicker"/></beginButton>
  </Dialog>
</core:FragmentDefinition>
```

- [ ] **Step 6: Add template handlers to the controller**

```js
    onSelectGrid: function () {
      var self = this;
      var oModel = this.getView().getModel(); // OData V4 AdminService
      var oList = oModel.bindList("/GridTemplates");
      oList.requestContexts(0, 100).then(function (ctxs) {
        var templates = ctxs.map(function (ctx) { return ctx.getObject(); });
        var gt = new JSONModel({ templates: templates });
        self.getView().setModel(gt, "gt");
        if (!self._gridPicker) {
          self._gridPicker = sap.ui.xmlfragment(
            "sap.tutorials.admin.puzzles.view.GridPicker", self);
          self.getView().addDependent(self._gridPicker);
        }
        self._gridPicker.open();
      });
    },

    onApplyTemplate: function (oEvent) {
      var t = oEvent.getSource().getBindingContext("gt").getObject();
      var b = this.getView().getModel("b");
      var rows = t.rows || b.getProperty("/rows");
      var cols = t.cols || b.getProperty("/cols");
      var grid = geom.makeEmptyGrid(rows, cols);
      (JSON.parse(t.blacks || "[]")).forEach(function (rc) {
        if (grid[rc[0]] && grid[rc[0]][rc[1]]) { grid[rc[0]][rc[1]].black = true; }
      });
      b.setProperty("/rows", rows); b.setProperty("/cols", cols);
      b.setProperty("/grid", geom.numberGrid(grid));
      this._recomputeSlots(); this._renderGrid();
      if (this._gridPicker) { this._gridPicker.close(); }
    },

    onCloseGridPicker: function () { if (this._gridPicker) { this._gridPicker.close(); } },

    onSaveGrid: function () {
      var self = this;
      var b = this.getView().getModel("b");
      var grid = b.getProperty("/grid");
      var blacks = [];
      grid.forEach(function (row, r) { row.forEach(function (cell, c) { if (cell.black) { blacks.push([r, c]); } }); });
      MessageBox.show("Save current grid as a template?", {
        icon: MessageBox.Icon.QUESTION, title: "Save Grid",
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        onClose: function (action) {
          if (action !== MessageBox.Action.OK) { return; }
          var fields = { name: (b.getProperty("/title") || "Grid") + " layout",
            rows: b.getProperty("/rows"), cols: b.getProperty("/cols"),
            blacks: JSON.stringify(blacks), isBuiltin: false };
          self._withCsrf(function (token) {
            var headers = { "Content-Type": "application/json", "Accept": "application/json", "x-csrf-token": token };
            return fetch("/admin/GridTemplates", { method: "POST", credentials: "include", headers: headers, body: JSON.stringify(fields) })
              .then(function (r) { if (!r.ok) { return r.text().then(function (t) { throw new Error("POST " + r.status + ": " + t); }); } return r.json(); })
              .then(function (draft) {
                return fetch("/admin/GridTemplates(ID=" + draft.ID + ",IsActiveEntity=false)/AdminService.draftActivate",
                  { method: "POST", credentials: "include", headers: headers, body: "{}" });
              });
          }).then(function () { MessageToast.show("Grid template saved"); })
            .catch(function (err) { MessageBox.error("Save template failed: " + (err.message || err)); });
        }
      });
    },
```

- [ ] **Step 7: Add Select Grid / Save Grid buttons to the toolbar**

```xml
          <Button text="Select Grid" icon="sap-icon://grid" press=".onSelectGrid"/>
          <Button text="Save Grid" press=".onSaveGrid"/>
```

- [ ] **Step 8: Run unit suite**

Run: `npx vitest run test/unit/puzzle-suggestions.test.js test/unit/puzzle-io.test.js test/unit/puzzle-solver-core.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add app/admin/puzzles/webapp/controller/Builder.controller.js \
        app/admin/puzzles/webapp/view/Builder.view.xml \
        app/admin/puzzles/webapp/view/GridPicker.fragment.xml \
        test/unit/puzzle-suggestions.test.js
git commit -m "feat(puzzles): live per-slot suggestions + HANA-backed grid template picker/save"
```

---

## Phase 5 — Published-manager parity, e2e, deploy, verify

### Task 9: Published-list row actions (Load into Editor / Unpublish) + e2e spec

**Files:**
- Modify: `view/Builder.view.xml` (add Actions column to the list table)
- Modify: `controller/Builder.controller.js` (`onUnpublish`)
- Create: `test/e2e/puzzle-designer.test.js` (Playwright; self-skips without `SMOKE_BASE_URL`)

**Interfaces:**
- Consumes: existing `onPuzzlePress` (= Load into Editor), `AdminService.Puzzles`.
- Produces: `onUnpublish(oEvent)` — sets `status` to a non-active value via draftEdit→PATCH→draftActivate (reuse `onSave`'s pattern), then refreshes the list. (Confirm the project's "unpublish" semantics during implementation — likely `status: 'DRAFT'` or a `published` flag; match `PuzzleService` read filter.)

- [ ] **Step 1: Add an Actions column + buttons to the list table**

```xml
          <columns>
            <Column><Text text="Title"/></Column>
            <Column><Text text="Slug"/></Column>
            <Column><Text text="Status"/></Column>
            <Column><Text text="Actions"/></Column>
          </columns>
          ...
              <cells>
                <Text text="{title}"/>
                <Text text="{slug}"/>
                <ObjectStatus text="{status}" .../>
                <HBox>
                  <Button text="Edit" press=".onPuzzlePress" type="Transparent"/>
                  <Button text="Unpublish" press=".onUnpublish" type="Transparent"
                          visible="{= ${status} === 'ACTIVE' }"/>
                </HBox>
              </cells>
```

- [ ] **Step 2: Add `onUnpublish`** (reuse the draftEdit→PATCH→draftActivate pattern from `onSave`, setting `status` to the project's unpublished value; refresh list on success). Verify the exact target status against `srv/puzzle-service.*` read filter before finalizing.

- [ ] **Step 3: Write the e2e spec (mirrors `test/e2e/puzzle-solve.test.js` bootstrap)**

```js
// test/e2e/puzzle-designer.test.js
const { test, expect } = require('@playwright/test')
const BASE = process.env.SMOKE_BASE_URL || process.env.PLAYWRIGHT_BASE_URL
test.describe('Puzzle designer admin UI', () => {
  test.skip(!BASE, 'no SMOKE_BASE_URL/PLAYWRIGHT_BASE_URL — post-deploy only')
  test('create → word list → fill → export → import → save', async ({ page }) => {
    await page.goto(BASE + '/admin-ui/#puzzles')
    await page.getByRole('button', { name: 'Create New' }).click()
    await page.getByPlaceholder('e.g. SAP BTP Basics').fill('E2E Test Puzzle')
    await page.getByPlaceholder('e.g. btp-basics').fill('e2e-test-puzzle')
    await page.getByPlaceholder(/Paste words here/).fill('SAP\nCAP\nBTP')
    await expect(page.getByText(/3 words/)).toBeVisible()
    await page.getByRole('button', { name: 'Select Grid' }).click()
    // pick first template
    await page.locator('#gridPickerDialog li').first().click()
    await page.getByRole('button', { name: 'Fill Grid' }).click()
    // Export then verify the download begins
    const [ download ] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export' }).click()
    ])
    expect(download.suggestedFilename()).toContain('e2e-test-puzzle')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Puzzle saved/)).toBeVisible()
  })
})
```

- [ ] **Step 4: Run e2e locally only if a base URL is set (else confirm it skips)**

Run: `npx playwright test test/e2e/puzzle-designer.test.js --config test/e2e/e2e.config.js`
Expected: SKIP locally (no base URL); runs in the post-DEV-deploy CI `e2e` job.

- [ ] **Step 5: Commit**

```bash
git add app/admin/puzzles/webapp/view/Builder.view.xml \
        app/admin/puzzles/webapp/controller/Builder.controller.js \
        test/e2e/puzzle-designer.test.js
git commit -m "feat(puzzles): published-list Load/Unpublish actions + e2e spec"
```

---

### Task 10: Bundle-version bump, full unit run, deploy, live verify

**Files:**
- Modify: `app/admin/puzzles/webapp/manifest.json` (`applicationVersion` bump — cache bust)
- Modify: `.deploy/mta.yaml` (MTA version minor bump)

- [ ] **Step 1: Bump `manifest.json` `applicationVersion`** (e.g. `0.0.4` → `0.1.0`) to bust the admin UI5 fragment IndexedDB cache.

- [ ] **Step 2: Bump MTA version (minor) in `.deploy/mta.yaml`.**

- [ ] **Step 3: Full unit + lint gate**

Run: `npx vitest run test/unit/puzzle-*.test.js test/unit/crossword-geometry.test.js && npm run lint`
Expected: PASS.

- [ ] **Step 4: Verify the admin bundle would ship the new files**

Run: `npm --prefix app/admin-shell run build && ls app/admin-shell/dist/components/puzzles/lib app/admin-shell/dist/components/puzzles/assets`
Expected: `solver-core.js`, `puzzle-io.js`, `fill-worker.js`, `common-english.txt` present in the built bundle.

- [ ] **Step 5: Full deploy to DEV (bundle-gated — NO --skip-build / -m)**

Run: `npm run deploy -- --env dev`
Expected: Step 3.5 bundle diff passes; deploy completes.

- [ ] **Step 6: Live verification in a browser (the real entry point)**

Load the deployed admin UI in Playwright with the maintainer's session; for each feature: word-list paste + upload + count, Fill Grid (worker runs, letters appear), Just Fill, a suggestion click, Select Grid + Save Grid, Clear Grid/Words, Export download + Import round-trip, Print preview, Help dialog, and Unpublish. Screenshot each. Confirm the classic-worker path is not CSP-blocked (if it is, confirm the main-thread fallback fired and note it).

- [ ] **Step 7: Open the PR**

```bash
git push -u origin worktree-puzzle-designer-parity
gh pr create --draft --title "feat(puzzles): admin puzzle-designer feature parity with POC" \
  --body "Implements docs/superpowers/specs/2026-07-30-puzzle-designer-feature-parity-design.md. Word list + upload, import/export, print, clear, grid templates (HANA), auto-fill (Web Worker), live suggestions, help, published-list actions. Verified live on DEV."
```

---

## Self-review notes (author)

- **Spec coverage:** word list (T5), upload (T5), import/export (T2+T6), print (T6), clear (T6), instructions/help (T6), grid config incl. templates (T3+T8), auto-fill (T1+T7), live suggestions (T8), published-manager parity (T9), keep hint types + draft/publish (untouched — verified `onSave` not modified). All spec sections mapped.
- **Type consistency:** `b>/answers` keyed `"r,c"`; slot ids `"<r>-<c>-<dir>"`; `solve()` / `fits()` / `parseWordList()` / `exportPuzzle()` / `importPuzzle()` signatures consistent across T1/T2/T5/T7/T8.
- **Single-source solver (no duplication):** `solver-core.js` is a UMD module — AMD for the controller + vm unit tests, `self.SolverCore` for the worker via `importScripts`. `fill-worker.js` holds NO copy of the solve logic; it only adds wall-clock timing + throttled progress. Unit-tested once via `solver-core`.
- **Open confirmations for the implementer:** (a) exact "unpublish" status value vs `PuzzleService` read filter (T9); (b) whether `db/data` CSV seeding for `GridTemplates` trips the `.hdbtabledata` editable-column-wipe gotcha — templates aren't field-edited in admin, so a stable seed CSV is expected safe (confirm at T3).
