/**
 * Pure helpers for scrape-deployer-log.cjs — extracted for unit-testing.
 * No CF / fs side-effects here.
 */
'use strict';

// Patterns ordered by severity. Each entry: [regex, severity, description]
const PATTERNS = [
  [/Rolled back/i,                                 'CRITICAL', 'Previous build was rolled back — schema may be in an inconsistent state'],
  [/Files to undeploy:\s*\[(?:[^\]]*[^\s\]])+\]/i, 'CRITICAL', 'Explicit undeploy list is non-empty — listed artifacts WILL be dropped'],
  [/TABLE_REPLACE/i,                               'CRITICAL', 'TABLE_REPLACE operation — table data is being replaced (potential data loss)'],
  [/DROP TABLE/i,                                  'CRITICAL', 'Direct DROP TABLE issued by HDI — table data is being deleted'],
  [/deleted files not in undeploy\.json/i,         'WARNING',  'Schema artifacts removed without being in undeploy.json allowlist'],
  [/Container\s+.*?\s+is\s+being\s+rebuilt/i,      'WARNING',  'Full container rebuild in progress'],
  [/[1-9][0-9]* deleted files are scheduled/i,     'WARNING',  'Non-zero deleted files scheduled for undeploy'],
];

/**
 * Scan log text for danger patterns.
 * @param {string} logs — raw log text
 * @returns {Array<{lineNumber, severity, description, excerpt}>}
 */
function scan(logs) {
  const findings = [];
  const lines = logs.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [re, severity, description] of PATTERNS) {
      if (re.test(line)) {
        findings.push({
          lineNumber: i + 1,
          severity,
          description,
          excerpt: line.trim().slice(0, 240),
        });
      }
    }
  }
  return findings;
}

module.exports = { PATTERNS, scan };
