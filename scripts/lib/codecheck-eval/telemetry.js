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
    latencyMinMax: {
      sql: `SELECT MIN(latencyMs) AS p_min, MAX(latencyMs) AS p_max
            FROM ${TABLE}
            WHERE createdAt >= ? AND latencyMs IS NOT NULL`,
      params: [sinceIso],
    },
    // [#319] HANA's PERCENTILE_CONT(...) WITHIN GROUP (...) is a window
    // function and requires OVER (). Combining it with MIN/MAX in the same
    // SELECT errors with "invalid column name" because window-function
    // output is per-row while MIN/MAX want a grouped scalar. Split the two
    // queries; shapeResults merges them back into one `latency` block.
    //
    // SELECT TOP 1 (HANA dialect) keeps a single row; PERCENTILE_CONT OVER ()
    // returns the same value on every row so any row works.
    latencyPercentiles: {
      sql: `SELECT TOP 1
              PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latencyMs) OVER () AS p50,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latencyMs) OVER () AS p95,
              PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latencyMs) OVER () AS p99
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
  // [#319] Latency lives in two queries (see buildQueries comment) — merge.
  // Backwards-compat: if a caller passes the legacy `latency` key (single
  // row with all five fields), use that instead.
  const latRow = (raw.latency || raw.latencyMinMax || [])[0] || {};
  const pctRow = (raw.latencyPercentiles || raw.latency || [])[0] || {};
  const latency = {
    p_min: pick(latRow, 'p_min'),
    p50:   pick(pctRow, 'p50'),
    p95:   pick(pctRow, 'p95'),
    p99:   pick(pctRow, 'p99'),
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
