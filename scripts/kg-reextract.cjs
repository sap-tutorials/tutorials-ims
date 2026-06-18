// scripts/kg-reextract.cjs
//
// One-shot CLI to (re)run the extractConcepts cron job out-of-band.
//
// Use cases:
//   - HDI deploy wiped Concepts/TutorialConceptLinks (the "schema drift on
//     Concepts" failure mode in the spec). Re-run with a high cap to rebuild
//     from corpus.
//   - Local dev / manual testing — give it a small cap to spot-check N
//     tutorials.
//   - First-time corpus pass after PR 2 schema deploy + PR 3 cron lands.
//
// Default cap is high (10000) so a manual run processes the whole corpus in
// one go. Override with KG_EXTRACT_BUILD_CAP=N for a smaller run.
//
// Usage:
//   npm run kg:reextract
//   KG_EXTRACT_BUILD_CAP=5 npm run kg:reextract        # smoke test
//   KG_EXTRACT_BUILD_CAP=10000 npm run kg:reextract    # full corpus pass (default)
//
// The CLI MUST be invoked under `cds bind --exec` so the bound HANA
// service is available — see the npm script in package.json.
//
// CommonJS so it doesn't fight node ESM resolution under cds bind --exec.
//
// Plan ref: docs/superpowers/plans/2026-06-17-knowledge-graph-implementation.md
//           (PR 3 / Task 3.4)

'use strict';

(async () => {
  // Default the cap to 10000 if the caller didn't override (the npm script
  // sets it explicitly, but a direct `node scripts/kg-reextract.cjs` invocation
  // would otherwise hit the cron's own default of 200).
  if (!process.env.KG_EXTRACT_BUILD_CAP) {
    process.env.KG_EXTRACT_BUILD_CAP = '10000';
  }

  const cap = process.env.KG_EXTRACT_BUILD_CAP;
  console.log(`[kg-reextract] starting extractConcepts with KG_EXTRACT_BUILD_CAP=${cap}`);
  const startedAt = Date.now();

  try {
    // DB-kind guard: refuse to run against anything but HANA. Without
    // `cds bind --exec --profile hybrid`, this script would silently use the
    // in-memory SQLite default and write garbage to the wrong DB. Mirrors
    // the pattern in scripts/spike/kg-probe.cjs.
    const cdsMod = await import('@sap/cds');
    const cds = cdsMod.default || cdsMod;
    const db = await cds.connect.to('db');
    if (db.kind !== 'hana') {
      console.error(
        `[kg-reextract] WRONG DRIVER: db.kind is "${db.kind}", expected "hana".`,
      );
      console.error('[kg-reextract] You probably forgot --profile hybrid. Try:');
      console.error(
        '[kg-reextract]   cds bind --exec --profile hybrid -- node scripts/kg-reextract.cjs',
      );
      process.exit(3);
    }

    // Dynamic import because the job module is ESM (type:module project).
    const { runExtractConcepts } = await import('../srv/jobs/extract-concepts-job.js');
    const summary = await runExtractConcepts();
    const durationMs = Date.now() - startedAt;
    console.log(`[kg-reextract] complete in ${(durationMs / 1000).toFixed(1)}s:`);
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error(`[kg-reextract] FAILED after ${(durationMs / 1000).toFixed(1)}s:`);
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
