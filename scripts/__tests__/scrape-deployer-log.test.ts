import { describe, it, expect } from 'vitest';

import helpersDefault from '../lib/deployer-log-helpers.cjs';
const { scan } = helpersDefault as {
  scan: (logs: string) => Array<{ lineNumber: number; severity: 'CRITICAL' | 'WARNING'; description: string; excerpt: string }>;
};

describe('scrape-deployer-log helpers', () => {
  describe('scan', () => {
    it('returns empty for an unremarkable log', () => {
      const log = [
        '2026-06-05T10:00:00 [APP/PROC/WEB/0] OUT Starting',
        '2026-06-05T10:00:01 [APP/PROC/WEB/0] OUT 0 modified or added files are scheduled for deploy',
        '2026-06-05T10:00:02 [APP/PROC/WEB/0] OUT Deployment ended at 2026-06-05 10:00:02',
        '2026-06-05T10:00:03 [APP/PROC/WEB/0] OUT Exit status 0',
      ].join('\n');
      expect(scan(log)).toEqual([]);
    });

    it('flags the actual 2026-06-05 Rolled back line as CRITICAL', () => {
      const log = '2026-06-05T18:21:35.44-0400 [APP/PROC/WEB/0] OUT Previous build with request ID 1143 finished at 2026-06-05T22:05:08.692 with status Rolled back and message: ...';
      const findings = scan(log);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
      expect(findings[0].description).toContain('rolled back');
    });

    it('flags TABLE_REPLACE as CRITICAL', () => {
      const log = '2026-06-05T10:00:00 [APP/PROC/WEB/0] OUT Performing TABLE_REPLACE on COM_SAP_DEVELOPERS_IMS_MISSIONS';
      const findings = scan(log);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('flags DROP TABLE as CRITICAL', () => {
      const log = '2026-06-05T10:00:00 [APP/PROC/WEB/0] OUT DROP TABLE COM_SAP_DEVELOPERS_IMS_MISSIONS';
      const findings = scan(log);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('flags non-empty Files to undeploy as CRITICAL', () => {
      const log = '2026-06-05T10:00:00 [APP/PROC/WEB/0] OUT Files to undeploy: [src/gen/X.hdbtable, src/gen/Y.hdbtable]';
      const findings = scan(log);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('does NOT flag Files to undeploy when list is empty', () => {
      const log = '2026-06-05T10:00:00 [APP/PROC/WEB/0] OUT Files to undeploy: []';
      const findings = scan(log);
      expect(findings).toEqual([]);
    });

    it('flags non-zero deleted-files count as WARNING (not critical)', () => {
      const log = '2026-06-05T10:00:00 [APP/PROC/WEB/0] OUT 5 deleted files are scheduled for undeploy';
      const findings = scan(log);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('WARNING');
    });

    it('does NOT flag zero deleted-files count', () => {
      const log = '2026-06-05T10:00:00 [APP/PROC/WEB/0] OUT 0 deleted files are scheduled for undeploy';
      const findings = scan(log);
      expect(findings).toEqual([]);
    });

    it('flags deleted-files-not-in-undeploy.json as WARNING', () => {
      const log = '2026-06-05T10:00:00 [APP/PROC/WEB/0] OUT WARNING: deleted files not in undeploy.json: [src/gen/X.hdbview]';
      const findings = scan(log);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('WARNING');
    });

    it('reports correct line numbers (1-indexed)', () => {
      const log = [
        'line 1 noise',
        'line 2 noise',
        '2026-06-05T10:00:00 [APP/PROC/WEB/0] OUT status Rolled back',
        'line 4 noise',
      ].join('\n');
      const findings = scan(log);
      expect(findings).toHaveLength(1);
      expect(findings[0].lineNumber).toBe(3);
    });

    it('truncates long excerpts to 240 chars', () => {
      const longLine = '2026-06-05T10:00:00 [APP/PROC/WEB/0] OUT TABLE_REPLACE ' + 'A'.repeat(500);
      const findings = scan(longLine);
      expect(findings[0].excerpt.length).toBeLessThanOrEqual(240);
    });

    it('finds multiple findings in a multi-line log (the actual 2026-06-05 case)', () => {
      const log = [
        '2026-06-05T18:21:35.44-0400 OUT Previous build with request ID 1143 status Rolled back',
        '2026-06-05T18:21:36.20-0400 OUT 5 deleted files are scheduled for undeploy',
        '2026-06-05T18:21:36.20-0400 OUT WARNING: deleted files not in undeploy.json: [...]',
      ].join('\n');
      const findings = scan(log);
      expect(findings).toHaveLength(3);
      const severities = findings.map(f => f.severity);
      expect(severities).toEqual(['CRITICAL', 'WARNING', 'WARNING']);
    });
  });
});
