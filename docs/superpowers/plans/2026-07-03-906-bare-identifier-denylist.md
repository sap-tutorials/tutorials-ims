# 906 — Deny bare HANA session-context identifiers (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the analytics-sql-validator bypass where bare HANA session-context identifiers like `SYSTEM_USER` are parsed by `node-sql-parser` as `column_ref` AST nodes and slip past the function-allowlist check.

**Architecture:** Add a third AST walker (`collectBareIdentifiers`) alongside the existing `collectFromClause` / `collectFunctions` / `collectSubqueries` walkers in [srv/lib/analytics-sql-validator.cjs](../../../srv/lib/analytics-sql-validator.cjs). The walker inspects every `column_ref` node whose `table` qualifier is empty, uppercases the identifier, and rejects it if present in a new upper-case `DENIED_BARE_IDENTIFIERS` set of HANA special registers. All existing behavior (function allowlist, table allowlist, DDL/DML rejection, comment rejection, size limit) is untouched.

**Tech Stack:** Node.js CommonJS (`.cjs`), `node-sql-parser` (MySQL dialect), Vitest (`unit` project).

**Working directory:** `d:/projects/tutorials-poc/.claude/worktrees/fix-906-bare-identifier-denylist/` (branch `fix/906-bare-identifier-denylist`).

**Spec:** [docs/superpowers/specs/2026-07-03-906-bare-identifier-denylist-design.md](../specs/2026-07-03-906-bare-identifier-denylist-design.md)

---

## File Structure

**One production file, one test file. Both already exist.**

- **Modify:** [srv/lib/analytics-sql-validator.cjs](../../../srv/lib/analytics-sql-validator.cjs) — add `DENIED_BARE_IDENTIFIERS` set (module-scope constant, ~18 names), add `collectBareIdentifiers` walker function (~15 lines), add one bare-identifier loop inside `validateSelect` between the function-allowlist loop and the AST re-emit.
- **Modify:** [test/unit/srv/analytics-sql-validator.pen.test.js](../../../test/unit/srv/analytics-sql-validator.pen.test.js) — un-skip the existing `TODO(#906)` case at line 110, drop the multi-line TODO comment above it, and add ten new test cases inside the existing `describe('rejects disallowed functions / privilege escalation identifiers', ...)` and `describe('accepts legitimate SELECTs', ...)` blocks (or a new sibling `describe` block for identifier-denylist coverage — see step guidance).

No new files. No dependency changes.

---

## Task 1: Add failing tests for bare-identifier denylist (TDD RED)

**Files:**
- Modify: `test/unit/srv/analytics-sql-validator.pen.test.js`

The eleven test cases from the spec (§ Tests) all go in this task. Positive-control cases already pass under the current validator (nothing to un-fire); the negative cases are the ones that will drive the RED → GREEN transition.

### Guidance

- Read the existing test file first to match its style — it uses Vitest (`import { describe, it, expect } from 'vitest'`), `it.each` for parameterized cases, and wraps `allowedTableNames` as a `Set` at the top (`const ALLOWED = new Set([...])`).
- The existing `.skip`ped case is at line 110 (search for `TODO(#906)`). Un-skip means `it.skip(...)` → `it(...)` and delete the multi-line comment above it (lines starting `// TODO(#906):` through the final `// bare identifiers to resolve against an explicit column allowlist.`).
- Add the ten new cases as a new sibling `describe` block after the existing "rejects disallowed functions / privilege escalation identifiers" block, titled `describe('rejects bare HANA session-context identifiers (#906)', ...)`. Group the positive controls under their own `describe('accepts legitimate uses of session-context names', ...)` inside the same "accepts legitimate SELECTs" region, OR as a new sibling block — either is fine, match the file's style.
- The error-message assertion for negative cases can match on the specific error text `/reserved session-context name/i` for the four straightforward cases (SESSION_USER bare, CURRENT_SCHEMA bare, SYSUUID bare, session_user lowercase). WHERE-clause and subquery cases should also use this matcher. The bare `CURRENT_DATE` case uses bare `.toThrow()` (no matcher) because either the denylist error OR the parser error is acceptable per spec §Tests item 9.
- Positive controls use `expect(() => ...).not.toThrow()`.

