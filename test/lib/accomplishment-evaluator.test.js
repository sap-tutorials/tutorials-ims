import { describe, it, expect, vi } from 'vitest';
import { evaluateRules, validateRule } from '../../srv/lib/accomplishment-evaluator.js';

describe('accomplishment-evaluator', () => {

  describe('validateRule', () => {
    it('accepts a valid SELECT statement', () => {
      const rule = "SELECT COUNT(*) as score FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS WHERE USER_ID = ? AND STATUS = 'COMPLETED' AND TASKTYPE = 'TUTORIAL' HAVING COUNT(*) >= 5";
      expect(validateRule(rule)).toBe(true);
    });

    it('rejects INSERT statements', () => {
      expect(validateRule("INSERT INTO foo VALUES (1)")).toBe(false);
    });

    it('rejects UPDATE statements', () => {
      expect(validateRule("UPDATE foo SET bar = 1")).toBe(false);
    });

    it('rejects DELETE statements', () => {
      expect(validateRule("DELETE FROM foo")).toBe(false);
    });

    it('rejects DROP statements', () => {
      expect(validateRule("DROP TABLE foo")).toBe(false);
    });

    it('rejects multiple statements (semicolons)', () => {
      expect(validateRule("SELECT 1; DROP TABLE foo")).toBe(false);
    });

    it('rejects empty rules', () => {
      expect(validateRule("")).toBe(false);
      expect(validateRule(null)).toBe(false);
    });
  });

  describe('evaluateRules', () => {
    it('returns awarded accomplishment IDs when score is 100', async () => {
      const mockDb = {
        run: vi.fn()
          .mockResolvedValueOnce([{ score: 100 }])
          .mockResolvedValueOnce([{ score: 50 }])
      };
      const accomplishments = [
        { ID: 'acc-1', rule: "SELECT 100 as score FROM DUMMY WHERE EXISTS (SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS WHERE USER_ID = ?)" },
        { ID: 'acc-2', rule: "SELECT 50 as score FROM DUMMY" }
      ];

      const result = await evaluateRules(accomplishments, 'user-id-123', mockDb);
      expect(result).toEqual(['acc-1']);
    });

    it('returns empty array when no rules pass', async () => {
      const mockDb = {
        run: vi.fn().mockResolvedValue([{ score: 0 }])
      };
      const accomplishments = [
        { ID: 'acc-1', rule: "SELECT 0 as score FROM DUMMY" }
      ];

      const result = await evaluateRules(accomplishments, 'user-id-123', mockDb);
      expect(result).toEqual([]);
    });

    it('skips accomplishments with invalid rules', async () => {
      const mockDb = { run: vi.fn() };
      const accomplishments = [
        { ID: 'acc-1', rule: "DELETE FROM foo" }
      ];

      const result = await evaluateRules(accomplishments, 'user-id-123', mockDb);
      expect(result).toEqual([]);
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    it('handles SQL execution errors gracefully', async () => {
      const mockDb = {
        run: vi.fn().mockRejectedValue(new Error('SQL syntax error'))
      };
      const accomplishments = [
        { ID: 'acc-1', rule: "SELECT 100 as score FROM NONEXISTENT" }
      ];

      const result = await evaluateRules(accomplishments, 'user-id-123', mockDb);
      expect(result).toEqual([]);
    });
  });
});
