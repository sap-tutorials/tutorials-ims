/* eslint-disable no-console */
/**
 * seed-users-github-login.cjs — One-shot seed for Users.githubLogin from a
 * hand-curated (corporate-email → GitHub-login) mapping.
 *
 * Why this exists:
 *   PR #842 introduced a publish-time bootstrap that populates
 *   Users.githubLogin from the publish payload's primaryContributorEmail.
 *   But GitHub's contributors API returns synthetic
 *   <login>@users.noreply.github.com emails for privacy-protected users
 *   (the vast majority). Users.email is the corporate JIT-populated email
 *   (e.g. thomas.jung@sap.com). The two never match, so the bootstrap
 *   silently skips for everyone. Phase 0 of resolveTutorialAuthor needs
 *   Users.githubLogin to be populated to fire — chicken-and-egg.
 *
 *   This script breaks the deadlock by hand-seeding Users.githubLogin for
 *   known authors based on the histogram of author_profile URLs in
 *   `.tutorial-cache/*.md` cross-referenced against the ~18 Users rows
 *   that have a non-null corporate email (because those users have logged
 *   in post-IMS-migration and backfillUserProfile populated it).
 *
 *   After this seed runs, the next force-publish workflow run will fire
 *   Phase 0 for every tutorial whose frontmatter author_profile resolves
 *   to one of the seeded users, correcting Tutorials.author_ID for ~150
 *   tutorials (per the 4 initial mappings).
 *
 * Spec: docs/superpowers/specs/2026-06-30-frontmatter-authoritative-tutorial-owner
 *         §"Bootstrap UPDATE for Users.githubLogin" (added 2026-06-30 followup)
 * Memory: ~/.claude/projects/.../memory/github_noreply_emails_break_email_resolution.md
 *
 * Modes:
 *   default        — DRY RUN. Reports planned UPDATEs; writes nothing.
 *   --dry-run      — explicit alias for the default.
 *   --commit       — execute UPDATEs.
 *
 * Idempotency:
 *   Every UPDATE is gated by `WHERE "GITHUBLOGIN" IS NULL OR LENGTH(TRIM(...))=0`.
 *   Re-runs are safe and only touch rows still unset. Never overwrites a
 *   non-null githubLogin (which might have been set by another path).
 *
 * Output:
 *   Writes .migration-data/seed-users-github-login-<ISO-ts>.json with the
 *   per-mapping outcome (matched | not-found | already-set).
 *
 * Usage:
 *   cf login -o tutorial-system -s dev
 *   npx cds bind --exec -- node scripts/seed-users-github-login.cjs
 *   npx cds bind --exec -- node scripts/seed-users-github-login.cjs --commit
 *
 * To add another mapping: append to the MAPPINGS array below. Re-run.
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');

// --- Hand-curated mapping --------------------------------------------------
// Format: { login, email, source } — source is documentation only ("autodetected"
// for the high-confidence ones, "tom-confirmed" if Tom personally confirmed,
// etc). Add new rows here; never edit a deployed row's `login` without
// understanding the idempotency implication.
const MAPPINGS = [
  // Seed batch 1 — Tom-confirmed 2026-06-30
  { login: 'jung-thomas',    email: 'thomas.jung@sap.com',         source: 'tom-confirmed-2026-06-30' },
  { login: 'jitendrakansal', email: 'jitendra.kansal@sap.com',     source: 'tom-confirmed-2026-06-30' },
  { login: 'ajmaradiaga',    email: 'antonio.maradiaga@sap.com',   source: 'tom-confirmed-2026-06-30' },
  { login: 'rich-heilman',   email: 'rich.heilman@sap.com',        source: 'tom-confirmed-2026-06-30' },
  { login: 'thecodester',    email: 'daniel.wroblewski@sap.com',   source: 'tom-confirmed-2026-06-30' },
];

// --- Arg parsing -----------------------------------------------------------

const argv = process.argv.slice(2);
const hasCommit = argv.includes('--commit');
const hasDryRun = argv.includes('--dry-run');
let commit = false;
for (const a of argv) {
  if (a === '--commit') commit = true;
  else if (a === '--dry-run') commit = false;
}
if (!hasCommit && !hasDryRun) commit = false;

// --- Main ------------------------------------------------------------------

(async () => {
  await cds.connect.to('db');
  const db = cds.db;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join('.migration-data', `seed-users-github-login-${ts}.json`);
  const report = {
    ranAt: ts,
    mode: commit ? 'commit' : 'dry-run',
    mappingCount: MAPPINGS.length,
    results: [],
  };

  console.log(`[seed-users-github-login] mode=${report.mode} mappings=${MAPPINGS.length}`);

  for (const m of MAPPINGS) {
    const lookup = await db.run(
      `SELECT "ID", "EMAIL", "GITHUBLOGIN", "FIRSTNAME", "LASTNAME"
       FROM "COM_SAP_DEVELOPERS_IMS_USERS"
       WHERE LOWER(TRIM("EMAIL")) = ?`,
      [m.email.toLowerCase().trim()]
    );

    const row = lookup?.[0];
    if (!row) {
      console.log(`  [SKIP] ${m.login.padEnd(20)} → ${m.email} — Users row not found`);
      report.results.push({ ...m, outcome: 'not-found' });
      continue;
    }

    const userId = row.ID || row.id;
    const existing = row.GITHUBLOGIN || row.githubLogin;

    if (existing && existing.trim().length > 0) {
      if (existing.toLowerCase() === m.login.toLowerCase()) {
        console.log(`  [NOOP] ${m.login.padEnd(20)} → ${m.email} — already set to same value`);
        report.results.push({ ...m, outcome: 'already-set-same', userId });
      } else {
        console.log(`  [SKIP] ${m.login.padEnd(20)} → ${m.email} — already set to '${existing}' (would not overwrite)`);
        report.results.push({ ...m, outcome: 'already-set-different', userId, existing });
      }
      continue;
    }

    if (!commit) {
      console.log(`  [DRY] ${m.login.padEnd(20)} → ${m.email} (Users.ID=${userId}) — would UPDATE`);
      report.results.push({ ...m, outcome: 'would-update', userId });
      continue;
    }

    try {
      await db.run(
        `UPDATE "COM_SAP_DEVELOPERS_IMS_USERS"
         SET "GITHUBLOGIN" = ?
         WHERE "ID" = ? AND ("GITHUBLOGIN" IS NULL OR LENGTH(TRIM("GITHUBLOGIN")) = 0)`,
        [m.login, userId]
      );
      console.log(`  [SET]  ${m.login.padEnd(20)} → ${m.email} (Users.ID=${userId})`);
      report.results.push({ ...m, outcome: 'updated', userId });
    } catch (err) {
      console.error(`  [ERR]  ${m.login.padEnd(20)} → ${m.email} (Users.ID=${userId}) — ${err.message}`);
      report.results.push({ ...m, outcome: 'error', userId, error: err.message });
    }
  }

  fs.mkdirSync('.migration-data', { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${reportPath}`);
  const counts = report.results.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1;
    return acc;
  }, {});
  console.log(`Summary: ${JSON.stringify(counts)} (mode=${report.mode})`);
  if (!commit) {
    console.log(`\n[DRY RUN — no UPDATEs executed. Re-run with --commit to apply.]`);
  }
})().then(() => process.exit(0)).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
