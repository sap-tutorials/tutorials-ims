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

Add a **denylist walker** (`collectBareIdentifiers`) that scans the AST for `column_ref` nodes whose `column` field is a bare string matching a HANA session-context / system-pseudocolumn name. Reject on match.

### Case handling

HANA identifiers are case-insensitive; `node-sql-parser` preserves the source casing on `column_ref.column`. To mirror the existing `collectFunctions` pattern (which uppercases and compares against an upper-case `ALLOWED_FUNCTIONS`), the walker uppercases the extracted identifier before the set lookup, and `DENIED_BARE_IDENTIFIERS` stores upper-case names. `system_user`, `SYSTEM_USER`, and `System_User` all resolve to the same denylist hit.

### AST shape

`node-sql-parser` surfaces `column_ref.column` as either a bare string primitive (the common case) or as a nested object whose `.expr.value` holds the identifier (for quoted / special forms; the `.expr.type` discriminator varies by parser version and is not checked). The walker MUST handle both:

```js
const raw = typeof node.column === 'string'
  ? node.column
  : (node.column?.expr?.value ?? null)
if (!raw) return
```

Any nested `.expr.value` string is treated as an identifier candidate — `expr.type` is deliberately ignored so future parser versions don't silently regress the check. Anything else (missing, non-string, unexpected shape) is skipped — the identifier still flows through the rest of validation and, if genuinely disallowed at HANA, errors at execution. The denylist is a targeted defense, not a general column validator.

### Denylist contents

HANA reserved session-context and system pseudocolumns. Sourcing: HANA SQL Reference (HANA Cloud QRC 2026-Q2), sections "Predefined Special Registers" and "Session Variables". Concretely:

- `SYSTEM_USER`
- `SESSION_USER`
- `CURRENT_USER`
- `CURRENT_SCHEMA`
- `CURRENT_CLIENT`
- `CURRENT_DATE`
- `CURRENT_TIME`
- `CURRENT_TIMESTAMP`
- `CURRENT_UTCDATE`
- `CURRENT_UTCTIME`
- `CURRENT_UTCTIMESTAMP`
- `CURRENT_CONNECTION`
- `CURRENT_OBJECT_SCHEMA`
- `CURRENT_SITE_ID`
- `CURRENT_MVCC_SNAPSHOT_TIMESTAMP`
- `CURRENT_TRANSACTION_ISOLATION_LEVEL`
- `CURRENT_UPDATE_STATEMENT_SEQUENCE`
- `SYSUUID`

The list is stored as an upper-case `Set` in the validator; additions when SAP publishes new registers are one-line PRs against `DENIED_BARE_IDENTIFIERS`.

**On the CURRENT_DATE / CURRENT_TIME / CURRENT_TIMESTAMP bare-vs-function distinction:** these names appear both on the function allowlist (`ALLOWED_FUNCTIONS`) and on the new bare-identifier denylist. Under the current MySQL dialect of `node-sql-parser`, the bare forms of these three names are parsed as `function` AST nodes (not `column_ref`), so they never reach the bare-identifier walker — the function-allowlist path handles them, and both `CURRENT_TIMESTAMP` and `CURRENT_TIMESTAMP()` pass validation. That is the desired behavior: these registers return non-sensitive values (current date/time) and are legitimate for analytics use. Their presence in `DENIED_BARE_IDENTIFIERS` is belt-and-suspenders — if a future parser upgrade flips their classification to `column_ref`, the denylist walker catches them and the identifier can be reclassified (removed from the denylist) once the semantics are re-confirmed as safe.

**On `CURRENT_USER`:** the MySQL dialect treats `CURRENT_USER` as a reserved keyword and rejects the bare form at parse time (see the pre-existing pen-test at line 92 of `analytics-sql-validator.pen.test.js`). It never reaches the walker either. Kept on the denylist as belt-and-suspenders in case a future parser upgrade accepts it.

### Qualified-reference carve-out

