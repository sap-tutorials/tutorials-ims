# AI Code-Check Phase 4 Evaluation Prep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the operator-side scaffolding (runbook + 3 scripts + seed JSON + decision template + sidebar entry) that unblocks the post-deploy Phase 4 evaluation cycle for the AI code-check spike (#171).

**Architecture:** Three small Node scripts + four docs/data files + one one-line edit. Script logic is split into pure-function `scripts/lib/codecheck-eval/*.js` helpers (importable by Vitest without mocking `@sap/cds`) and CLI wrapper files. No production code paths touched.

**Tech Stack:** Node.js (CJS for cds-bind scripts, ESM for pure helpers), Vitest, VitePress, SAP CAP, HANA SQL, JSONL, CSV.

**Spec:** [docs/superpowers/specs/2026-06-07-ai-code-check-phase-4-evaluation-prep-design.md](../specs/2026-06-07-ai-code-check-phase-4-evaluation-prep-design.md)

**Branch:** `feat/210-codecheck-phase4-prep` (already cut from main; spec doc already committed at 0567649)

**Refs:** issue #210, follow-up to PR #205 (issue #171)

---

## File Structure

| Path | Kind | Created in task |
|---|---|---|
| `scripts/lib/codecheck-eval/skeleton.js` | ESM helper | T1 |
| `test/unit/codecheck-eval-skeleton.test.js` | unit test | T1 |
| `scripts/generate-codecheck-eval-skeleton.cjs` | CLI entry (cds-bind) | T2 |
| `scripts/lib/codecheck-eval/scoring.js` | ESM helper | T3 |
| `test/unit/codecheck-eval-scoring.test.js` | unit test | T3 |
| `scripts/score-codecheck-eval.js` | CLI entry (pure I/O) | T4 |
| `scripts/lib/codecheck-eval/telemetry.js` | ESM helper (SQL strings + JSON shaping) | T5 |
| `test/unit/codecheck-eval-telemetry.test.js` | unit test | T5 |
| `scripts/pull-codecheck-telemetry.cjs` | CLI entry (cds-bind) | T6 |
| `scripts/sample-submissions/seed-saved-queries.json` | seed data | T7 |
| `scripts/seed-codecheck-saved-queries.cjs` | CLI importer (cds-bind) | T7 |
| `docs/developers/operations/phase-4-codecheck-eval.md` | runbook | T8 |
| `docs/superpowers/specs/phase-4-codecheck-evaluation.md` | decision template | T9 |
| `docs/.vitepress/config.ts` | edit (1 line) | T8 |

Library boundary: every CLI script imports from `scripts/lib/codecheck-eval/`. The lib is pure functions over plain data; tests import directly. CLI scripts handle arg parsing, `cds.connect`, file I/O, and console output — they're thin shells around the lib.

---

## Task 1: Skeleton library + tests

**Files:**
- Create: `scripts/lib/codecheck-eval/skeleton.js`
- Create: `test/unit/codecheck-eval-skeleton.test.js`

The lib exports two pure functions: `buildHintTable()` returning the fixed 30-row plan, and `formatJsonl(rows)` joining objects into JSONL text. Both have zero dependencies, so the test imports them directly.

- [ ] **Step 1.1: Write failing test**

Create `test/unit/codecheck-eval-skeleton.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildHintTable, formatJsonl } from '../../scripts/lib/codecheck-eval/skeleton.js';

describe('buildHintTable', () => {
  it('emits exactly 30 rows in id order s001..s030', () => {
    const rows = buildHintTable();
    expect(rows).toHaveLength(30);
    expect(rows[0].id).toBe('s001');
    expect(rows[29].id).toBe('s030');
    for (let i = 0; i < 30; i++) {
      const padded = String(i + 1).padStart(3, '0');
      expect(rows[i].id).toBe(`s${padded}`);
    }
  });

  it('splits 10/10/10 across pass/partial/fail', () => {
    const rows = buildHintTable();
    expect(rows.slice(0, 10).every(r => r.expectedVerdict === 'pass')).toBe(true);
    expect(rows.slice(10, 20).every(r => r.expectedVerdict === 'partial')).toBe(true);
    expect(rows.slice(20, 30).every(r => r.expectedVerdict === 'fail')).toBe(true);
  });

  it('every row has a non-empty _hint and an empty code', () => {
    for (const r of buildHintTable()) {
      expect(typeof r._hint).toBe('string');
      expect(r._hint.length).toBeGreaterThan(0);
      expect(r.code).toBe('');
    }
  });
});

describe('formatJsonl', () => {
  it('emits one valid JSON object per line and a trailing newline', () => {
    const text = formatJsonl([{ a: 1 }, { b: 2 }]);
    const lines = text.split('\n');
    // Trailing newline → split has an empty final element
    expect(lines.at(-1)).toBe('');
    const dataLines = lines.slice(0, -1);
    expect(dataLines).toHaveLength(2);
    expect(JSON.parse(dataLines[0])).toEqual({ a: 1 });
    expect(JSON.parse(dataLines[1])).toEqual({ b: 2 });
  });
});
```

- [ ] **Step 1.2: Run test, verify it fails**

Run: `npx vitest run test/unit/codecheck-eval-skeleton.test.js`
Expected: FAIL — module not found.

- [ ] **Step 1.3: Implement `scripts/lib/codecheck-eval/skeleton.js`**

