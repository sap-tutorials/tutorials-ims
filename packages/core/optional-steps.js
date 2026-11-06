// [tutorial-step-pacing] Shared helper for Tutorials.optionalSteps, a
// comma-joined list of step numbers (stepOrder) whose heading carried an
// `{optional}` attribute (scripts/parsers/step-attrs.ts), written by
// packages/content/content-publish-session.js at publish time.
//
// Consumers:
//   - srv/developer-service.js (live completion denominator — a tutorial is
//     COMPLETED once all NON-optional steps are done)
//   - packages/content/recompute-tutorial-progress-bulk-sql.js (SQLite
//     recheck path — same required-step denominator)

/**
 * Parse Tutorials.optionalSteps into a Set<number>. Fail-open: returns an
 * empty Set for null/empty/malformed input so a tutorial that doesn't use
 * the `{optional}` syntax is completely unaffected.
 */
export function parseOptionalSteps(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return new Set();
  return new Set(
    raw.split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0)
  );
}
