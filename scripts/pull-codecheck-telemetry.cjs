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