```js
// Pure helpers for generate-codecheck-eval-skeleton.cjs.
// No I/O, no cds, no fs — kept pure so unit tests can import directly.

const PASS_HINTS = [
  'a correct, idiomatic solution',
  'a correct but more verbose solution',
  'a correct solution in a different style',
  'a correct solution that uses the imports the author shows in the step',
  'a correct solution with different variable naming',
  'a correct solution with explanatory comments',
  'a correct solution using an early-return variant',
  'a correct solution using destructuring or modern syntax',
  'a minimal correct solution (smallest passing form)',
  'a near-copy of the author reference solution',
];

const PARTIAL_HINTS = [
  'a near-miss missing an `await`',
  'an off-by-one error',
  'wrong error handling but right happy-path logic',
  'right happy-path logic but missing an obvious edge case',
  'a harmless syntax issue but logic is right',
  'uses a deprecated-but-correct API',
  'missing input validation',
  'correct but uses confusingly wrong naming',
  'right shape but wrong helper function chosen',
  'correct logic surrounded by extraneous unrelated code',
];

const FAIL_HINTS = [
  'an off-topic poem or non-code English text',
  'an empty string',
  'gibberish characters',
  'a submission in the wrong language (e.g. Python when JS is expected)',
  'opposite logic — does the inverse of the goal',
  'a copy of the prompt or task description instead of code',
  'correct code but for a different step in the same tutorial',
  'a SQL-injection-shaped payload (must not pass)',
  'placeholder TODO comments only',
  'literal `null` or undefined-ish nonsense',
];

export function buildHintTable() {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ id: `s${String(i + 1).padStart(3, '0')}`, expectedVerdict: 'pass', code: '', _hint: PASS_HINTS[i] });
  }
  for (let i = 0; i < 10; i++) {
    rows.push({ id: `s${String(i + 11).padStart(3, '0')}`, expectedVerdict: 'partial', code: '', _hint: PARTIAL_HINTS[i] });
  }
  for (let i = 0; i < 10; i++) {
    rows.push({ id: `s${String(i + 21).padStart(3, '0')}`, expectedVerdict: 'fail', code: '', _hint: FAIL_HINTS[i] });
  }
  return rows;
}

export function formatJsonl(rows) {
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n';
}
```

- [ ] **Step 1.4: Run test, verify it passes**

Run: `npx vitest run test/unit/codecheck-eval-skeleton.test.js`
Expected: PASS (3 cases).

- [ ] **Step 1.5: Commit**

```bash
git add scripts/lib/codecheck-eval/skeleton.js test/unit/codecheck-eval-skeleton.test.js
git commit -m "feat(codecheck): skeleton-eval lib + tests (#210)"
```

---

## Task 2: Skeleton CLI entry point

**Files:**
- Create: `scripts/generate-codecheck-eval-skeleton.cjs`

CJS because `cds bind --exec -- node` works most reliably with CJS for `cds.connect.to('db')`. The CLI is a thin wrapper around the lib from T1 plus DB-read + file-write.

- [ ] **Step 2.1: Write the script**

```js
/**
 * generate-codecheck-eval-skeleton.cjs — emit a 30-row JSONL skeleton for
 * Phase 4 of the AI code-check spike (#210, follow-up to #171, PR #205).
 *
 * Reads CodeCheckSpecs (server-only entity holding the author's goal +
 * reference solution) for one (slug, stepNumber) and writes a JSONL with
 * 30 stub rows. Each row has `id`, `expectedVerdict`, empty `code`, and an
 * `_hint` describing the kind of submission to write. The author fills in
 * the `code` strings using the `_hint` for coverage guidance. The eval
 * harness ignores extra keys, so `_hint` survives untouched into evaluation.
 *
 * Prerequisites:
 *   - `cf login` to the DEV space
 *   - `npx cds bind --to <hana-binding>` (creates .cdsrc-private.json)
 *   - The publish step has run since the author added the [CODECHECK_N] block.
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/generate-codecheck-eval-skeleton.cjs \
 *     --slug abap-environment-trial-onboarding --step 3
 *
 * Flags:
 *   --slug <s>         Required. Tutorial slug (lowercased internally).
 *   --step <n>         Required. Step number.
 *   --output <path>    Optional. Default: scripts/sample-submissions/<slug>-step-<n>.jsonl
 *   --force            Optional. Overwrite an existing output file.
 */

const cds = require('@sap/cds');
const { existsSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const slug = (arg('slug') || '').toLowerCase();
const stepNumber = Number(arg('step'));
const force = hasFlag('force');

if (!slug || !stepNumber) {
  console.error('Usage: --slug <slug> --step <n> [--output <path>] [--force]');
  process.exit(2);
}

const outputPath = arg('output', `scripts/sample-submissions/${slug}-step-${stepNumber}.jsonl`);

(async () => {
  if (existsSync(outputPath) && !force) {
    console.error(`Refusing to overwrite ${outputPath} (use --force).`);
    process.exit(1);
  }

  await cds.load('*');
  const db = await cds.connect.to('db');

  // Confirm a CodeCheckSpec exists. We don't need its contents in the JSONL —
  // the hints are template-driven. This is a sanity check so the operator
  // doesn't run the harness against a slug+step the publish step skipped.
  //
  // The `Association to Tutorials` flattens to `tutorial_ID` because Tutorials
  // keys on `ID : UUID` (TaskBase → cuid aspect, db/schema.cds:17). HANA
  // upper-cases unquoted identifiers, so the column is `TUTORIAL_ID`. Join
  // through Tutorials.slug to keep the CLI taking a slug instead of a UUID.
  const rows = await db.run(
    `SELECT s.GOAL FROM COM_SAP_DEVELOPERS_IMS_CODECHECKSPECS s
       JOIN COM_SAP_DEVELOPERS_IMS_TUTORIALS t ON t.ID = s.TUTORIAL_ID
      WHERE LOWER(t.SLUG) = ? AND s.STEPNUMBER = ?`,
    [slug, stepNumber]
  );
  if (!rows || rows.length === 0) {
    console.error(`No CodeCheckSpec for slug=${slug} step=${stepNumber}.`);
    console.error('Has the publish step run since the author added the [CODECHECK_N] block?');
    process.exit(1);
  }

  const { buildHintTable, formatJsonl } = await import('./lib/codecheck-eval/skeleton.js');
  const table = buildHintTable();
  const text = formatJsonl(table);

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, text);

  console.log(`Wrote ${table.length} rows to ${outputPath}`);
  console.log('Next steps:');
  console.log(`  1. Open ${outputPath} and fill in the "code" string on each row using "_hint" for coverage guidance.`);
  console.log('  2. Run scripts/evaluate-code-check.js against the filled-in JSONL.');
  process.exit(0);
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
```

Notes for the implementer:
- The CJS file uses dynamic `import()` to reach the ESM `lib/`. `setup-dev-data.cjs` does the same for `slug-utils.js`.
- `Tutorials` keys on `ID : UUID` ([db/schema.cds:17](../../db/schema.cds) — `TaskBase` → `cuid` aspect), so `Association to Tutorials` flattens to `TUTORIAL_ID` in HANA. The script joins through `Tutorials.SLUG` so the CLI takes the slug the author actually knows. `LOWER(t.SLUG)` matches the lowercased input.
- The script can't be unit-tested headlessly without mocking `@sap/cds`, so it has no test of its own. The lib in T1 covers the deterministic part. The script is exercised the first time Tom runs it for real.