### Steps

- [ ] **Step 1: Read the current test file to lock in style**

Run:
```bash
cd d:/projects/tutorials-poc/.claude/worktrees/fix-906-bare-identifier-denylist
sed -n '1,30p;80,130p' test/unit/srv/analytics-sql-validator.pen.test.js
```

Confirm: existing `describe` blocks use string titles ending with issue numbers where relevant (e.g. `(#797)`); `it.each(cases)` pattern is in use; `ALLOWED` is a `Set`.

- [ ] **Step 2: Un-skip the existing `TODO(#906)` case and drop the TODO comment**

Locate the block at lines 98–112 of the test file:

```javascript
    // TODO(#906): node-sql-parser (MySQL dialect) parses SYSTEM_USER
    // as a bare column_ref, not a function call, so the function-allowlist path
    // never fires and the validator returns success. The FROM table `Users`
    // is on the allowlist, so the SELECT is accepted and re-emitted as
    //   SELECT "SYSTEM_USER" FROM "Users"
    // which HANA would resolve to a column named SYSTEM_USER. On tables where
    // no such column exists this is a runtime error, but on any table that
    // happens to define a SYSTEM_USER column, or if a future refactor allows
    // schema introspection views, this becomes an information-disclosure
    // channel. Track as follow-up to #797 and add SYSTEM_USER / SESSION_USER /
    // CURRENT_USER to an identifier-denylist in the validator, or force
    // bare identifiers to resolve against an explicit column allowlist.
    it.skip('rejects SELECT SYSTEM_USER FROM Users (real gap — column_ref, not function call)', () => {
      expect(() => validator.validateSelect('SELECT SYSTEM_USER FROM Users', ALLOWED)).toThrow();
    });
```

Replace with:

```javascript
    it('rejects SELECT SYSTEM_USER FROM Users (bare identifier — column_ref, not function call)', () => {
      expect(() => validator.validateSelect('SELECT SYSTEM_USER FROM Users', ALLOWED)).toThrow(
        /reserved session-context name/i,
      );
    });
```

Rationale: with the fix in place, this case must throw the specific new error. Tightening the matcher from bare `.toThrow()` to a regex pins the message so a future refactor can't silently substitute a different failure mode.

- [ ] **Step 3: Add the new `describe` block for negative cases**

Append this block AFTER the closing `});` of the existing `describe('rejects disallowed functions / privilege escalation identifiers', ...)` block, and BEFORE the `describe('rejects oversize input', ...)` block:

