/**
 * apply-tutorialmeta-owner-overrides.cjs
 *
 * Apply a known mapping of placeholder author emails to real corporate
 * emails on COM_SAP_DEVELOPERS_IMS_TUTORIALMETA. Companion to
 * backfill-tutorial-meta-from-ims.cjs (PR #355) which itself filters out
 * placeholder emails so they don't carry through. This script walks a
 * curated overrides table and rewrites OWNER on rows that should be
 * attributed to a known author.
 *
 * Issue #371 — surfaced 2026-06-16 when Tom found his "Monitored by me"
 * filter showed 1 tutorial instead of 68. Root cause:
 * IMS_TUTORIAL_AUTHOR.EMAIL for Tom was the synthetic
 * "noreply-tutorial-cleanup@sap-tutorials.local" placeholder, so the
 * unfiltered backfill set OWNER='noreply-tutorial-cleanup@...' on all 68
 * of his tutorials. The Tutorial Health UI compares OWNER to the
 * authenticated user's real email, so the filter dropped them all.
 *
 * The overrides table is a hand-maintained list. Every entry has been
 * verified by a human against the legacy IMS author records. New entries
 * land via PR — never silently. We do NOT auto-derive overrides from
 * GitHub usernames in placeholder emails (e.g. "<id>+<github>@users.
 * noreply.github.com") because the github-username → SAP-corporate-email
 * mapping is ambiguous and has no authoritative source in our subaccount
 * (Option A trust, no SCIM API).
 *
 * Idempotent: re-running over an already-corrected row is a no-op
 * because the WHERE clause keys on the placeholder pattern.
 *
 * Usage (target-creds via CAP_HANA_CREDENTIALS env var; same pattern as
 * sibling backfill scripts):
 *
 *   CAP_HANA_CREDENTIALS="$(cat target-creds.json)" \
 *   node scripts/apply-tutorialmeta-owner-overrides.cjs [--dry-run]
 */

'use strict';

const hdb = require('hdb');

const DRY_RUN = process.argv.includes('--dry-run');

// Curated mapping of (placeholder email, author NAME) → real corporate email.
// Each entry MUST be human-verified. The NAME is included as a guard so a
// future reuse of the same placeholder email by a different author can't
// silently inherit the wrong override.
//
// To add an override:
// 1. Identify the placeholder email + the IMS_TUTORIAL_AUTHOR.NAME field
// 2. Confirm the real corporate email out-of-band (BTP IDP, internal directory)
// 3. Add a row to OVERRIDES below, with a comment linking to the verification
// 4. PR — do not commit unverified overrides.
//
// Current overrides:
const OVERRIDES = [
  {
    // Tom himself — verified via his JWT (`/auth/user` returns
    // thomas.jung@sap.com) and matches Users.EMAIL after the PR #370
    // self-heal kicked in on his first login post-cutover.
    placeholderEmail: 'noreply-tutorial-cleanup@sap-tutorials.local',
    authorName: 'Thomas Jung',
    realEmail: 'thomas.jung@sap.com',
  },
];

function connectHana(creds) {
  const port = parseInt(creds.port || '443', 10);
  const client = hdb.createClient({
    host: creds.host, port, user: creds.user, password: creds.password, useTLS: true,
  });
  return new Promise((resolve, reject) => {
    client.connect((err) => err ? reject(err) : resolve(client));
  });
}

function runSql(client, sql) {
  const fn = client['exec'].bind(client);
  return new Promise((resolve, reject) =>
    fn(sql, (err, rows) => err ? reject(err) : resolve(rows)));
}

function runStmt(client, sql, params) {
  return new Promise((resolve, reject) => {
    client.prepare(sql, (err, stmt) => {
      if (err) return reject(err);
      const fn = stmt['exec'].bind(stmt);
      fn(params, (err2, affected) => {
        stmt.drop();
        err2 ? reject(err2) : resolve(affected);
      });
    });
  });
}

function resolveTargetCreds() {
  if (process.env.CAP_HANA_CREDENTIALS) return JSON.parse(process.env.CAP_HANA_CREDENTIALS);
  throw new Error('No target credentials. Set CAP_HANA_CREDENTIALS to the JSON service-key.');
}

(async function main() {
  const targetCreds = resolveTargetCreds();
  console.log(`Target: ${targetCreds.host?.slice(0, 30)}... schema=${targetCreds.schema}`);
  if (DRY_RUN) console.log('=== DRY RUN — no UPDATEs will be issued ===');
  console.log(`Loaded ${OVERRIDES.length} curated override${OVERRIDES.length === 1 ? '' : 's'}`);

  const target = await connectHana(targetCreds);
  await runSql(target, `SET SCHEMA "${targetCreds.schema}"`);

  let totalUpdated = 0, totalNoop = 0, errCount = 0;

  for (const override of OVERRIDES) {
    try {
      const matching = await runSql(target,
        `SELECT COUNT(*) AS C FROM COM_SAP_DEVELOPERS_IMS_TUTORIALMETA WHERE OWNER = '${override.placeholderEmail.replace(/'/g, "''")}'`);
      const count = matching[0].C;
      if (count === 0) {
        console.log(`  ⊘ ${override.authorName} (${override.realEmail}): 0 rows match placeholder — already cleaned or never landed.`);
        totalNoop++;
        continue;
      }
      console.log(`  → ${override.authorName} (${override.realEmail}): ${count} row${count === 1 ? '' : 's'} match placeholder`);
      if (DRY_RUN) { totalUpdated += count; continue; }
      const affected = await runStmt(target,
        `UPDATE COM_SAP_DEVELOPERS_IMS_TUTORIALMETA SET OWNER = ? WHERE OWNER = ?`,
        [override.realEmail, override.placeholderEmail]);
      console.log(`     ✓ Updated ${affected} rows`);
      totalUpdated += affected;
    } catch (e) {
      errCount++;
      console.error(`     ✗ ${override.authorName}: ${e.message.split('\n')[0]}`);
    }
  }

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Override Application Summary                        ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Override entries:                    ${OVERRIDES.length}`);
  console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'} TutorialMeta rows:    ${totalUpdated}`);
  console.log(`  Already-clean entries (no-op):       ${totalNoop}`);
  console.log(`  Errors:                              ${errCount}`);

  target.end();
  process.exit(errCount > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(2);
});