- [ ] **Step 2.2: Sanity check (no test to run; lint + node syntax check)**

Run: `node --check scripts/generate-codecheck-eval-skeleton.cjs`
Expected: clean exit (no syntax error).

Run: `node scripts/generate-codecheck-eval-skeleton.cjs` (no flags)
Expected: prints usage and exits 2.

- [ ] **Step 2.3: Commit**

```bash
git add scripts/generate-codecheck-eval-skeleton.cjs
git commit -m "feat(codecheck): skeleton-eval CLI (#210)"
```

---

## Task 3: Scoring library + tests

**Files:**
- Create: `scripts/lib/codecheck-eval/scoring.js`
- Create: `test/unit/codecheck-eval-scoring.test.js`

`scripts/lib/codecheck-eval/scoring.js` exports three pure functions:

1. `parseCsv(text)` — minimal 3-state-machine parser tuned to the harness's `escapeCell` shape.
2. `scoreRows(parsed)` — returns `{ headlinePct, strictPct, exceptionCount, confusion }` from rows with an `agree` cell.
3. `formatMarkdown(scores, slug, stepNumber)` — renders the score result as a Markdown block.

EXCEPTION rows are counted by matching `actual === 'EXCEPTION'` (uppercase, source-faithful — the harness writes uppercase when `dispatchCheckCode` itself throws).

- [ ] **Step 3.1: Write failing test**

Create `test/unit/codecheck-eval-scoring.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parseCsv, scoreRows, formatMarkdown } from '../../scripts/lib/codecheck-eval/scoring.js';

const HEADER = 'submission_id,expected,actual,summary,latency_ms,prompt_tokens,completion_tokens,agree';

describe('parseCsv', () => {
  it('parses a simple row', () => {
    const text = `${HEADER}\ns001,pass,pass,"ok",1200,500,150,TRUE\n`;
    const parsed = parseCsv(text);
    expect(parsed.header).toEqual(HEADER.split(','));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toEqual({
      submission_id: 's001', expected: 'pass', actual: 'pass',
      summary: 'ok', latency_ms: '1200', prompt_tokens: '500',
      completion_tokens: '150', agree: 'TRUE',
    });
  });

  it('handles cells with embedded commas, quotes, and newlines', () => {
    const text = `${HEADER}\ns002,pass,partial,"hello, ""world""\nline2",1300,600,200,PARTIAL\n`;
    const parsed = parseCsv(text);
    expect(parsed.rows[0].summary).toBe('hello, "world"\nline2');
    expect(parsed.rows[0].agree).toBe('PARTIAL');
  });

  it('rejects missing agree column with a clear error', () => {
    const noAgree = HEADER.split(',').slice(0, -1).join(',');
    const text = `${noAgree}\ns001,pass,pass,"ok",1200,500,150\n`;
    expect(() => parseCsv(text)).toThrow(/agree/i);
  });
});

describe('scoreRows', () => {
  function row(over) {
    return { submission_id: 's', expected: 'pass', actual: 'pass', agree: 'TRUE', ...over };
  }
  it('computes headline = (TRUE+PARTIAL)/total and strict = TRUE/total', () => {
    const rows = [
      row({ agree: 'TRUE' }), row({ agree: 'TRUE' }),
      row({ agree: 'PARTIAL' }), row({ agree: 'FALSE' }),
    ];
    const s = scoreRows(rows);
    expect(s.headlinePct).toBeCloseTo(0.75);
    expect(s.strictPct).toBeCloseTo(0.5);
  });

  it('counts EXCEPTION rows by uppercase actual', () => {
    const rows = [
      row({ actual: 'EXCEPTION', agree: 'FALSE' }),
      row({ actual: 'pass', agree: 'TRUE' }),
    ];
    expect(scoreRows(rows).exceptionCount).toBe(1);
  });

  it('builds a 3x3 confusion matrix on expected x actual', () => {
    const rows = [
      row({ expected: 'pass',    actual: 'pass',    agree: 'TRUE' }),
      row({ expected: 'pass',    actual: 'partial', agree: 'PARTIAL' }),
      row({ expected: 'partial', actual: 'fail',    agree: 'FALSE' }),
      row({ expected: 'fail',    actual: 'fail',    agree: 'TRUE' }),
    ];
    const s = scoreRows(rows);
    expect(s.confusion.pass.pass).toBe(1);
    expect(s.confusion.pass.partial).toBe(1);
    expect(s.confusion.partial.fail).toBe(1);
    expect(s.confusion.fail.fail).toBe(1);
    expect(s.confusion.pass.fail).toBe(0);
  });

  it('rejects an unknown agree value', () => {
    const rows = [row({ agree: 'maybe' })];
    expect(() => scoreRows(rows)).toThrow(/agree/i);
  });
});

describe('formatMarkdown', () => {
  it('emits a Markdown block with both percentages and a confusion table', () => {
    const md = formatMarkdown(
      { headlinePct: 0.8, strictPct: 0.7, exceptionCount: 0, confusion: {
        pass: { pass: 8, partial: 1, fail: 1 },
        partial: { pass: 0, partial: 7, fail: 3 },
        fail:    { pass: 0, partial: 1, fail: 9 },
      } },
      'demo-slug', 3
    );
    expect(md).toMatch(/demo-slug.*step.*3/i);
    expect(md).toMatch(/Headline.*80\.0%/);
    expect(md).toMatch(/Strict.*70\.0%/);
    expect(md).toMatch(/Confusion/);
  });
});
```

- [ ] **Step 3.2: Run test, verify it fails**

