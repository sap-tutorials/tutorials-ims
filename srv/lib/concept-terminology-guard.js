// srv/lib/concept-terminology-guard.js
//
// #2426: SAP renames product terminology over time (e.g. "Open SQL" → "ABAP
// SQL"), but LLM-extracted concept text — trained on older material — keeps
// emitting the deprecated form. This is exactly the failure a reviewer flagged
// on /concepts/abap-open-sql/. The concept-definition generator
// (concept-definition-extract.js) runs every generated definition through
// validateTerminology() and HARD-REJECTS any that contains a stale term, so
// deprecated terminology can never reach even a DRAFT description.
//
// Data-driven and small on purpose: add a row here when SAP renames something.
// Each entry maps a stale term (word-boundary regex) to its current canonical
// form; `concept` is the slug most associated with the rename (informational).

export const STALE_TERMS = Object.freeze([
  { staleRe: /\bopen sql\b/i, stale: 'Open SQL', canonical: 'ABAP SQL', concept: 'abap-open-sql' },
]);

/**
 * Check a piece of text for deprecated SAP terminology.
 *
 * @param {string} text
 * @returns {{ ok: boolean, violations: Array<{stale: string, canonical: string}> }}
 *   ok=true when no stale term is present. violations lists each match with the
 *   canonical replacement the author should have used.
 */
export function validateTerminology(text) {
  const s = String(text ?? '');
  const violations = [];
  for (const t of STALE_TERMS) {
    if (t.staleRe.test(s)) {
      violations.push({ stale: t.stale, canonical: t.canonical });
    }
  }
  return { ok: violations.length === 0, violations };
}
