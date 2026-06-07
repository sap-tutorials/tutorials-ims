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