Run: `npx vitest run test/unit/codecheck-eval-scoring.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement `scripts/lib/codecheck-eval/scoring.js`**

```js
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
```

- [ ] **Step 3.4: Run test, verify it passes**

Run: `npx vitest run test/unit/codecheck-eval-scoring.test.js`
Expected: PASS (8 cases).

- [ ] **Step 3.5: Commit**

```bash
git add scripts/lib/codecheck-eval/scoring.js test/unit/codecheck-eval-scoring.test.js
git commit -m "feat(codecheck): scoring lib + tests (#210)"
```

---

## Task 4: Score CLI entry point

**Files:**
- Create: `scripts/score-codecheck-eval.js`

ESM (.js) — pure file I/O, no cds, no need for cds-bind. Wires the lib from T3 to argv + stdin/stdout.

- [ ] **Step 4.1: Write the script**

```js
#!/usr/bin/env node
/**
 * score-codecheck-eval.js — compute agreement % from a hand-rated harness CSV.
 *
 * The author edits the CSV emitted by scripts/evaluate-code-check.js,
 * adds an `agree` column with values TRUE / FALSE / PARTIAL, then runs:
 *
 *   node scripts/score-codecheck-eval.js \
 *     --csv verdicts/abap-env-step-3.csv \
 *     --output verdicts/abap-env-step-3-scored.md
 *
 * Outputs:
 *   - Markdown to stdout (always)
 *   - Markdown to --output path (if provided)
 *
 * No --slug/--step flags: the script extracts them from the CSV path's
 * basename if it follows the convention <slug>-step-<n>.csv. If the basename
 * doesn't match, it prints "<csv-basename>" as the heading instead.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename, extname } from 'node:path';
import { parseCsv, scoreRows, formatMarkdown } from './lib/codecheck-eval/scoring.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const csvPath = arg('csv');
const outputPath = arg('output');

if (!csvPath) {
  console.error('Usage: --csv <path> [--output <md>]');
  process.exit(2);
}

let text;
try {
  text = readFileSync(csvPath, 'utf8');
} catch (err) {
  console.error(`Cannot read CSV: ${csvPath}\n${err.message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseCsv(text);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

let scores;
try {
  scores = scoreRows(parsed.rows);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Try to recover slug/step from path: <slug>-step-<n>.csv
const base = basename(csvPath, extname(csvPath));
const m = base.match(/^(.*)-step-(\d+)$/);
const slug = m ? m[1] : base;
const stepNumber = m ? Number(m[2]) : 0;

const md = formatMarkdown(scores, slug, stepNumber);

console.log(md);

if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, md);
  console.log(`Wrote ${outputPath}`);
}
```

- [ ] **Step 4.2: Sanity test the wiring with a tiny fixture**

```bash
mkdir -p .tmp
cat > .tmp/scored-fixture.csv <<'EOF'
submission_id,expected,actual,summary,latency_ms,prompt_tokens,completion_tokens,agree
s001,pass,pass,"ok",1200,500,150,TRUE
s002,pass,partial,"close",1100,510,140,PARTIAL
s003,fail,EXCEPTION,"timeout",30000,0,0,FALSE
EOF
node scripts/score-codecheck-eval.js --csv .tmp/scored-fixture.csv
rm -rf .tmp
```

Expected: stdout shows headline 66.7% / strict 33.3% / 1 exception. (No vitest case because the wrapper is just argv + readFile + library calls; T3 covers the logic.)

- [ ] **Step 4.3: Commit**

```bash
git add scripts/score-codecheck-eval.js
git commit -m "feat(codecheck): score CLI (#210)"
```

---

## Task 5: Telemetry library + tests

**Files:**
- Create: `scripts/lib/codecheck-eval/telemetry.js`
- Create: `test/unit/codecheck-eval-telemetry.test.js`

Lib exports:
1. `buildQueries(sinceIso)` — returns `{ verdictDistribution, latency, tokens, errors, perStepCoverage }` each as `{ sql, params }`. Pure function, easy to test.
2. `shapeResults(rawByName)` — given the four query results keyed by name, builds the canonical JSON output object.
3. `formatMarkdown(shaped)` — renders the JSON as a paste-ready Markdown summary.

The CLI in T6 runs the SQL and feeds raw results into `shapeResults`.

- [ ] **Step 5.1: Write failing test**

Create `test/unit/codecheck-eval-telemetry.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildQueries, shapeResults, formatMarkdown } from '../../scripts/lib/codecheck-eval/telemetry.js';

describe('buildQueries', () => {
  it('emits five named queries with the same single-element params (sinceIso)', () => {
    const q = buildQueries('2026-06-08T00:00:00Z');
    const names = ['verdictDistribution', 'latency', 'tokens', 'errors', 'perStepCoverage'];
    for (const n of names) {
      expect(q[n]).toBeDefined();
      expect(typeof q[n].sql).toBe('string');
      expect(q[n].sql.length).toBeGreaterThan(0);
      expect(q[n].params).toEqual(['2026-06-08T00:00:00Z']);
    }
  });

  it('latency query references PERCENTILE_CONT (HANA-only)', () => {
    expect(buildQueries('x').latency.sql).toMatch(/PERCENTILE_CONT/);
  });

  it('errors query filters by verdict = error (lowercase, source-faithful)', () => {
    const sql = buildQueries('x').errors.sql;
    expect(sql).toMatch(/verdict\s*=\s*'error'/i);
  });
});

describe('shapeResults', () => {
  it('builds the canonical JSON output object', () => {
    const raw = {
      verdictDistribution: [{ VERDICT: 'pass', N: 24 }, { VERDICT: 'partial', N: 12 }],
      latency: [{ P_MIN: 340, P50: 1240, P95: 2890, P99: 3410, P_MAX: 3520 }],
      tokens: [{ AVG_PROMPT: 612, AVG_COMPLETION: 188, TOTAL_TOKENS: 24000, N_WITH_TOKENS: 30 }],
      errors: [{ ERRORREASON: 'upstream', N: 1 }],
      perStepCoverage: [{ TUTORIALSLUG: 's', STEPNUMBER: 3, VERDICT: 'pass', N: 10 }],
    };
    const out = shapeResults(raw, '2026-06-08T00:00:00Z');
    expect(out.since).toBe('2026-06-08T00:00:00Z');
    expect(out.verdictDistribution).toHaveLength(2);
    expect(out.verdictDistribution[0]).toEqual({ verdict: 'pass', n: 24 });
    expect(out.latency.p95).toBe(2890);
    expect(out.tokens.avg_prompt).toBe(612);
    expect(out.errors[0].errorReason).toBe('upstream');
    expect(out.perStepCoverage[0].stepNumber).toBe(3);
  });

  it('handles empty result arrays without crashing', () => {
    const out = shapeResults({
      verdictDistribution: [], latency: [], tokens: [], errors: [], perStepCoverage: [],
    }, 'x');
    expect(out.verdictDistribution).toEqual([]);
    expect(out.latency).toEqual({ p_min: null, p50: null, p95: null, p99: null, p_max: null });
    expect(out.tokens).toEqual({ avg_prompt: null, avg_completion: null, total_tokens: null, n_with_tokens: 0 });
  });
});

describe('formatMarkdown', () => {
  it('renders verdict mix and latency rows even with zero rows', () => {
    const md = formatMarkdown({
      since: '2026-06-08T00:00:00Z',
      verdictDistribution: [], latency: { p_min: null, p50: null, p95: null, p99: null, p_max: null },
      tokens: { avg_prompt: null, avg_completion: null, total_tokens: null, n_with_tokens: 0 },
      errors: [], perStepCoverage: [],
    });
    expect(md).toMatch(/since/i);
    expect(md).toMatch(/Verdict/);
  });
});
```

- [ ] **Step 5.2: Run test, verify it fails**

Run: `npx vitest run test/unit/codecheck-eval-telemetry.test.js`
Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement `scripts/lib/codecheck-eval/telemetry.js`**

HANA `db.run` returns row objects with column names UPPERCASE-d unless explicitly aliased. The tests above assume `VERDICT` / `N` / `P95` / etc. — `shapeResults` is responsible for normalizing.

```js
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
```

- [ ] **Step 5.4: Run test, verify it passes**

Run: `npx vitest run test/unit/codecheck-eval-telemetry.test.js`
Expected: PASS (6 cases).

- [ ] **Step 5.5: Commit**

```bash
git add scripts/lib/codecheck-eval/telemetry.js test/unit/codecheck-eval-telemetry.test.js
git commit -m "feat(codecheck): telemetry lib + tests (#210)"
```

---

## Task 6: Telemetry CLI entry point

**Files:**
- Create: `scripts/pull-codecheck-telemetry.cjs`

CJS — needs `cds.connect.to('db')`. Thin wrapper: parse args → run 5 queries → call `shapeResults` → write JSON + print Markdown.

- [ ] **Step 6.1: Write the script**

```js
/**
 * pull-codecheck-telemetry.cjs — aggregate cost/latency/verdict telemetry
 * from CodeCheckSubmissions for Phase 4 (#210, follow-up to #171, PR #205).
 *
 * Runs 5 fixed SELECT aggregates against HANA via cds bind, including
 * PERCENTILE_CONT for real latency percentiles (HANA-only). Writes a JSON
 * summary and prints a paste-ready Markdown summary to stdout.
 *
 * Bypasses srv/lib/analytics-sql-validator.cjs by talking directly to the DB
 * client (validator gates AnalyticsService.runSelectQuery, not the cds DB
 * client). PERCENTILE_CONT would be rejected by the validator — see
 * srv/lib/ui-event-saved-queries.js:59. The seed in scripts/sample-submissions/
 * seed-saved-queries.json uses validator-safe avg/min/max/count instead.
 *
 * Prerequisites:
 *   - `cf login` to the DEV space
 *   - `npx cds bind --to <hana-binding>`
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/pull-codecheck-telemetry.cjs \
 *     --since 2026-06-08T00:00:00Z \
 *     --output verdicts/telemetry-summary.json
 *
 * Flags:
 *   --since <iso-date>   Optional. Default: 1970-01-01T00:00:00Z (all rows).
 *   --output <path>      Optional. Default: verdicts/telemetry-summary.json
 */

