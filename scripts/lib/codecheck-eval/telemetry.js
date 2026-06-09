// Pure helpers for pull-codecheck-telemetry.cjs.
//
// HANA caveat: db.run returns rows with column names upper-cased unless
// quoted-aliased. We aim for portability by accepting either case in
// shapeResults; tests cover the upper-case path because it's the HANA shape.

const TABLE = 'COM_SAP_DEVELOPERS_IMS_CODECHECKSUBMISSIONS';

export function buildQueries(sinceIso) {
  return {
    verdictDistribution: {
      sql: `SELECT verdict, COUNT(*) AS n FROM ${TABLE}
            WHERE createdAt >= ? GROUP BY verdict`,
      params: [sinceIso],
    },
    latency: {
      sql: `SELECT
              MIN(latencyMs) AS p_min,
              PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latencyMs) AS p50,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latencyMs) AS p95,
              PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latencyMs) AS p99,
              MAX(latencyMs) AS p_max
            FROM ${TABLE}
            WHERE createdAt >= ? AND latencyMs IS NOT NULL`,
      params: [sinceIso],
    },
    tokens: {
      sql: `SELECT
              AVG(promptTokens)     AS avg_prompt,
              AVG(completionTokens) AS avg_completion,
              SUM(promptTokens + completionTokens) AS total_tokens,
              COUNT(*)              AS n_with_tokens
            FROM ${TABLE}
            WHERE createdAt >= ? AND promptTokens IS NOT NULL`,
      params: [sinceIso],
    },
    errors: {
      sql: `SELECT errorReason, COUNT(*) AS n FROM ${TABLE}
            WHERE createdAt >= ? AND verdict = 'error'
            GROUP BY errorReason`,
      params: [sinceIso],
    },
    perStepCoverage: {
      sql: `SELECT tutorialSlug, stepNumber, verdict, COUNT(*) AS n FROM ${TABLE}
            WHERE createdAt >= ?
            GROUP BY tutorialSlug, stepNumber, verdict
            ORDER BY tutorialSlug, stepNumber, verdict`,
      params: [sinceIso],
    },
  };
}

// Tiny case-insensitive lookup for HANA's UPPERCASE shape.
function pick(row, key) {
  if (!row) return null;
  if (row[key] !== undefined) return row[key];
  const upper = key.toUpperCase();
  if (row[upper] !== undefined) return row[upper];
  return null;
}

export function shapeResults(raw, sinceIso) {
  const verdictDistribution = (raw.verdictDistribution || []).map(r => ({
    verdict: pick(r, 'verdict'),
    n: Number(pick(r, 'n')) || 0,
  }));
  const latRow = (raw.latency || [])[0] || {};
  const latency = {
    p_min: pick(latRow, 'p_min'),
    p50:   pick(latRow, 'p50'),
    p95:   pick(latRow, 'p95'),
    p99:   pick(latRow, 'p99'),
    p_max: pick(latRow, 'p_max'),
  };
  const tokRow = (raw.tokens || [])[0] || {};
  const tokens = {
    avg_prompt:     pick(tokRow, 'avg_prompt'),
    avg_completion: pick(tokRow, 'avg_completion'),
    total_tokens:   pick(tokRow, 'total_tokens'),
    n_with_tokens:  Number(pick(tokRow, 'n_with_tokens')) || 0,
  };
  const errors = (raw.errors || []).map(r => ({
    errorReason: pick(r, 'errorReason'),
    n: Number(pick(r, 'n')) || 0,
  }));
  const perStepCoverage = (raw.perStepCoverage || []).map(r => ({
    tutorialSlug: pick(r, 'tutorialSlug'),
    stepNumber:   Number(pick(r, 'stepNumber')) || 0,
    verdict:      pick(r, 'verdict'),
    n:            Number(pick(r, 'n')) || 0,
  }));
  return { since: sinceIso, verdictDistribution, latency, tokens, errors, perStepCoverage };
}

export function formatMarkdown(out) {
  const lines = [];
  lines.push(`## Code-check telemetry (since ${out.since})`);
  lines.push('');
  lines.push('### Verdict distribution');
  lines.push('| verdict | n |');
  lines.push('|---|---|');
  for (const r of out.verdictDistribution) lines.push(`| ${r.verdict} | ${r.n} |`);
  if (out.verdictDistribution.length === 0) lines.push('| _(no rows)_ | 0 |');
  lines.push('');
  lines.push('### Latency (ms)');
  lines.push(`p_min: ${out.latency.p_min} · p50: ${out.latency.p50} · p95: ${out.latency.p95} · p99: ${out.latency.p99} · p_max: ${out.latency.p_max}`);
  lines.push('');
  lines.push('### Tokens');
  lines.push(`avg_prompt: ${out.tokens.avg_prompt} · avg_completion: ${out.tokens.avg_completion} · total: ${out.tokens.total_tokens} · n_with_tokens: ${out.tokens.n_with_tokens}`);
  lines.push('');
  lines.push('### Errors');
  lines.push('| errorReason | n |');
  lines.push('|---|---|');
  for (const r of out.errors) lines.push(`| ${r.errorReason} | ${r.n} |`);
  if (out.errors.length === 0) lines.push('| _(none)_ | 0 |');
  lines.push('');
  lines.push('### Per-step coverage');
  lines.push('| slug | step | verdict | n |');
  lines.push('|---|---|---|---|');
  for (const r of out.perStepCoverage) lines.push(`| ${r.tutorialSlug} | ${r.stepNumber} | ${r.verdict} | ${r.n} |`);
  if (out.perStepCoverage.length === 0) lines.push('| _(no rows)_ | | | 0 |');
  return lines.join('\n');
}
