// srv/lib/relevance-keyword-rules.js
//
// Fallback classifier for when embedding + LLM paths both fail (or seeds
// are empty, or the daily LLM budget is exhausted). Word-boundary matched,
// case-insensitive. Token lists are code-owned; tune via PR. (#1034)

export const ALLOWLIST = [
  'API', 'APIs', 'SDK', 'CLI', 'CAP', 'BTP', 'HANA', 'Fiori', 'UI5', 'ABAP',
  'Node', 'Java', 'TypeScript', 'Python', 'code', 'sample', 'tutorial',
  'walkthrough', 'deploy', 'Kubernetes', 'Kyma', 'AI Core', 'AI Foundation',
  'AI SDK', 'Cloud SDK', 'SAP Build', 'developer',
];

export const BLOCKLIST = [
  'earnings', 'Q1', 'Q2', 'Q3', 'Q4', 'revenue', 'guidance', 'CEO', 'CFO',
  'partnership', 'sponsorship', 'celebrate', 'celebrates', 'celebrated', 'celebrating', 'celebration', 'award', 'champion of the year',
  'HR', 'board of directors',
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegex(tokens) {
  // \b word boundary works for tokens composed of \w chars; for tokens that
  // contain spaces (e.g. 'AI Core', 'champion of the year') we anchor on
  // whitespace boundaries as well.
  const alternation = tokens.map(t => {
    const esc = escapeRegex(t);
    return `\\b${esc}\\b`;
  }).join('|');
  return new RegExp(`(${alternation})`, 'i');
}

const ALLOW_RE = buildRegex(ALLOWLIST);
const BLOCK_RE = buildRegex(BLOCKLIST);

/** @param {{title?: string, description?: string|null}} args */
export function classifyByKeywords({ title, description }) {
  const hay = `${title ?? ''} ${description ?? ''}`;
  const blockHit = hay.match(BLOCK_RE);
  if (blockHit) {
    return {
      verdict: 'not-relevant',
      reason: `Matched blocklist token "${blockHit[1]}"`,
    };
  }
  const allowHit = hay.match(ALLOW_RE);
  if (allowHit) {
    return {
      verdict: 'relevant',
      reason: `Matched allowlist token "${allowHit[1]}"`,
    };
  }
  return {
    verdict: 'not-relevant',
    reason: 'No allowlist tokens matched',
  };
}
