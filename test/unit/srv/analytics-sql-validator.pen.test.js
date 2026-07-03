// test/unit/srv/analytics-sql-validator.pen.test.js
//
// Pen-test / SQL-injection fuzz suite for srv/lib/analytics-sql-validator.cjs.
// The validator is the single point of trust between the AnalyticsService
// `runSelectQuery` action and HANA — every hostile fixture here MUST throw.
// See issue #797 for the broader pen-test plan.
//
// NOTE: validateSelect(sql, allowedTableNames) expects allowedTableNames to be
// a Set (uses `.has()`); passing an array silently TypeErrors. Wrap accordingly.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const validator = require(path.resolve(import.meta.dirname, '../../../srv/lib/analytics-sql-validator.cjs'));

// Minimal allowlist matching real AnalyticsService exposure — extend if
// analytics-service.js is refactored to expose a broader set.
const ALLOWED = new Set(['Users', 'TaskRecords', 'Missions', 'Tutorials']);

describe('analytics-sql-validator: injection fuzz (#797)', () => {
  describe('rejects DDL/DML', () => {
    const cases = [
      'DROP TABLE Users',
      'DELETE FROM Users',
      "UPDATE Users SET name='x'",
      'INSERT INTO Users VALUES (1)',
      'TRUNCATE TABLE Users',
      'ALTER TABLE Users ADD c INT',
      'CREATE TABLE t (id INT)',
    ];
    it.each(cases)('rejects %s', (sql) => {
      expect(() => validator.validateSelect(sql, ALLOWED)).toThrow();
    });
  });

  describe('rejects multi-statement / stacked queries', () => {
    const cases = [
      'SELECT * FROM Users; DROP TABLE Users',
      'SELECT 1; DELETE FROM Users',
      'SELECT * FROM Users; SELECT * FROM Missions',
    ];
    it.each(cases)('rejects %s', (sql) => {
      expect(() => validator.validateSelect(sql, ALLOWED)).toThrow(
        /single statement/i,
      );
    });
  });

  describe('rejects comment-based bypass', () => {
    // The validator rejects `--` and `/*` at the string level BEFORE parsing —
    // strict-by-default posture. Any change to that behavior should update
    // this suite (and probably file a security-review ticket first).
    const cases = [
      'SELECT * FROM Users -- ; DROP TABLE Users',
      'SELECT * FROM Users /* comment */',
      'SELECT /* nested */ * FROM Users',
    ];
    it.each(cases)('rejects %s', (sql) => {
      expect(() => validator.validateSelect(sql, ALLOWED)).toThrow(
        /comments are not allowed/i,
      );
    });
  });

  describe('rejects unallowed tables', () => {
    it('rejects SELECT * FROM ImsConfig (secret table)', () => {
      expect(() => validator.validateSelect('SELECT * FROM ImsConfig', ALLOWED)).toThrow(
        /not in the analytics allowlist/i,
      );
    });
    it('rejects SELECT * FROM SYS.M_DATABASE (HANA information schema)', () => {
      // node-sql-parser splits SYS.M_DATABASE into { db: 'SYS', table: 'M_DATABASE' }
      // and the FROM collector emits the bare table name — still not in the allowlist.
      expect(() => validator.validateSelect('SELECT * FROM SYS.M_DATABASE', ALLOWED)).toThrow(
        /not in the analytics allowlist/i,
      );
    });
  });

  describe('rejects disallowed functions / privilege escalation identifiers', () => {
    // SESSION_USER against an unallowed FROM table — rejected via the table
    // allowlist regardless of whether SESSION_USER is treated as function or
    // identifier by node-sql-parser. Still worth pinning.
    it('rejects SELECT SESSION_USER FROM DUMMY (unallowed table)', () => {
      expect(() => validator.validateSelect('SELECT SESSION_USER FROM DUMMY', ALLOWED)).toThrow();
    });

    // CURRENT_USER is a reserved keyword under the MySQL parser dialect and
    // requires parentheses (CURRENT_USER()); the bare form fails at parse time.
    it('rejects SELECT CURRENT_USER FROM Users (parse error under MySQL dialect)', () => {
      expect(() => validator.validateSelect('SELECT CURRENT_USER FROM Users', ALLOWED)).toThrow(
        /parse error/i,
      );
    });

    it('rejects SELECT SYSTEM_USER FROM Users (bare identifier — column_ref, not function call)', () => {
      expect(() => validator.validateSelect('SELECT SYSTEM_USER FROM Users', ALLOWED)).toThrow(
        /reserved session-context name/i,
      );
    });

    // Positive control: a genuinely disallowed function call (os_command)
    // IS caught by the function allowlist.
    it('rejects SELECT os_command() FROM Users (function not on allowlist)', () => {
      expect(() => validator.validateSelect('SELECT os_command() FROM Users', ALLOWED)).toThrow(
        /function.*not in the analytics function allowlist/i,
      );
    });
  });

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
  });

  describe('rejects oversize input', () => {
    it('rejects SQL longer than 16384 chars', () => {
      const huge = 'SELECT * FROM Users WHERE id IN (' +
        Array.from({ length: 5000 }, (_, i) => i).join(',') + ')';
      expect(huge.length).toBeGreaterThan(16384);
      expect(() => validator.validateSelect(huge, ALLOWED)).toThrow(
        /exceeds maximum/i,
      );
    });
  });

  describe('rejects empty / whitespace input', () => {
    it('rejects empty string', () => {
      expect(() => validator.validateSelect('', ALLOWED)).toThrow(/empty or missing/i);
    });
    it('rejects whitespace-only string', () => {
      expect(() => validator.validateSelect('   \n\t  ', ALLOWED)).toThrow(/empty or missing/i);
    });
  });

  describe('accepts legitimate SELECTs', () => {
    it('accepts a plain SELECT', () => {
      const { sql, selectedColumns } = validator.validateSelect(
        'SELECT id, name FROM Users',
        ALLOWED,
      );
      expect(sql.toLowerCase()).toContain('select');
      expect(selectedColumns).toEqual(expect.arrayContaining(['id', 'name']));
    });
    it('accepts SELECT with allowlisted COUNT()', () => {
      expect(() => validator.validateSelect('SELECT COUNT(*) FROM Users', ALLOWED)).not.toThrow();
    });
    it('accepts SELECT with WHERE + literal', () => {
      expect(() => validator.validateSelect("SELECT id FROM Users WHERE name = 'x'", ALLOWED)).not.toThrow();
    });

    it('accepts SELECT CURRENT_DATE() FROM Users (function form works)', () => {
      // Pins the bare-vs-function precision. The MySQL parser classifies
      // both bare CURRENT_DATE and CURRENT_DATE() as `function` AST nodes,
      // so they flow through the function-allowlist path — where CURRENT_DATE
      // is on ALLOWED_FUNCTIONS.
      expect(() => validator.validateSelect('SELECT CURRENT_DATE() FROM Users', ALLOWED)).not.toThrow();
    });

    it('accepts SELECT CURRENT_DATE FROM Users (bare form ALSO parsed as function)', () => {
      // Documents the belt-and-suspenders overlap between ALLOWED_FUNCTIONS
      // and DENIED_BARE_IDENTIFIERS for date/time registers: today's parser
      // classifies bare CURRENT_DATE as `function`, so the denylist entry is
      // dormant. If a future parser upgrade flips the classification to
      // column_ref, this test starts failing — flag to human, remove
      // CURRENT_DATE from DENIED_BARE_IDENTIFIERS since it returns
      // non-sensitive data.
      expect(() => validator.validateSelect('SELECT CURRENT_DATE FROM Users', ALLOWED)).not.toThrow();
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
  });
});
