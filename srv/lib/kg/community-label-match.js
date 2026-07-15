// srv/lib/kg/community-label-match.js
// Pure, deterministic topic → community-label resolution (#1173).
// Primary path: the LLM picks a label from the injected catalog and passes it
// as matchedLabel → we exact-match (case-insensitive). Fallback: token-overlap
// scoring on the learner's raw topic against label+rationale, used when the
// model forgot to echo the label or the catalog layer was omitted.
// No DB, no I/O — unit-testable in isolation.

const AMBIGUITY_MARGIN = 0.0; // top-2 tie (equal score) → ambiguous; widen if needed
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with']);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length > 1 && !STOPWORDS.has(t));
}

/**
 * @param {object} inp
 * @param {string} inp.topic          - learner's raw phrasing
 * @param {string} [inp.matchedLabel] - label the LLM picked from the catalog
 * @param {Array<{communityFingerprint:string,label:string,rationale?:string}>} inp.labels
 * @returns {{fingerprint?:string,label?:string,rationale?:string,reason?:string,candidates?:Array<{label:string}>}}
 */
export function matchLabel({ topic, matchedLabel, labels }) {
  const rows = Array.isArray(labels) ? labels.filter((r) => r && r.label && r.communityFingerprint) : [];
  if (rows.length === 0) return { reason: 'no-match' };

  // 1. Exact case-insensitive match on the model-supplied label.
  if (typeof matchedLabel === 'string' && matchedLabel.trim()) {
    const want = matchedLabel.trim().toLowerCase();
    const hit = rows.find((r) => r.label.toLowerCase() === want);
    if (hit) return { fingerprint: hit.communityFingerprint, label: hit.label, rationale: hit.rationale };
  }

  // 2. Token-overlap fallback on the raw topic vs each label (+ rationale).
  const topicTokens = new Set(tokenize(topic));
  if (topicTokens.size === 0) return { reason: 'no-match' };

  const scored = rows
    .map((r) => {
      const labelTokens = new Set([...tokenize(r.label), ...tokenize(r.rationale)]);
      let overlap = 0;
      for (const t of topicTokens) if (labelTokens.has(t)) overlap++;
      return { row: r, score: overlap };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { reason: 'no-match' };
  if (scored.length === 1 || scored[0].score - scored[1].score > AMBIGUITY_MARGIN) {
    const r = scored[0].row;
    return { fingerprint: r.communityFingerprint, label: r.label, rationale: r.rationale };
  }
  // Tie within margin → ambiguous.
  return {
    reason: 'ambiguous',
    candidates: [{ label: scored[0].row.label }, { label: scored[1].row.label }],
  };
}

export default { matchLabel };
