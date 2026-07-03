# 906 — Deny bare HANA session-context identifiers in analytics-sql-validator

**Date:** 2026-07-03
**Issue:** [#906](https://github.com/sap-tutorials/tutorials-ims/issues/906)
**Follow-up to:** [#797](https://github.com/sap-tutorials/tutorials-ims/issues/797) pen-test suite

## Problem

`node-sql-parser` (MySQL dialect, the one `srv/lib/analytics-sql-validator.cjs` uses) parses bare identifiers like `SYSTEM_USER`, `SESSION_USER`, and `CURRENT_SCHEMA` as `column_ref` AST nodes, **not** function-call nodes. The validator's function-allowlist walker (`collectFunctions`) only inspects `function` and `aggr_func` nodes, so these identifiers slip past.

Reproducer:

```js
const { validateSelect } = require('./srv/lib/analytics-sql-validator.cjs');
validateSelect('SELECT SYSTEM_USER FROM Users', new Set(['Users']));
// Currently: returns { sql: 'SELECT "SYSTEM_USER" FROM "Users"', selectedColumns: [...] }
// Expected: throws
```

### Why the impact is low today

The validator re-emits queries with `Postgresql` dialect quoting, so the accepted SQL becomes `SELECT "SYSTEM_USER" FROM "Users"`. HANA has no `SYSTEM_USER` column on the standard `Users` table, so the query errors at execution. This is an accidental defense, not a designed one.

### Why the impact grows

1. If the analytics allowlist ever grows to include a HANA schema-introspection view (`SYS.M_DATABASE`, `SYS.M_SESSION_CONTEXT`, `SYS.USERS`, …) or any table that happens to name a column `SYSTEM_USER`, session-context leaks become possible.
2. The bypass is a symptom of a threat-model gap — the validator enforces "tables must be in the allowlist" and "functions must be in the allowlist" but has no rule at all for bare identifiers. That is not by design; it just isn't covered.

## Fix

Add a **denylist walker** (`collectBareIdentifiers`) that scans the AST for `column_ref` nodes whose `column` field is a string matching a HANA session-context / system-pseudocolumn name. Reject on match.

### Denylist contents

HANA reserved session-context and system pseudocolumns (per the HANA SQL Reference "Predefined Special Registers" section):

- `SYSTEM_USER`
- `SESSION_USER`
- `CURRENT_USER`
- `CURRENT_SCHEMA`
- `CURRENT_DATE`
- `CURRENT_TIME`
- `CURRENT_TIMESTAMP`
- `CURRENT_UTCDATE`
- `CURRENT_UTCTIME`
- `CURRENT_UTCTIMESTAMP`
- `CURRENT_CONNECTION`
- `CURRENT_TRANSACTION_ISOLATION_LEVEL`
- `CURRENT_UPDATE_STATEMENT_SEQUENCE`
- `SYSUUID`

**On the CURRENT_DATE / CURRENT_TIMESTAMP bare-vs-function distinction:** these names appear both on the function allowlist (`ALLOWED_FUNCTIONS`) and on the new bare-identifier denylist. That is intentional — `CURRENT_TIMESTAMP()` (function-call form, parsed as `function` node) is legitimate for analytics use; the bare form (parsed as `column_ref`) leaks session context and is denied. The two walkers are dispatched on AST node type, so there is no ambiguity in the code path.

### Qualified-reference carve-out

A qualified reference like `SomeTable.SYSTEM_USER` is a real (if unusual) column reference and should not fire the denylist. `node-sql-parser` sets `column_ref.table` to the qualifier when one is present; the walker will only flag nodes where `table` is null or empty string. Coverage in the test suite pins this.

### Error message

```
Identifier '<NAME>' is a reserved session-context name and not allowed as a bare column reference
```

Consistent voice with the existing `Function '<name>' is not in the analytics function allowlist` message.

## Files changed

- **`srv/lib/analytics-sql-validator.cjs`** — add `DENIED_BARE_IDENTIFIERS` set, add `collectBareIdentifiers` walker (same recursive shape as `collectSubqueries` / `collectFunctions`), add one new loop in `validateSelect` after the function-allowlist loop and before AST re-emit.
- **`test/unit/srv/analytics-sql-validator.pen.test.js`** — un-skip the existing `TODO(#906)` case, drop the TODO comment, add the four additional cases below.

Total change: one file of production code (~15 lines added), one test file (~30 lines added, one `.skip` → `.it`).

## Tests

Un-skip and extend the pen-test suite in `test/unit/srv/analytics-sql-validator.pen.test.js`:

1. **Un-skip existing case** — `SELECT SYSTEM_USER FROM Users` must throw. Drop the `TODO(#906)` comment above it.
2. **New: `SESSION_USER` bare** — `SELECT SESSION_USER FROM Users` must throw with the new error message.
3. **New: `CURRENT_SCHEMA` bare** — `SELECT CURRENT_SCHEMA FROM Users` must throw.
4. **New: `SYSUUID` bare** — `SELECT SYSUUID FROM Users` must throw.
5. **New (positive control — function form still works):** `SELECT CURRENT_DATE() FROM Users` must NOT throw. This pins the bare-vs-function precision — a regression here would break legitimate analytics queries.
6. **New (positive control — qualified column reference not flagged):** `SELECT Users.SYSTEM_USER FROM Users` must not throw on the identifier walker. It may error later (HANA has no such column), but that is not the validator's concern.

All tests run under Vitest's `unit` project — pure logic, no HANA, no CAP boot, no HTTP. Runtime <1 s.

## Non-goals

- **No per-table column allowlist** (Option B in the issue). That would require maintaining a column registry for every `@analytics.exposed` entity and updating it on every schema change. Deferred as a broader change.
- **No parser dialect swap** (Option C). The MySQL dialect is currently load-bearing for the rest of the pen-test suite (e.g. `CURRENT_USER` parse-error behavior at line 92 of the pen-test); swapping dialects risks silent regressions.
- **No changes to `ALLOWED_FUNCTIONS` or `allowedTableNames`.** Both remain untouched.

## Risk & rollback

- **Blast radius:** zero. The validator is pure. No data touched, no state, no DB.
- **False-positive risk:** a legitimate analytics query in the wild that uses a bare `CURRENT_TIMESTAMP` (rather than the `CURRENT_TIMESTAMP()` function form) will start failing after this change. Mitigation: the error message names the identifier, so the author can add parentheses. No known consumer today (analytics-explorer queries are hand-written by admins).
- **Rollback:** delete the new walker + loop + set. One-line revert of the test un-skip. Both are additive.

## Testing plan

- **Unit:** `npm test -- test/unit/srv/analytics-sql-validator.pen.test.js` — must pass all cases including the newly un-skipped one and the four new cases.
- **No hybrid, no smoke.** The change never leaves the JS validator module.

## References

- Issue: [#906](https://github.com/sap-tutorials/tutorials-ims/issues/906)
- Parent pen-test issue: [#797](https://github.com/sap-tutorials/tutorials-ims/issues/797)
- Validator: [`srv/lib/analytics-sql-validator.cjs`](../../../srv/lib/analytics-sql-validator.cjs)
- Test suite: [`test/unit/srv/analytics-sql-validator.pen.test.js`](../../../test/unit/srv/analytics-sql-validator.pen.test.js)