const cds = require('@sap/cds');
const { writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const sinceIso = arg('since', '1970-01-01T00:00:00Z');
const outputPath = arg('output', 'verdicts/telemetry-summary.json');

(async () => {
  await cds.load('*');
  const db = await cds.connect.to('db');

  const { buildQueries, shapeResults, formatMarkdown } = await import('./lib/codecheck-eval/telemetry.js');
  const queries = buildQueries(sinceIso);

  const raw = {};
  for (const [name, q] of Object.entries(queries)) {
    try {
      raw[name] = await db.run(q.sql, q.params);
    } catch (err) {
      console.error(`Query "${name}" failed: ${err.message}`);
      console.error(`SQL was:\n${q.sql}`);
      process.exit(1);
    }
  }

  const shaped = shapeResults(raw, sinceIso);

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(shaped, null, 2));

  console.log(formatMarkdown(shaped));
  console.log('');
  console.log(`Wrote ${outputPath}`);
  process.exit(0);
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
```

- [ ] **Step 6.2: Sanity check**

Run: `node --check scripts/pull-codecheck-telemetry.cjs`
Expected: clean exit.

- [ ] **Step 6.3: Commit**

```bash
git add scripts/pull-codecheck-telemetry.cjs
git commit -m "feat(codecheck): telemetry CLI (#210)"
```

---

## Task 7: SavedQueries seed + importer

**Files:**
- Create: `scripts/sample-submissions/seed-saved-queries.json`
- Create: `scripts/seed-codecheck-saved-queries.cjs`

The Analytics Builder UI has no "Import Saved Queries" affordance — `SavedTab.vue`
exposes only list/rename/setVisibility/duplicate/recordRun/remove. Saving from the
Builder calls `POST /admin/analytics/SavedQueries` with body `{ name, description,
sql, spec, visibility }` (see `app/analytics-explorer/src/composables/useSavedQueries.ts:71`).
Tom seeds the canned queries via a small CJS script that POSTs each row through
`AnalyticsService.SavedQueries`.

Field shapes from `db/analytics-builder.cds:28` and `srv/analytics-service.cds:113`:

- `name : String(120) not null`
- `description : String(500)` (optional)
- `sql : LargeString` (the SELECT)
- `spec : LargeString` (JSON-stringified QuerySpec OR `null` for SQL-tab saves —
  see comment at `srv/analytics-service.cds:87` "null for editor/legacy paths")
- `visibility : String(16) default 'private'` — values are `'private' | 'shared-admins'`
  (NOT `'public'`)

The seed JSON is a plain array of `{ name, description, sql, spec, visibility }`
objects. The CJS script reads it, connects via `cds bind`, and INSERTs each row
through CDS QL so admin auth is bypassed (the script runs locally, same trust model
as `setup-dev-data.cjs`).

- [ ] **Step 7.1: Write the seed file**

```json
[
  {
    "name": "Code-check: verdict distribution by slug+step",
    "description": "Phase 4 (#210) — count of verdicts per pilot tutorial step. Populates the per-step coverage section of the decision doc. (See pull-codecheck-telemetry.cjs for the full picture including latency percentiles.)",
    "sql": "SELECT tutorialSlug, stepNumber, verdict, COUNT(*) AS n FROM com_sap_developers_ims_CodeCheckSubmissions GROUP BY tutorialSlug, stepNumber, verdict ORDER BY tutorialSlug, stepNumber, verdict",
    "spec": null,
    "visibility": "shared-admins"
  },
  {
    "name": "Code-check: latency summary by verdict (avg/min/max)",
    "description": "Phase 4 (#210) — validator-safe latency aggregates. Real percentiles (p50/p95/p99) come from pull-codecheck-telemetry.cjs which bypasses the analytics validator. Use this for ad-hoc poking only.",
    "sql": "SELECT verdict, COUNT(*) AS n, MIN(latencyMs) AS lat_min, AVG(latencyMs) AS lat_avg, MAX(latencyMs) AS lat_max FROM com_sap_developers_ims_CodeCheckSubmissions GROUP BY verdict ORDER BY verdict",
    "spec": null,
    "visibility": "shared-admins"
  },
  {
    "name": "Code-check: token cost by verdict",
    "description": "Phase 4 (#210) — average prompt/completion tokens and grand total per verdict bucket. Use for cost-per-check estimates.",
    "sql": "SELECT verdict, AVG(promptTokens) AS avg_prompt, AVG(completionTokens) AS avg_completion, SUM(promptTokens + completionTokens) AS total FROM com_sap_developers_ims_CodeCheckSubmissions GROUP BY verdict ORDER BY verdict",
    "spec": null,
    "visibility": "shared-admins"
  }
]
```

- [ ] **Step 7.2: Sanity-check JSON validity**

```bash
node -e "JSON.parse(require('fs').readFileSync('scripts/sample-submissions/seed-saved-queries.json'))" && echo OK
```

Expected: prints `OK`.

- [ ] **Step 7.3: Write the importer CJS script**

Create `scripts/seed-codecheck-saved-queries.cjs`:

```js
/**
 * seed-codecheck-saved-queries.cjs — INSERT three canned AnalyticsSavedQuery
 * rows for Phase 4 (#210). Reads scripts/sample-submissions/seed-saved-queries.json
 * and creates each row via CDS QL against the bound HANA database.
 *
 * Runs once per environment. Idempotent on `name` — if a row with the same
 * name already exists, the script skips it and prints SKIPPED. Use --force
 * to overwrite (delete-then-insert).
 *
 * Why a script instead of UI import: app/analytics-explorer/'s SavedTab.vue
 * has no Import button. The only programmatic save path is `useSavedQueries.saveAs`
 * which POSTs through admin auth. Locally with `cds bind`, INSERTing via
 * CDS QL is the simplest route.
 *
 * Prerequisites:
 *   - `cf login` to the target space
 *   - `npx cds bind --to <hana-binding>`
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/seed-codecheck-saved-queries.cjs
 *
 * Flags:
 *   --force           Delete existing rows by name before re-inserting.
 *   --dry-run         Print the rows that would be inserted; do not write.
 */

const cds = require('@sap/cds');
const { readFileSync } = require('node:fs');

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');

(async () => {
  await cds.load('*');
  const db = await cds.connect.to('db');
  const { AnalyticsSavedQuery } = cds.entities('com.sap.developers.ims');

  const seedPath = 'scripts/sample-submissions/seed-saved-queries.json';
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

  if (!Array.isArray(seed)) {
    console.error(`Expected ${seedPath} to be a JSON array.`);
    process.exit(1);
  }

  console.log(`Seeding ${seed.length} SavedQuery rows from ${seedPath} (dry-run=${dryRun}, force=${force})\n`);

  let inserted = 0, skipped = 0, replaced = 0;

  for (const row of seed) {
    if (!row.name) {
      console.error('Row missing required `name` field — skipping.');
      continue;
    }
    const existing = await SELECT.one.from(AnalyticsSavedQuery).where({ name: row.name });

    if (existing && !force) {
      console.log(`  SKIPPED  ${row.name} — already exists (use --force to replace)`);
      skipped++;
      continue;
    }

    if (existing && force) {
      if (!dryRun) await DELETE.from(AnalyticsSavedQuery).where({ ID: existing.ID });
      console.log(`  REPLACED ${row.name}`);
      replaced++;
    } else {
      console.log(`  INSERTED ${row.name}`);
      inserted++;
    }

    if (!dryRun) {
      await INSERT.into(AnalyticsSavedQuery).entries({
        name: row.name,
        description: row.description || null,
        sql: row.sql,
        spec: row.spec || null,
        visibility: row.visibility || 'private',
      });
    }
  }

  console.log(`\nDone. inserted=${inserted}  skipped=${skipped}  replaced=${replaced}`);
  if (dryRun) console.log('(dry-run — no writes performed)');
  process.exit(0);
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
```

- [ ] **Step 7.4: Sanity check**

Run: `node --check scripts/seed-codecheck-saved-queries.cjs`
Expected: clean exit.

- [ ] **Step 7.5: Commit**

```bash
git add scripts/sample-submissions/seed-saved-queries.json scripts/seed-codecheck-saved-queries.cjs
git commit -m "feat(codecheck): SavedQueries seed + importer for Phase 4 (#210)"
```

---

## Task 8: Runbook + sidebar registration

**Files:**
- Create: `docs/developers/operations/phase-4-codecheck-eval.md`
- Modify: `docs/.vitepress/config.ts` (one new sidebar entry, alphabetized)

The runbook is concrete commands and short prose (1-2 sentences per step). No design rationale — that's in the spec. The sidebar guard rejects unregistered pages; one line added in the operations sub-array.

- [ ] **Step 8.1: Write the runbook**

```markdown
# Phase 4 — AI code-check spike evaluation

Runbook for [issue #210](https://github.com/sap-tutorials/tutorials-ims/issues/210)
(follow-up to [#171](https://github.com/sap-tutorials/tutorials-ims/issues/171),
shipped in [PR #205](https://github.com/sap-tutorials/tutorials-ims/pull/205)).
Walks through the post-deploy evaluation cycle that drives the
graduate / iterate / shelve decision.

## Prerequisites

- PR #205 deployed to DEV (verify: `curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/health`).
- `cf login` to the `tutorial-system / dev` space.
- 1-2 pilot authors lined up (each owning a `*-Contribution` repo).

## 1. Enable the flag in DEV

In `/admin-ui/#joule-settings`, set `ChatSettings.codeCheckEnabled = true`.
(Or via `cds query`: see PR #205 § "Operator runbook" steps 3, 6, 7.)

## 2. Coordinate pilot tutorials

- Choose 3+ steps total across 1-2 pilots (acceptance criterion is ≥3 steps).
- Pick code-heavy steps where the author has a clear reference solution.
- Author adds `[CODECHECK_N]` blocks per the spike spec § "rules.vr CODECHECK block".
- Trigger `rebuild-content.yml` (full or per-slug). Confirm the mount div is published:

  ```bash
  curl -s https://.../tutorials/<pilot-slug>/ | grep step-codecheck-mount
  ```

## 3. Generate JSONL skeleton per step

```bash
npx cds bind --exec -- node scripts/generate-codecheck-eval-skeleton.cjs \
  --slug <pilot-slug> --step <n>
```

The author edits `scripts/sample-submissions/<slug>-step-<n>.jsonl` to fill
in the 30 `code` strings, using the per-row `_hint` for coverage guidance.

## 4. Run the eval harness per step

```bash
ALLOW_HYBRID_WRITES=true \
  npx cds bind --exec -- node scripts/evaluate-code-check.js \
  --slug <pilot-slug> --step <n> \
  --submissions scripts/sample-submissions/<slug>-step-<n>.jsonl \
  --output verdicts/<slug>-step-<n>.csv
```

## 5. Author rates the CSV

Open `verdicts/<slug>-step-<n>.csv` in a sheet app. Add an `agree` column
with values `TRUE`, `FALSE`, or `PARTIAL` per row. Save back to the same path.

Rule: treat `PARTIAL` as agree when **either** expected or actual is `partial`
— the spike's primary goal is the pass-vs-fail boundary.

## 6. Score

```bash
node scripts/score-codecheck-eval.js \
  --csv verdicts/<slug>-step-<n>.csv \
  --output verdicts/<slug>-step-<n>-scored.md
```

Prints a Markdown block with headline %, strict %, and a 3×3 confusion matrix.

## 7. Pull telemetry once all steps are graded

```bash
npx cds bind --exec -- node scripts/pull-codecheck-telemetry.cjs \
  --since <date-flag-was-flipped> \
  --output verdicts/telemetry-summary.json
```

(One-time, optional) Seed the three canned `AnalyticsSavedQuery` rows so
ad-hoc poking in `/analytics-ui/` reuses the same shape:

```bash
npx cds bind --exec -- node scripts/seed-codecheck-saved-queries.cjs
```

The seed script is idempotent on `name` — re-running it skips existing rows
unless you pass `--force`. It uses validator-safe aggregates only; real
percentile latency stays exclusive to `pull-codecheck-telemetry.cjs`.

## 8. Fill the decision doc

1. Open `docs/superpowers/specs/phase-4-codecheck-evaluation.md`.
2. Paste each `*-scored.md` block into the per-step section.
3. Paste `telemetry-summary.json`'s Markdown into the Cost & latency section.
4. Check the verdict box (graduate / iterate / shelve) per spec thresholds:
   - **≥80% headline** → graduate
   - **<80% but salvageable** → iterate (Approach C: RAG-then-grade)
   - **<60%** → shelve (retain code behind flag)
5. Fill rationale in 3-4 sentences.

## 9. Comment + close

- Comment headline numbers + decision link on **#171** and **#210**.
- Close **#210** (with link to merged decision-doc PR).
- If the verdict is "graduate", **#171** stays open with linked sub-issues.
- If "shelve", close **#171** too — code stays behind the flag.

## Troubleshooting

- **401 on `/api/codecheck`** — token expired; refresh with `cf-bearer-token`.
- **503 on `/api/codecheck`** — flag is off; re-check `ChatSettings.codeCheckEnabled`.
- **0 CodeCheckSpecs returned by skeleton generator** — publish-content didn't
  ship sidecars for that slug; re-trigger `rebuild-content.yml`.
- **HANA error on `PERCENTILE_CONT`** — telemetry script targets HANA only.
  Running it with an in-memory SQLite binding fails. Use a real `cf login` + `cds bind`.
- **"Refusing to overwrite"** from skeleton generator — pass `--force` only if
  the existing JSONL is intentionally being regenerated; half-curated content
  is otherwise destroyed.
```

- [ ] **Step 8.2: Add sidebar entry**

Open `docs/.vitepress/config.ts`. Find the operations sub-array. The entries
are alphabetical. Add (between "MTA deployment" and "Production readiness"):

```ts
{ text: 'Phase 4 code-check eval',   link: '/developers/operations/phase-4-codecheck-eval' },
```

- [ ] **Step 8.3: Verify docs build**

Run: `npm run docs:build`
Expected: green build (predocs:build sidebar guard passes; new page registered).

- [ ] **Step 8.4: Commit**

```bash
git add docs/developers/operations/phase-4-codecheck-eval.md docs/.vitepress/config.ts
git commit -m "docs(codecheck): Phase 4 evaluation runbook (#210)"
```

---

## Task 9: Decision-template doc

**Files:**
- Create: `docs/superpowers/specs/phase-4-codecheck-evaluation.md`

Date-less filename so the eventual filled-in commit gets an accurate date in
git, not the prep date. Status = "Pending Phase 4 data" until Tom fills it in.

- [ ] **Step 9.1: Write the template**

```markdown
# AI Code-Check Spike — Phase 4 Evaluation

**Tracking:** [sap-tutorials/tutorials-ims#171](https://github.com/sap-tutorials/tutorials-ims/issues/171) (spike), [#210](https://github.com/sap-tutorials/tutorials-ims/issues/210) (Phase 4)
**Spec:** [2026-06-02-ai-code-check-spike-design.md](2026-06-02-ai-code-check-spike-design.md)
**Date:** _<filled when complete>_
**Status:** Pending Phase 4 data

## Pilot tutorials

| Slug | Step | Author | Goal (one-line) |
|---|---|---|---|
| _t1_ | _n_ | _x_ | _…_ |
| _t2_ | _n_ | _x_ | _…_ |
| _t3_ | _n_ | _x_ | _…_ |

## Per-step agreement

| Step | n | Headline (TRUE+PARTIAL)/n | Strict TRUE/n | Exceptions |
|---|---|---|---|---|
| _t1 step n_ | 30 | _%_ | _%_ | _0_ |
| _t2 step n_ | 30 | _%_ | _%_ | _0_ |
| _t3 step n_ | 30 | _%_ | _%_ | _0_ |

## Confusion matrices

_Paste the output of `scripts/score-codecheck-eval.js` per step._

<!-- per step:

## <slug> step <n>
- n: 30
- Headline: x.x%
- Strict: x.x%
- Exceptions: 0

### Confusion matrix (rows = expected, cols = actual)
| | pass | partial | fail |
|---|---|---|---|
| pass    | … | … | … |
| partial | … | … | … |
| fail    | … | … | … |

-->

## Cost & latency

_Paste the Markdown output of `scripts/pull-codecheck-telemetry.cjs`._

| Metric | Value |
|---|---|
| p50 latency | _ms_ |
| p95 latency | _ms_ |
| p99 latency | _ms_ |
| Mean prompt tokens | _n_ |
| Mean completion tokens | _n_ |
| Verdict distribution | pass _x%_ / partial _y%_ / fail _z%_ / error _e%_ |

## Top 3 disagreement categories

1. _…e.g. "near-miss missing await graded as fail"…_
2. _…_
3. _…_

## Decision

**Headline agreement (across all pilot steps):** _%_

- [ ] **Graduate** — ≥80% headline; gaps below tracked as follow-up issues.
- [ ] **Iterate (Approach C: RAG-then-grade)** — <80% but salvageable.
- [ ] **Shelve** — <60%, retain behind flag for future revisit.

### Rationale

_…why this decision over the alternatives, in 3-4 sentences…_

### Follow-ups (if Graduate)

- _…issue link…_
- _…issue link…_

### Action (if Shelve)

- Confirm `codeCheckEnabled = false` in DEV + prod ChatSettings.
- No code removed; spike artifacts preserved at @<commit-sha>.
```

- [ ] **Step 9.2: Commit**

```bash
git add docs/superpowers/specs/phase-4-codecheck-evaluation.md
git commit -m "docs(codecheck): Phase 4 decision template (#210)"
```

---

## Task 10: Final verification + open PR

**Files:** none (verification only)

- [ ] **Step 10.1: Run the unit project**

Run: `npx vitest run --project unit codecheck-eval`
Expected: all 3 codecheck-eval tests pass (skeleton, scoring, telemetry).

- [ ] **Step 10.2: Confirm docs build still green**

Run: `npm run docs:build`
Expected: completes without sidebar-guard or dead-link errors.

- [ ] **Step 10.3: Inspect the staged changes**

Run: `git log --oneline main..HEAD`
Expected: 8 commits + the spec doc commit (0567649). Branch ahead of main by 9.

Run: `git diff --stat main..HEAD`
Expected: ~13 files changed. No unintended files.

- [ ] **Step 10.4: Open the PR**

Per [[feedback_pr_over_direct_merge]] and [[feedback_verify_branch_before_commit]]:

```bash
git branch --show-current   # MUST show feat/210-codecheck-phase4-prep before pushing
git push -u origin feat/210-codecheck-phase4-prep
gh pr create --title "feat(codecheck): Phase 4 evaluation prep (#210)" --body "$(cat <<'EOF'
Operator-side scaffolding for the post-deploy Phase 4 evaluation cycle of the
AI code-check spike.

**Spec:** [docs/superpowers/specs/2026-06-07-ai-code-check-phase-4-evaluation-prep-design.md](docs/superpowers/specs/2026-06-07-ai-code-check-phase-4-evaluation-prep-design.md)
**Plan:** [docs/superpowers/plans/2026-06-07-ai-code-check-phase-4-evaluation-prep.md](docs/superpowers/plans/2026-06-07-ai-code-check-phase-4-evaluation-prep.md)
**Refs:** #210 (follow-up to #171, PR #205)

## What's in this PR

- **Runbook** at `docs/developers/operations/phase-4-codecheck-eval.md` — step-by-step Phase 4 procedure.
- **3 small scripts:**
  - `scripts/generate-codecheck-eval-skeleton.cjs` — emit a 30-row JSONL with hint-stubbed coverage rows.
  - `scripts/score-codecheck-eval.js` — compute agreement % + confusion matrix from a hand-rated CSV.
  - `scripts/pull-codecheck-telemetry.cjs` — aggregate verdict / latency (PERCENTILE_CONT) / token cost.
- **`scripts/sample-submissions/seed-saved-queries.json`** — 3 validator-safe SavedQueries for ad-hoc poking in `/analytics-ui/`.
- **Decision template** at `docs/superpowers/specs/phase-4-codecheck-evaluation.md` — date-less filename; status `Pending Phase 4 data`; gets filled and re-committed once the eval is run.
- **Sidebar registration** in `docs/.vitepress/config.ts`.

## What's NOT in this PR

- Flag flip in DEV (Tom does this manually per PR #205's runbook).
- Pilot author content. Pilot authors choose their own steps/reference solutions.
- Any production code path or CDS schema change.
- Follow-up issues. Those depend on the verdict (graduate / iterate / shelve).
- Validator widening for `PERCENTILE_CONT`. Standalone telemetry script bypasses the validator; seed uses validator-safe aggregates.

## Test coverage

- 17 new unit tests across the 3 lib modules; all green.
- No hybrid (PR #205 already covers code-check hybrid).
- No smoke (nothing deployed in this PR).

## Deploy readiness

- No deploy required — all scripts run locally via `cds bind`; runbook and template are docs only.
EOF
)"
```

- [ ] **Step 10.5: Update todos / memory**

(Optional, do only if the PR review surfaces something memorable.) After merge,
consider a memory line for any non-obvious gotcha discovered during the run
(e.g. HANA column-name casing, validator allowlist details).

---

## Verification Checklist

- [ ] All 10 tasks committed.
- [ ] `npx vitest run --project unit` clean (or at least the new files clean).
- [ ] `npm run docs:build` green.
- [ ] Branch is `feat/210-codecheck-phase4-prep` at every commit (`git branch --show-current` before each).
- [ ] PR opened, links #210 in body.
- [ ] No file outside spec scope touched (no `srv/`, no `db/`, no `app/`).

## Out-of-scope for this plan

These come up later, once Phase 4 has data:

- Flipping the flag in DEV.
- Pilot recruitment + content authoring.
- Filling in `phase-4-codecheck-evaluation.md`.
- Posting the verdict comment on #171 / #210.
- Opening follow-up issues based on the verdict.