A qualified reference like `SomeTable.SYSTEM_USER` is a real (if unusual) column reference and should not fire the denylist. `node-sql-parser` sets `column_ref.table` to the qualifier when one is present; the walker will only flag nodes where `table` is null or empty string. Coverage in the test suite pins this.

### Error message

```
Identifier '<NAME>' is a reserved session-context name and not allowed as a bare column reference
```

Consistent voice with the existing `Function '<name>' is not in the analytics function allowlist` message.

## Files changed

- **`srv/lib/analytics-sql-validator.cjs`** — add `DENIED_BARE_IDENTIFIERS` set, add `collectBareIdentifiers` walker (same recursive shape as `collectSubqueries` / `collectFunctions`), add one new loop in `validateSelect` after the function-allowlist loop and before AST re-emit.
- **`test/unit/srv/analytics-sql-validator.pen.test.js`** — un-skip the existing `TODO(#906)` case, drop the TODO comment, and add the additional cases enumerated in the Tests section.

Total change: one file of production code (~20 lines added), one test file (~50 lines added, one `.skip` → `.it`).

## Tests

Un-skip and extend the pen-test suite in `test/unit/srv/analytics-sql-validator.pen.test.js`:

1. **Un-skip existing case** — `SELECT SYSTEM_USER FROM Users` must throw. Drop the `TODO(#906)` comment above it.
2. **New: `SESSION_USER` bare** — `SELECT SESSION_USER FROM Users` must throw with the new error message.
3. **New: `CURRENT_SCHEMA` bare** — `SELECT CURRENT_SCHEMA FROM Users` must throw.
4. **New: `SYSUUID` bare** — `SELECT SYSUUID FROM Users` must throw.
5. **New (case-insensitive):** `SELECT session_user FROM Users` must throw. Pins the uppercase-comparison behavior — a case-sensitive implementation would pass all the earlier cases while leaving a trivial `session_user` / `System_User` bypass.
6. **New (WHERE clause position):** `SELECT id FROM Users WHERE SYSTEM_USER = 'x'` must throw. Confirms the walker recurses into WHERE predicates, not just the SELECT list.
7. **New (subquery position):** `SELECT * FROM Users WHERE id IN (SELECT SESSION_USER FROM Users)` must throw. Confirms the walker follows nested SELECT nodes.
8. **New (positive control — function form works):** `SELECT CURRENT_DATE() FROM Users` must NOT throw. Also — because `CURRENT_DATE` is parsed as a `function` AST node even in bare form under MySQL dialect — `SELECT CURRENT_DATE FROM Users` must ALSO NOT throw (function-allowlist path handles it). Both tests pin the classification and document the intentional belt-and-suspenders overlap between `ALLOWED_FUNCTIONS` and `DENIED_BARE_IDENTIFIERS` for the three date/time registers.
9. **New (positive control — qualified column reference not flagged):** `SELECT Users.SYSTEM_USER FROM Users` must not throw on the identifier walker. It may error later (HANA has no such column), but that is not the validator's concern.
10. **New (positive control — alias only, not a bare identifier):** `SELECT id AS SYSTEM_USER FROM Users` must not throw. Pins that the walker only inspects `column_ref` nodes, not the `.as` field — documents intent and catches a future refactor that starts walking aliases.

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

- **Unit:** `npm test -- test/unit/srv/analytics-sql-validator.pen.test.js` — must pass all cases including the newly un-skipped one and all new cases enumerated in the Tests section.
- **No hybrid, no smoke.** The change never leaves the JS validator module.

## References

- Issue: [#906](https://github.com/sap-tutorials/tutorials-ims/issues/906)
- Parent pen-test issue: [#797](https://github.com/sap-tutorials/tutorials-ims/issues/797)
- Validator: [`srv/lib/analytics-sql-validator.cjs`](../../../srv/lib/analytics-sql-validator.cjs)
- Test suite: [`test/unit/srv/analytics-sql-validator.pen.test.js`](../../../test/unit/srv/analytics-sql-validator.pen.test.js)
