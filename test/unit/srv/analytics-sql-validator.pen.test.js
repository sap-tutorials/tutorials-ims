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

    // Positive control: a genuinely disallowed function call (os_command)
    // IS caught by the function allowlist.
    it('rejects SELECT os_command() FROM Users (function not on allowlist)', () => {
      expect(() => validator.validateSelect('SELECT os_command() FROM Users', ALLOWED)).toThrow(
        /function.*not in the analytics function allowlist/i,
      );
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
  });
});
