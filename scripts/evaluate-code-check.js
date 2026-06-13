#!/usr/bin/env node
// scripts/evaluate-code-check.js
// Manual evaluation harness for the AI code-check spike (issue #171).
//
// Reads a JSONL of submissions with expected verdicts, POSTs each to the
// deployed /api/codecheck endpoint, writes a CSV the author grades by hand.
// The agreement rate from those CSVs drives the Phase 4 decision (#210).
//
// Production-faithful: exercises the full HTTP + auth + middleware + handler
// chain, identical to what an in-app learner would hit. The previous
// in-process call to dispatchCheckCode required `cds.entities` which is
// unreachable from `cds bind --exec` outside the runtime — see #315.
//
// Token-cost telemetry is read from CodeCheckSubmissions via raw SQL with
// `cds bind --exec` (sidesteps `cds.entities` per memory note
// `feedback_cds_entities_runtime_only.md`).
//
// Usage (typical — token + base URL come from env):
//
//   CODECHECK_TOKEN=... \
//     CAP_BASE_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
//     ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec -- node scripts/evaluate-code-check.js \
//     --slug some-tutorial --step 3 \
//     --submissions scripts/sample-submissions/your-slug-step-3.jsonl \
//     --output verdicts/your-slug-step-3.csv
//
// CODECHECK_TOKEN can be:
//  - An XSUAA client_credentials token minted from `tutorials-xsuaa` per
//    docs/developers/operations/qa-channel-bootstrap.md § "Mint a token".
//  - A user JWT pulled out of an interactive session.
// Either works — the handler authenticates the request via authMw.

import cds from '@sap/cds';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
const baseUrl = process.env.CAP_BASE_URL || arg('base-url', 'http://localhost:4004');
const token = process.env.CODECHECK_TOKEN || arg('token');

if (!slug || !stepNumber || !submissionsPath) {
  console.error('Usage: --slug <slug> --step <n> --submissions <file.jsonl> [--output <verdicts.csv>] [--base-url <url>] [--token <jwt>]');
  console.error('');
  console.error('Env: CAP_BASE_URL (optional, defaults http://localhost:4004), CODECHECK_TOKEN (required for deployed app).');
  console.error('');
  console.error('Example:');
  console.error('  CODECHECK_TOKEN=... \\');
  console.error('    CAP_BASE_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \\');
  console.error('    ALLOW_HYBRID_WRITES=true \\');
  console.error('    npx cds bind --exec -- node scripts/evaluate-code-check.js \\');
  console.error('    --slug abap-environment-trial-onboarding --step 3 \\');
  console.error('    --submissions scripts/sample-submissions/abap-env-step-3.jsonl \\');
  console.error('    --output verdicts/abap-env-step-3.csv');
  process.exit(2);
}

if (!token && !baseUrl.startsWith('http://localhost')) {
  console.error('CODECHECK_TOKEN is required when CAP_BASE_URL is not localhost.');
  console.error('Mint one per docs/developers/operations/qa-channel-bootstrap.md § "Mint a token".');
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
console.log(`POSTing to ${baseUrl}/api/codecheck`);
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
// Connect to HANA for the post-call token-telemetry lookup. Raw SQL only —
// `cds.entities` is unavailable in `cds bind --exec` scripts (see #315 and
// memory note `feedback_cds_entities_runtime_only.md`).
// ---------------------------------------------------------------------------

const db = await cds.connect.to('db');

// ---------------------------------------------------------------------------
// Run evaluations
// ---------------------------------------------------------------------------

const rows = [
  ['submission_id', 'expected', 'actual', 'summary', 'latency_ms', 'prompt_tokens', 'completion_tokens'],
];

for (const s of submissions) {
  const startedAt = Date.now();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${baseUrl}/api/codecheck`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tutorialSlug: slug,
        stepNumber,
        submittedCode: s.code,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const verdict = await res.json();

    // Pull token telemetry from the row that the handler just persisted.
    // Match on (tutorialSlug, stepNumber) and grab the freshest row by createdAt.
    // Slug is canonicalized to lowercase before persistence.
    const recent = await db.run(
      `SELECT TOP 1 PROMPTTOKENS, COMPLETIONTOKENS FROM COM_SAP_DEVELOPERS_IMS_CODECHECKSUBMISSIONS
       WHERE TUTORIALSLUG = ? AND STEPNUMBER = ?
       ORDER BY CREATEDAT DESC`,
      [slug.toLowerCase(), stepNumber]
    );

    rows.push([
      s.id,
      s.expectedVerdict,
      verdict.verdict,
      JSON.stringify(verdict.summary || ''),
      String(Date.now() - startedAt),
      String(recent[0]?.PROMPTTOKENS ?? ''),
      String(recent[0]?.COMPLETIONTOKENS ?? ''),
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