```javascript
  describe('rejects bare HANA session-context identifiers (#906)', () => {
    // These identifiers are HANA session-context / system-pseudocolumn names.
    // node-sql-parser (MySQL dialect) parses the bare forms as column_ref
    // AST nodes rather than function-call nodes, so the function-allowlist
    // path does not fire. The bare-identifier walker added in #906 closes
    // that gap. See docs/superpowers/specs/2026-07-03-906-bare-identifier-denylist-design.md.

    it('rejects SELECT SESSION_USER FROM Users', () => {
      expect(() => validator.validateSelect('SELECT SESSION_USER FROM Users', ALLOWED)).toThrow(
        /reserved session-context name/i,
      );
    });

    it('rejects SELECT CURRENT_SCHEMA FROM Users', () => {
      expect(() => validator.validateSelect('SELECT CURRENT_SCHEMA FROM Users', ALLOWED)).toThrow(
        /reserved session-context name/i,
      );
    });

    it('rejects SELECT SYSUUID FROM Users', () => {
      expect(() => validator.validateSelect('SELECT SYSUUID FROM Users', ALLOWED)).toThrow(
        /reserved session-context name/i,
      );
    });

    it('rejects lowercase bare identifier — SELECT session_user FROM Users', () => {
      // Case-insensitivity pin: HANA identifiers are case-insensitive and the
      // walker uppercases before set lookup. A case-sensitive implementation
      // would silently pass this test — hence its inclusion.
      expect(() => validator.validateSelect('SELECT session_user FROM Users', ALLOWED)).toThrow(
        /reserved session-context name/i,
      );
    });

    it('rejects bare identifier in WHERE predicate', () => {
      // Confirms the walker recurses through WHERE, not just the SELECT list.
      expect(() =>
        validator.validateSelect("SELECT id FROM Users WHERE SYSTEM_USER = 'x'", ALLOWED),
      ).toThrow(/reserved session-context name/i);
    });

    it('rejects bare identifier inside a subquery', () => {
      // Confirms the walker follows nested SELECT nodes.
      expect(() =>
        validator.validateSelect(
          'SELECT * FROM Users WHERE id IN (SELECT SESSION_USER FROM Users)',
          ALLOWED,
        ),
      ).toThrow(/reserved session-context name/i);
    });

    it('rejects bare CURRENT_DATE — dialect-quirk pin', () => {
      // Either the new denylist error or a parse-error is acceptable per spec.
      // Test uses bare .toThrow() to pin *some* failure so a future parser
      // upgrade that flips column_ref → function classification doesn't
      // silently open a hole.
      expect(() => validator.validateSelect('SELECT CURRENT_DATE FROM Users', ALLOWED)).toThrow();
    });
  });
```

- [ ] **Step 4: Add the positive-control block**

