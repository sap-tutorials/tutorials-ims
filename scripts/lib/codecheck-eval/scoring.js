// Pure helpers for score-codecheck-eval.js. No fs, no process, no cds.
// Designed to be importable by Vitest with zero setup.

const KNOWN_VERDICTS = ['pass', 'partial', 'fail'];

/**
 * Minimal CSV parser tuned to the harness's escapeCell shape:
 * cells containing comma/newline/quote are wrapped in double quotes and
 * inner quotes are doubled. No backslash escaping, no Excel quirks.
 */
export function parseCsv(text) {
  const rows = [];
  let cur = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cell += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { cur.push(cell); cell = ''; }
      else if (c === '\n') { cur.push(cell); rows.push(cur); cur = []; cell = ''; }
      else if (c === '\r') { /* ignore */ }
      else { cell += c; }
    }
  }
  if (cell.length > 0 || cur.length > 0) { cur.push(cell); rows.push(cur); }

  if (rows.length === 0) throw new Error('CSV is empty.');
  const header = rows[0];
  if (!header.includes('agree')) {
    throw new Error('CSV is missing the "agree" column. Add it (TRUE/FALSE/PARTIAL) before scoring.');
  }
  const dataRows = rows.slice(1)
    .filter(r => r.length === header.length)  // drop trailing-newline empty row
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  return { header, rows: dataRows };
}

/**
 * Compute headline + strict agreement, EXCEPTION count, 3x3 confusion matrix.
 * Throws with a row reference if `agree` has an unknown value.
 */
export function scoreRows(rows) {
  const allowed = new Set(['TRUE', 'FALSE', 'PARTIAL']);
  let trueN = 0, partialN = 0, exceptionN = 0;
  const confusion = {
    pass:    { pass: 0, partial: 0, fail: 0 },
    partial: { pass: 0, partial: 0, fail: 0 },
    fail:    { pass: 0, partial: 0, fail: 0 },
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const v = (r.agree || '').toUpperCase();
    if (!allowed.has(v)) {
      throw new Error(`Row ${i + 2}: unknown agree value "${r.agree}". Use TRUE / FALSE / PARTIAL.`);
    }
    if (v === 'TRUE') trueN++;
    if (v === 'PARTIAL') partialN++;
    if (r.actual === 'EXCEPTION') exceptionN++;
    if (KNOWN_VERDICTS.includes(r.expected) && KNOWN_VERDICTS.includes(r.actual)) {
      confusion[r.expected][r.actual]++;
    }
  }

  const total = rows.length;
  return {
    total,
    headlinePct: total === 0 ? 0 : (trueN + partialN) / total,
    strictPct:   total === 0 ? 0 : trueN / total,
    exceptionCount: exceptionN,
    confusion,
  };
}

export function formatMarkdown(scores, slug, stepNumber) {
  const { total, headlinePct, strictPct, exceptionCount, confusion } = scores;
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const c = confusion;
  return [
    `## ${slug} step ${stepNumber}`,
    '',
    `- **n:** ${total}`,
    `- **Headline (TRUE+PARTIAL):** ${pct(headlinePct)}`,
    `- **Strict (TRUE only):** ${pct(strictPct)}`,
    `- **Exceptions:** ${exceptionCount}`,
    '',
    '### Confusion matrix (rows = expected, cols = actual)',
    '',
    '| | pass | partial | fail |',
    '|---|---|---|---|',
    `| pass    | ${c.pass.pass} | ${c.pass.partial} | ${c.pass.fail} |`,
    `| partial | ${c.partial.pass} | ${c.partial.partial} | ${c.partial.fail} |`,
    `| fail    | ${c.fail.pass} | ${c.fail.partial} | ${c.fail.fail} |`,
    '',
  ].join('\n');
}
