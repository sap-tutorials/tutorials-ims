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