Append this block to the existing `describe('accepts legitimate SELECTs', ...)` block (or add it as a sibling `describe` immediately after — either works; matching the file's style suggests appending inside):

```javascript
    it('accepts SELECT CURRENT_DATE() FROM Users (function form still allowed)', () => {
      // Pins the bare-vs-function precision. Denylist entry CURRENT_DATE
      // must NOT block the function-call form; the two walkers dispatch on
      // AST node type.
      expect(() => validator.validateSelect('SELECT CURRENT_DATE() FROM Users', ALLOWED)).not.toThrow();
    });

    it('accepts SELECT Users.SYSTEM_USER FROM Users (qualified column reference not flagged)', () => {
      // Qualified references have column_ref.table set to the qualifier —
      // the walker only flags bare (unqualified) references. HANA may error
      // at execution (no such column), but that's out of scope for the
      // validator.
      expect(() => validator.validateSelect('SELECT Users.SYSTEM_USER FROM Users', ALLOWED)).not.toThrow();
    });

    it('accepts SELECT id AS SYSTEM_USER FROM Users (alias, not a bare identifier)', () => {
      // The walker only inspects column_ref nodes, not the .as field.
      // Pins the intent and catches a future refactor that starts walking aliases.
      expect(() => validator.validateSelect('SELECT id AS SYSTEM_USER FROM Users', ALLOWED)).not.toThrow();
    });
```

- [ ] **Step 5: Run the pen-test suite to confirm the tests fail RED**

Run:
```bash
cd d:/projects/tutorials-poc/.claude/worktrees/fix-906-bare-identifier-denylist
npx vitest run --project unit test/unit/srv/analytics-sql-validator.pen.test.js 2>&1 | tail -60
```

Expected outcome:
- All negative cases from Steps 2 and 3 FAIL with output showing `validateSelect` did NOT throw (or threw a different error that doesn't match the regex).
- All positive-control cases from Step 4 PASS — they don't rely on the fix.
- All pre-existing tests in the file continue to pass.

Do NOT proceed if any pre-existing test starts failing — that would signal accidental damage to the file. Fix the test file before continuing.

If the bare `CURRENT_DATE` test in Step 3 passes (throws) even without the fix, that's fine — parser dialect quirks may cause it to fail at parse time. The test's assertion is `.toThrow()` without a matcher, so either outcome is acceptable.

- [ ] **Step 6: Commit the failing tests**

Run:
```bash
cd d:/projects/tutorials-poc/.claude/worktrees/fix-906-bare-identifier-denylist
git add test/unit/srv/analytics-sql-validator.pen.test.js
git status --short
git commit -m "test(#906): failing pen-tests for bare HANA session-context identifier bypass

TDD RED — these tests fail against the current validator, which parses
SYSTEM_USER / SESSION_USER / etc. as column_ref AST nodes and passes
them through. Task 2 adds the collectBareIdentifiers walker to make
them pass.

- Un-skip pre-existing TODO(#906) case and tighten its matcher
- Add coverage for SESSION_USER, CURRENT_SCHEMA, SYSUUID, lowercase,
  WHERE predicate, subquery position, and bare CURRENT_DATE
- Add positive controls: CURRENT_DATE() function form, qualified
  Users.SYSTEM_USER reference, and id AS SYSTEM_USER alias"
```

---

## Task 2: Implement the bare-identifier walker (TDD GREEN)

**Files:**
- Modify: `srv/lib/analytics-sql-validator.cjs`

The implementation is three additive edits: (1) add the `DENIED_BARE_IDENTIFIERS` set near `ALLOWED_FUNCTIONS`, (2) add the `collectBareIdentifiers` walker function after `collectFunctions`, (3) add one new loop in `validateSelect` between the function-allowlist loop and the AST re-emit.

### Guidance

- Read the existing validator first to match its comment density and style. It uses two-space indentation, single quotes, no semicolons, `const` throughout, comments that explain *why* rather than *what*.
- Placement of the constant: right after `ALLOWED_FUNCTIONS` in the module header, with a comment mirroring the one above `ALLOWED_FUNCTIONS`.
- Placement of the walker: right after `collectFunctions`, at the bottom of the file. Same recursive shape (`Array.isArray`, `Object.values`, guard on `!node || typeof node !== 'object'`).
- Placement of the loop: inside `validateSelect`, after the `for (const fn of calledFunctions) { ... }` loop and before the `isStar` determination. Order matters for error priority — if a query has both a disallowed function AND a bare identifier, the function-allowlist error fires first (consistent with current threat-model prioritization).
- Qualified-reference carve-out: check `!node.table || node.table === ''` before flagging. `node-sql-parser` sets `column_ref.table` to `null` when unqualified.

### Steps

- [ ] **Step 1: Read the current validator file**

Run:
```bash
cd d:/projects/tutorials-poc/.claude/worktrees/fix-906-bare-identifier-denylist
cat srv/lib/analytics-sql-validator.cjs
```

Confirm: no semicolons (validator style), two-space indent, `ALLOWED_FUNCTIONS` at lines 11–26, `collectFunctions` at lines 108–123, `validateSelect` body at lines 28–85.

- [ ] **Step 2: Add `DENIED_BARE_IDENTIFIERS` set after `ALLOWED_FUNCTIONS`**

After line 26 (the closing `])` of `ALLOWED_FUNCTIONS`), insert a blank line and this block:

```javascript
// HANA reserved session-context and system pseudocolumns that node-sql-parser
// (MySQL dialect) parses as bare column_ref AST nodes rather than function
// calls. Without this denylist, `SELECT SYSTEM_USER FROM Users` slips past
// the function-allowlist walker below — see #906. Names stored upper-case
// and compared upper-case (HANA identifiers are case-insensitive). Sourcing:
// HANA SQL Reference (HANA Cloud QRC 2026-Q2), sections "Predefined Special
// Registers" and "Session Variables". Additions when SAP publishes new
// registers are one-line PRs against this set.
const DENIED_BARE_IDENTIFIERS = new Set([
  'SYSTEM_USER', 'SESSION_USER', 'CURRENT_USER',
  'CURRENT_SCHEMA', 'CURRENT_CLIENT',
  'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
  'CURRENT_UTCDATE', 'CURRENT_UTCTIME', 'CURRENT_UTCTIMESTAMP',
  'CURRENT_CONNECTION', 'CURRENT_OBJECT_SCHEMA', 'CURRENT_SITE_ID',
  'CURRENT_MVCC_SNAPSHOT_TIMESTAMP',
  'CURRENT_TRANSACTION_ISOLATION_LEVEL',
  'CURRENT_UPDATE_STATEMENT_SEQUENCE',
  'SYSUUID',
])
```

- [ ] **Step 3: Add the bare-identifier loop inside `validateSelect`**

Find the block at (approximately) lines 67–73 of the current file:

```javascript
  // Function-call allowlist: traverse the entire AST and reject any function
  // not in ALLOWED_FUNCTIONS. Catches os_command, dbms_pipe.*, custom UDFs, etc.
  const calledFunctions = new Set()
  collectFunctions(ast, calledFunctions)
  for (const fn of calledFunctions) {
    if (!ALLOWED_FUNCTIONS.has(fn)) {
      throw new Error(`Function '${fn}' is not in the analytics function allowlist`)
    }
  }
```

Immediately after that block's closing `}` and BEFORE the `const isStar = ...` line, insert:

```javascript

  // Bare-identifier denylist: HANA session-context names like SYSTEM_USER
  // parse as column_ref nodes, not function calls, and would otherwise slip
  // past the function-allowlist path above. See #906.
  const bareIdentifiers = new Set()
  collectBareIdentifiers(ast, bareIdentifiers)
  for (const id of bareIdentifiers) {
    if (DENIED_BARE_IDENTIFIERS.has(id)) {
      throw new Error(
        `Identifier '${id}' is a reserved session-context name and not allowed as a bare column reference`,
      )
    }
  }
```

- [ ] **Step 4: Add the `collectBareIdentifiers` walker at the bottom of the file**

After the closing `}` of `collectFunctions` (currently the last function in the file, ending at line 123) and BEFORE the `module.exports = ...` line, insert:

```javascript

function collectBareIdentifiers(node, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(n => collectBareIdentifiers(n, out)); return }
  // A column_ref with no table qualifier is a bare identifier. Qualified
  // references (Users.SYSTEM_USER) are legitimate column reads and left alone.
  // node-sql-parser surfaces column_ref.column either as a bare string primitive
  // or as a nested object whose .expr.value holds the identifier; we handle
  // both without inspecting .expr.type (varies by parser version).
  if (node.type === 'column_ref' && (!node.table || node.table === '')) {
    const raw = typeof node.column === 'string'
      ? node.column
      : (node.column?.expr?.value ?? null)
    if (raw && typeof raw === 'string' && raw !== '*') {
      out.add(raw.toUpperCase())
    }
  }
  for (const v of Object.values(node)) collectBareIdentifiers(v, out)
}
```

- [ ] **Step 5: Run the pen-test suite to confirm GREEN**

Run:
```bash
cd d:/projects/tutorials-poc/.claude/worktrees/fix-906-bare-identifier-denylist
npx vitest run --project unit test/unit/srv/analytics-sql-validator.pen.test.js 2>&1 | tail -40
```

Expected:
- All negative cases now PASS (throw with `/reserved session-context name/i` matcher).
- All positive-control cases still PASS (function form, qualified reference, alias not flagged).
- All pre-existing tests still PASS.
- Test count matches: 1 un-skipped + 10 new + all originals.

If any test still fails, investigate the specific failure — the most likely culprits are:
- `column_ref.column` shape variant not covered by the extraction (compare AST via a quick `console.log(JSON.stringify(ast, null, 2))` on the failing SQL).
- Walker not recursing into a specific AST branch (WHERE `in_expression` args live inside `where.right.value` — the generic `Object.values` recursion should catch it, but verify).
- Positive control `id AS SYSTEM_USER` throwing because the AST puts `SYSTEM_USER` in `as` AND also in a `column_ref` somewhere — inspect the AST if this fires.

- [ ] **Step 6: Run the FULL unit suite to confirm no collateral damage**

Run:
```bash
cd d:/projects/tutorials-poc/.claude/worktrees/fix-906-bare-identifier-denylist
npx vitest run --project unit 2>&1 | tail -30
```

Expected: full unit suite passes. Any unrelated test failures pre-existed this branch — surface them but do NOT attempt fixes as part of this task.

- [ ] **Step 7: Commit the implementation**

Run:
```bash
cd d:/projects/tutorials-poc/.claude/worktrees/fix-906-bare-identifier-denylist
git add srv/lib/analytics-sql-validator.cjs
git status --short
git commit -m "fix(#906): deny bare HANA session-context identifiers in analytics-sql-validator

node-sql-parser (MySQL dialect) parses SYSTEM_USER / SESSION_USER /
CURRENT_SCHEMA etc. as bare column_ref AST nodes rather than function
calls, so the function-allowlist walker never fires. Today HANA errors
at execution (no such column on standard Users table) — an accidental
defense that would fail the moment the analytics allowlist includes a
schema-introspection view or a table with a SYSTEM_USER column.

Add DENIED_BARE_IDENTIFIERS (18 HANA special registers + session
variables) plus a collectBareIdentifiers walker mirroring the existing
collectFunctions / collectSubqueries shape. Walker uppercases before
set lookup (HANA identifiers are case-insensitive), skips qualified
references (column_ref.table populated), and handles both bare-string
and nested { expr: { value } } AST shapes for column_ref.column.

Function-call forms (CURRENT_TIMESTAMP()) remain allowed via the
existing ALLOWED_FUNCTIONS path — the two walkers dispatch on AST node
type. Tests in test/unit/srv/analytics-sql-validator.pen.test.js pin
this bare-vs-function precision plus the case-insensitive, subquery,
WHERE, qualified-reference, and alias behaviors."
```

---

## Task 3: Push branch and open PR

**Files:** none — repository operation only.

### Guidance

- The change is TDD-complete after Task 2: red tests written, implementation added, tests green, no collateral damage. Task 3 is the merge-request handshake.
- Per project convention (`CLAUDE.md` → Local Deploy & Conventions), PR over direct merge is the default.
- Link the PR to issue #906 in the body using `Closes #906` on its own line so GitHub auto-closes the issue on merge (per the project's [feedback_github_close_keyword](../../../.claude/projects/... memory)) — one keyword per line matters if we ever add more issues.

### Steps

- [ ] **Step 1: Confirm working tree is clean and branch is ahead of origin**

Run:
```bash
cd d:/projects/tutorials-poc/.claude/worktrees/fix-906-bare-identifier-denylist
git status
git log --oneline -5
```

Expected: three commits ahead of `main` on branch `fix/906-bare-identifier-denylist` — the spec doc, the spec-review revisions, the failing tests, and the implementation. (Actually 4 total: spec + spec-pass-1-fixes + spec-pass-2-fixes + failing tests + implementation = 5. Adjust the count in the log check accordingly.)

Working tree must be clean.

- [ ] **Step 2: Push the branch**

Run:
```bash
cd d:/projects/tutorials-poc/.claude/worktrees/fix-906-bare-identifier-denylist
git push -u origin fix/906-bare-identifier-denylist
```

Expected: branch created on origin.

- [ ] **Step 3: Open the PR**

Run:
```bash
cd d:/projects/tutorials-poc/.claude/worktrees/fix-906-bare-identifier-denylist
gh pr create --title "fix(#906): deny bare HANA session-context identifiers in analytics-sql-validator" --body "$(cat <<'BODY'
Closes #906.

Follow-up to the #797 pen-test suite. Adds a third AST walker
(collectBareIdentifiers) to `srv/lib/analytics-sql-validator.cjs`
that catches bare HANA session-context identifiers like SYSTEM_USER,
SESSION_USER, CURRENT_SCHEMA — which node-sql-parser (MySQL dialect)
parses as `column_ref` nodes rather than function calls, so the
existing function-allowlist walker never fires.

## What changes

- `srv/lib/analytics-sql-validator.cjs`: add `DENIED_BARE_IDENTIFIERS`
  (18 HANA special registers), add `collectBareIdentifiers` walker
  (same recursive shape as `collectSubqueries` / `collectFunctions`),
  add one new loop in `validateSelect` between the function-allowlist
  check and the AST re-emit.
- `test/unit/srv/analytics-sql-validator.pen.test.js`: un-skip the
  pre-existing `TODO(#906)` case (tightened matcher) and add ten new
  cases covering case-insensitivity, WHERE-clause / subquery positions,
  the bare-vs-function precision (`CURRENT_DATE()` still works;
  bare `CURRENT_DATE` still throws), qualified references, and the
  alias carve-out.

## Threat model

- Bare-vs-function distinction: dispatched on AST node type, so
  `CURRENT_TIMESTAMP()` (allowlisted function) works while bare
  `CURRENT_TIMESTAMP` is denied.
- Case-insensitive: identifiers uppercased before set lookup.
- Qualified references (`Users.SYSTEM_USER`) not flagged — walker
  checks `column_ref.table` is null/empty.
- Aliases (`id AS SYSTEM_USER`) not flagged — walker only inspects
  `column_ref` nodes, not `.as` fields.

## Testing

- `npx vitest run --project unit test/unit/srv/analytics-sql-validator.pen.test.js` — all cases pass, including the newly un-skipped one and all ten new cases.
- Full unit suite (`npx vitest run --project unit`) unaffected.
- No hybrid / smoke changes — validator is pure JS with no HANA, CAP, or HTTP surface.

## Non-goals

- No per-table column allowlist (Option B from the issue) — deferred.
- No parser dialect swap (Option C) — MySQL dialect is load-bearing
  for other pen-tests.
- No changes to `ALLOWED_FUNCTIONS` or table allowlist plumbing.

Spec: `docs/superpowers/specs/2026-07-03-906-bare-identifier-denylist-design.md`
BODY
)"
```

Expected: PR URL printed. Open the PR in the browser to sanity-check the rendered body, then wait for CI + review.

- [ ] **Step 4: Return to primary tree**

Once the PR is opened, this worktree is done. Do NOT deploy anything from this branch — the change is validator-only and rides the next MTA deploy of `srv`.

Run:
```bash
cd d:/projects/tutorials-poc
git status
```

Expected: back in the primary tree, `main` branch, clean.

---

## Rollback

If the fix causes any legitimate analytics-explorer query to fail after merge:

1. The failing query will report `Identifier '<NAME>' is a reserved session-context name...` — the author adds parentheses (e.g. `CURRENT_TIMESTAMP` → `CURRENT_TIMESTAMP()`).
2. If a hard revert is needed: `git revert <commit-sha>` reverts both the walker and the tests. Blast radius zero — pure JS, no data.

## Verification checklist

Before requesting review:

- [ ] Task 1 committed with title `test(#906): failing pen-tests for bare HANA session-context identifier bypass`.
- [ ] Task 2 committed with title `fix(#906): deny bare HANA session-context identifiers in analytics-sql-validator`.
- [ ] `npx vitest run --project unit test/unit/srv/analytics-sql-validator.pen.test.js` passes 100%.
- [ ] `npx vitest run --project unit` (full unit suite) passes 100% — or has the same pass rate as `main`.
- [ ] Branch pushed, PR opened, PR body includes `Closes #906` on its own line.
- [ ] Worktree cleanup deferred until PR merges — do NOT remove until merge.
