/* eslint-disable no-console */
/**
 * backfill-tutorial-authors.cjs — One-shot backfill for Tutorials.author_ID
 * and TutorialContributors.user_ID after the authorship-FK schema landed.
 *
 * Spec:  docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md
 *        ("Backfill script — scripts/backfill-tutorial-authors.cjs")
 * Plan:  docs/superpowers/plans/2026-06-24-tutorial-authorship-fk.md (task 7/13)
 *
 * Resolution logic is delegated to srv/lib/resolve-tutorial-author.js (the
 * TDD-tested pure function) so backfill and the live publish path can never
 * diverge. The resolver is ESM; we load it with dynamic import from this CJS
 * script (same pattern as scripts/setup-dev-data.cjs).
 *
 * Modes:
 *   default        — DRY RUN. Computes everything, writes report, zero writes.
 *   --dry-run      — explicit alias for the default.
 *   --commit       — execute UPDATEs.
 *   --phase=contributors|tutorials|all (default all)
 *
 * Idempotency:
 *   Every UPDATE is gated by `WHERE …_ID IS NULL`. Re-runs are safe and only
 *   touch rows still unmatched. Never overwrites a non-null FK.
 *
 * Output:
 *   Writes .migration-data/tutorial-author-backfill-<ISO-ts>.json with the
 *   shape from the spec. Last lines on stdout are the report path + summary.
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/backfill-tutorial-authors.cjs
 *   npx cds bind --exec -- node scripts/backfill-tutorial-authors.cjs --commit
 *   npx cds bind --exec -- node scripts/backfill-tutorial-authors.cjs --phase=contributors --commit
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');

// --- Arg parsing ---------------------------------------------------------

const argv = process.argv.slice(2);
const hasCommit = argv.includes('--commit');
const hasDryRun = argv.includes('--dry-run');
// Last-flag-wins is acceptable per task brief. Find the last occurrence of
// either flag; default to dry-run if neither is set.
let commit = false;
for (const a of argv) {
  if (a === '--commit') commit = true;
  else if (a === '--dry-run') commit = false;
}
if (!hasCommit && !hasDryRun) commit = false;

const phaseArg = (argv.find(a => a.startsWith('--phase=')) || '').split('=')[1] || 'all';
const VALID_PHASES = new Set(['contributors', 'tutorials', 'all']);
if (!VALID_PHASES.has(phaseArg)) {
  console.error(`Invalid --phase=${phaseArg}. Use one of: contributors, tutorials, all`);
  process.exit(1);
}
const runContributors = phaseArg === 'contributors' || phaseArg === 'all';
const runTutorials = phaseArg === 'tutorials' || phaseArg === 'all';

// --- Table names (HANA quoted upper-case identifiers) --------------------

const T_USERS         = '"COM_SAP_DEVELOPERS_IMS_USERS"';
const T_TUTORIALS     = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"';
const T_CONTRIBUTORS  = '"COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS"';
const T_TUTORIAL_META = '"COM_SAP_DEVELOPERS_IMS_TUTORIALMETA"';

// --- Report scaffolding --------------------------------------------------

const REPORT_DIR = path.resolve(__dirname, '..', '.migration-data');
const tsStamp = new Date().toISOString().replace(/[:.]/g, '-');
const REPORT_PATH = path.join(REPORT_DIR, `tutorial-author-backfill-${tsStamp}.json`);

const report = {
  ranAt: new Date().toISOString(),
  committed: commit,
  summary: {
    users_indexed: 0,
    contributors_matched: 0,
    contributors_orphaned: 0,
    tutorials_matched: 0,
    tutorials_orphaned: 0,
  },
  warnings: [],
  orphans_contributors: [],
  orphans_tutorials: [],
};

function writeReport() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
}

// --- Main ----------------------------------------------------------------

async function main() {
  console.log(`Mode: ${commit ? 'COMMIT' : 'DRY RUN'}`);
  console.log(`Phase: ${phaseArg}`);
  console.log(`Report: ${REPORT_PATH}\n`);

  await cds.load('*');
  const db = await cds.connect.to('db');

  // The resolver is ESM; this script is CJS — use dynamic import.
  const { resolveTutorialAuthor } = await import('../srv/lib/resolve-tutorial-author.js');

  // --- Step 1 — build email → userId map ---
  console.log('Step 1: Building email→userId map from Users …');
  const userRows = await db.run(
    `SELECT "ID", LOWER(TRIM("EMAIL")) AS "EMAIL" FROM ${T_USERS} ` +
    `WHERE "EMAIL" IS NOT NULL AND LENGTH(TRIM("EMAIL")) > 0`
  );

  const emailToUserId = new Map();
  // Track duplicates: same normalized email → multiple user IDs. Picks the
  // lexicographically-first ID and warns; the resolver only needs one.
  const dupBuckets = new Map(); // email → [userId, ...]
  for (const r of userRows) {
    const email = r.EMAIL;
    const id = r.ID;
    if (!email || !id) continue;
    if (!dupBuckets.has(email)) dupBuckets.set(email, []);
    dupBuckets.get(email).push(id);
  }
  for (const [email, ids] of dupBuckets) {
    if (ids.length > 1) {
      const sorted = ids.slice().sort();
      const picked = sorted[0];
      emailToUserId.set(email, picked);
      report.warnings.push({
        kind: 'duplicate_user_email',
        email,
        userIds: sorted,
        picked,
      });
    } else {
      emailToUserId.set(email, ids[0]);
    }
  }
  report.summary.users_indexed = emailToUserId.size;
  console.log(`  Indexed ${emailToUserId.size} unique email(s); ${report.warnings.length} duplicate-email warning(s).\n`);

  // --- Step 2 — Phase A: TutorialContributors.user_ID ---
  if (runContributors) {
    console.log('Phase A: Backfilling TutorialContributors.user_ID …');

    // Join to Tutorials to fetch slug for orphan reports without N per-row
    // lookups. Left-join in case a contributor's tutorial row is missing.
    const contribRows = await db.run(
      `SELECT c."ID" AS "ID", c."EMAIL" AS "EMAIL", c."NAME" AS "NAME", ` +
      `       c."ROLE" AS "ROLE", c."TUTORIAL_ID" AS "TUTORIAL_ID", ` +
      `       t."SLUG" AS "TUTORIALSLUG" ` +
      `  FROM ${T_CONTRIBUTORS} c ` +
      `  LEFT JOIN ${T_TUTORIALS} t ON t."ID" = c."TUTORIAL_ID" ` +
      ` WHERE c."USER_ID" IS NULL AND c."EMAIL" IS NOT NULL`
    );
    console.log(`  ${contribRows.length} contributor row(s) with NULL user_ID and non-NULL email.`);

    let matched = 0;
    for (const r of contribRows) {
      const norm = r.EMAIL ? String(r.EMAIL).trim().toLowerCase() : null;
      if (!norm) continue;
      const userId = emailToUserId.get(norm);
      if (userId) {
        if (commit) {
          await db.run(
            `UPDATE ${T_CONTRIBUTORS} SET "USER_ID" = ? ` +
            `WHERE "ID" = ? AND "USER_ID" IS NULL`,
            [userId, r.ID]
          );
        }
        matched++;
      } else {
        report.orphans_contributors.push({
          id: r.ID,
          tutorialSlug: r.TUTORIALSLUG || null,
          name: r.NAME || null,
          email: r.EMAIL,
          role: r.ROLE || null,
        });
      }
    }
    report.summary.contributors_matched = matched;
    report.summary.contributors_orphaned = report.orphans_contributors.length;
    console.log(`  Matched: ${matched}; Orphaned: ${report.orphans_contributors.length}.\n`);
  } else {
    console.log('Phase A skipped (--phase=tutorials).\n');
  }

  // --- Step 3 — Phase B: Tutorials.author_ID ---
  if (runTutorials) {
    console.log('Phase B: Backfilling Tutorials.author_ID …');

    const tutRows = await db.run(
      `SELECT "ID", "SLUG" FROM ${T_TUTORIALS} WHERE "AUTHOR_ID" IS NULL`
    );
    console.log(`  ${tutRows.length} tutorial row(s) with NULL author_ID.`);

    let matched = 0;
    for (const t of tutRows) {
      // Contributors for this tutorial — ordered by ID for deterministic
      // tie-breaks. (TutorialContributors doesn't have the `managed` aspect
      // so there's no createdAt column to order by; resolveTutorialAuthor's
      // (a) and (b) phases are first-match-wins, so a stable order is what
      // matters, not chronology. See issue #620.)
      const contributors = await db.run(
        `SELECT "EMAIL", "ROLE" FROM ${T_CONTRIBUTORS} ` +
        `WHERE "TUTORIAL_ID" = ? ` +
        `ORDER BY "ID" ASC`,
        [t.ID]
      );

      // ownerEmail from TutorialMeta (singleton; take the first row's OWNEREMAIL or null).
      let ownerEmail = null;
      const metaRows = await db.run(
        `SELECT "OWNEREMAIL" FROM ${T_TUTORIAL_META} WHERE "TUTORIAL_ID" = ?`,
        [t.ID]
      );
      if (metaRows.length > 0) ownerEmail = metaRows[0].OWNEREMAIL || null;

      const resolved = resolveTutorialAuthor({
        contributors: contributors.map(r => ({ email: r.EMAIL, role: r.ROLE })),
        ownerEmail,
        emailToUserId,
      });

      if (resolved.authorUserId) {
        if (commit) {
          await db.run(
            `UPDATE ${T_TUTORIALS} SET "AUTHOR_ID" = ? ` +
            `WHERE "ID" = ? AND "AUTHOR_ID" IS NULL`,
            [resolved.authorUserId, t.ID]
          );
        }
        matched++;
      } else {
        // Build the candidatesTried array with level labels so authors can
        // see *why* each tutorial was skipped.
        const candidatesTried = [];
        // (a) contributor:author — role in {author, owner}
        for (const c of contributors) {
          const role = c.ROLE ? String(c.ROLE).trim().toLowerCase() : '';
          if (role === 'author' || role === 'owner') {
            if (c.EMAIL) candidatesTried.push({ level: 'contributor:author', email: c.EMAIL });
          }
        }
        // (b) contributor:any
        for (const c of contributors) {
          if (c.EMAIL) candidatesTried.push({ level: 'contributor:any', email: c.EMAIL });
        }
        // (c) meta:ownerEmail
        if (ownerEmail) candidatesTried.push({ level: 'meta:ownerEmail', email: ownerEmail });

        report.orphans_tutorials.push({
          slug: t.SLUG || null,
          candidatesTried,
        });
      }
    }
    report.summary.tutorials_matched = matched;
    report.summary.tutorials_orphaned = report.orphans_tutorials.length;
    console.log(`  Matched: ${matched}; Orphaned: ${report.orphans_tutorials.length}.\n`);
  } else {
    console.log('Phase B skipped (--phase=contributors).\n');
  }

  // --- Report + summary ---
  writeReport();

  console.log('=== SUMMARY ===');
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`\nReport written: ${REPORT_PATH}`);
  if (!commit) {
    console.log('\nDRY RUN — no rows were updated. Re-run with --commit to apply.');
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error(e);
  // Best-effort: persist whatever report we have so far for post-mortem.
  try { writeReport(); } catch (_) { /* ignore */ }
  process.exit(1);
});
