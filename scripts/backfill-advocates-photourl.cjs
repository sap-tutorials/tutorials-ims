// One-shot post-deploy backfill: populate Advocates.photoUrl for all rows
// where hasPhoto=true, after PR #512 added the persisted column.
//
// Per PR #512 spec: the column starts NULL for every existing row. We
// derive the URL from the SLUG with the canonical lowercase normalization
// that srv/handlers/advocate-handlers.js#urlForSlug uses.
//
// Run: npx cds bind --exec -- node scripts/backfill-advocates-photourl.cjs --dry-run
// Or:  npx cds bind --exec -- node scripts/backfill-advocates-photourl.cjs --commit
//
// Idempotent: subsequent runs find no NULL+hasPhoto rows and exit 0.

const cds = require('@sap/cds');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const DRY_RUN = !COMMIT;

const TABLE = '"COM_SAP_DEVELOPERS_IMS_ADVOCATES"';

(async () => {
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
    process.exit(1);
  }

  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'COMMIT'}`);

  // Find advocates needing backfill: hasPhoto=true but photoUrl is null.
  // We don't touch hasPhoto=false rows — their photoUrl should stay null
  // (no image to serve).
  const targets = await db.run(`
    SELECT "ID", "SLUG", "FIRSTNAME", "LASTNAME", "HASPHOTO", "PHOTOURL"
      FROM ${TABLE}
     WHERE "HASPHOTO" = TRUE
       AND "PHOTOURL" IS NULL
     ORDER BY "SLUG"
  `);

  if (targets.length === 0) {
    console.log('No advocates need backfill. Nothing to do.');
    process.exit(0);
  }

  console.log(`Found ${targets.length} advocate(s) needing photoUrl backfill:`);
  console.table(targets.map(t => ({
    SLUG: t.SLUG,
    NAME: `${t.FIRSTNAME || ''} ${t.LASTNAME || ''}`.trim(),
    WILL_SET: `/api/advocates/${(t.SLUG || '').toLowerCase()}/photo`,
  })));

  if (DRY_RUN) {
    console.log('\nDry-run complete. Re-run with --commit to apply.');
    process.exit(0);
  }

  // Single set-based UPDATE — mirrors the SQL in PR #512's PR body.
  // LOWER(SLUG) matches urlForSlug's canonicalization in
  // srv/handlers/advocate-handlers.js.
  const r = await db.run(`
    UPDATE ${TABLE}
       SET "PHOTOURL" = '/api/advocates/' || LOWER("SLUG") || '/photo'
     WHERE "HASPHOTO" = TRUE
       AND "PHOTOURL" IS NULL
  `);

  // HANA Service returns affected row count via `r` (number) or via the result
  // shape depending on the driver. Re-query to be sure.
  const after = await db.run(`SELECT COUNT(*) AS C FROM ${TABLE} WHERE "HASPHOTO" = TRUE AND "PHOTOURL" IS NULL`);
  console.log(`\nBackfilled ${targets.length} advocate(s). Remaining NULL+hasPhoto rows: ${after[0].C}`);
  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
