#!/usr/bin/env node
// scripts/evaluate-code-check.js
// Manual evaluation harness for the AI code-check spike (issue #171).
//
// Reads a JSONL of submissions with expected verdicts, calls live
// dispatchCheckCode for each, writes a CSV the author grades by hand.
// The agreement rate from those CSVs drives the Phase 4 decision.
//
// Usage (requires HANA binding via cds bind):
//
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec -- node scripts/evaluate-code-check.js \
//     --slug some-tutorial --step 3 \
//     --submissions scripts/sample-submissions/your-slug-step-3.jsonl \
//     --output verdicts/your-slug-step-3.csv

import cds from '@sap/cds';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dispatchCheckCode } from '../srv/lib/code-check-tool.js';
import { defaultCallModel } from '../srv/lib/code-check-llm.js';
import { defaultLoadStepText } from '../srv/lib/code-check-step-loader.js';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const slug = arg('slug');
const stepNumber = Number(arg('step'));
const submissionsPath = arg('submissions');
const outputPath = arg('output', 'verdicts.csv');

if (!slug || !stepNumber || !submissionsPath) {
  console.error('Usage: --slug <slug> --step <n> --submissions <file.jsonl> [--output <verdicts.csv>]');
  console.error('');
  console.error('Example:');
  console.error('  ALLOW_HYBRID_WRITES=true \\');
  console.error('    npx cds bind --exec -- node scripts/evaluate-code-check.js \\');
  console.error('    --slug abap-environment-trial-onboarding --step 3 \\');
  console.error('    --submissions scripts/sample-submissions/abap-env-step-3.jsonl \\');
  console.error('    --output verdicts/abap-env-step-3.csv');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Load submissions
// ---------------------------------------------------------------------------

let lines;
try {
  lines = readFileSync(submissionsPath, 'utf8').split('\n').filter(l => l.trim());
} catch (err) {
  console.error(`Cannot read submissions file: ${submissionsPath}`);
  console.error(err.message);
  process.exit(1);
}

const submissions = lines.map((l, i) => {
  try {
    return JSON.parse(l);
  } catch (err) {
    console.error(`Line ${i + 1}: invalid JSON — ${err.message}`);
    process.exit(1);
  }
});

console.log(`Loaded ${submissions.length} submissions from ${submissionsPath}`);
console.log(`Evaluating slug="${slug}" step=${stepNumber}`);
console.log(`Output → ${outputPath}`);
console.log('');

// ---------------------------------------------------------------------------
// Ensure output directory exists
// ---------------------------------------------------------------------------

const outDir = dirname(outputPath);
if (outDir && outDir !== '.') {
  mkdirSync(outDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Run evaluations
// ---------------------------------------------------------------------------

const rows = [
  ['submission_id', 'expected', 'actual', 'summary', 'latency_ms', 'prompt_tokens', 'completion_tokens'],
];

for (const s of submissions) {
  const startedAt = Date.now();
  try {
    const verdict = await dispatchCheckCode(
      { tutorialSlug: slug, stepNumber, submittedCode: s.code },
      { user: { id: `eval-${s.id}` }, callModel: defaultCallModel, loadStepText: defaultLoadStepText }
    );

    // Re-fetch the just-persisted row to pick up token telemetry.
    // dispatchCheckCode returns the verdict object but does not expose token counts.
    const db = await cds.connect.to('db');
    const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    const recent = await SELECT.from(CodeCheckSubmissions)
      .where({ tutorialSlug: slug.toLowerCase(), stepNumber })
      .orderBy({ createdAt: 'desc' })
      .limit(1);

    rows.push([
      s.id,
      s.expectedVerdict,
      verdict.verdict,
      JSON.stringify(verdict.summary || ''),
      String(Date.now() - startedAt),
      String(recent[0]?.promptTokens ?? ''),
      String(recent[0]?.completionTokens ?? ''),
    ]);
    process.stdout.write('.');
  } catch (err) {
    rows.push([
      s.id,
      s.expectedVerdict,
      'EXCEPTION',
      JSON.stringify(err.message),
      String(Date.now() - startedAt),
      '',
      '',
    ]);
    process.stdout.write('!');
  }
}
process.stdout.write('\n');

// ---------------------------------------------------------------------------
// Write CSV
// ---------------------------------------------------------------------------

const csv = rows.map(r => r.map(escapeCell).join(',')).join('\n');
writeFileSync(outputPath, csv);

const dataRows = rows.length - 1; // exclude header
const exceptions = rows.slice(1).filter(r => r[2] === 'EXCEPTION').length;

console.log('');
console.log(`Wrote ${dataRows} rows to ${outputPath}`);
if (exceptions > 0) {
  console.warn(`  ${exceptions} row(s) hit EXCEPTION — check the 'summary' column for error details`);
}
console.log('');
console.log('Next steps:');
console.log('  1. Open the CSV in Excel / Numbers / Google Sheets.');
console.log('  2. Add an "agree" column: TRUE if actual matches expected, FALSE otherwise.');
console.log('     Treat "partial" as agree when either expected or actual is partial');
console.log('     (the spike cares most about the pass-vs-fail boundary).');
console.log('  3. Compute the agreement rate = COUNT(agree=TRUE) / total rows.');
console.log('  4. Use that rate as evidence for the Phase 4 graduate/iterate/shelve decision.');

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function escapeCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
