/* eslint-disable no-console */
/**
 * backfill-tutorial-meta-author.cjs — One-shot backfill for
 * TutorialMeta.ownerEmail (issue #777).
 *
 * Spec: docs/superpowers/specs/2026-06-29-777-author-owner-reconciliation-design.md §1.4
 * Sibling: scripts/backfill-tutorial-authors.cjs (writes author_ID; run
 * AFTER this script per spec §6).
 *
 * Resolution: legacy TutorialMeta.owner is free-text — typically the
 * frontmatter `author_name` value from old-IMS. May be:
 *   - "thomas.jung@sap.com"            (email shape)
 *   - "Thomas Jung"                    (name shape)
 *   - "Thomas Jung <thomas.jung@sap.com>" (compound)
 * We resolve to a Users row by matching email first, then exact
 * firstName + ' ' + lastName.
 *
 * Modes:
 *   default        — DRY RUN. Writes CSV reports, zero DB writes.
 *   --dry-run      — explicit alias.
 *   --commit       — execute UPDATEs (ownerEmail only; NEVER author_ID).
 *
 * Idempotency:
 *   Every UPDATE is gated by `WHERE OWNEREMAIL IS NULL`. Re-runs are
 *   safe and only touch rows still unset.
 *
 * Output:
 *   .migration-data/tutorial-meta-author-proposed.csv
 *   .migration-data/tutorial-meta-author-orphans.csv
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/backfill-tutorial-meta-author.cjs
 *   npx cds bind --exec -- node scripts/backfill-tutorial-meta-author.cjs --commit
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
let commit = false;
for (const a of argv) {
  if (a === '--commit') commit = true;
  else if (a === '--dry-run') commit = false;
}

const REPORT_DIR = path.resolve(__dirname, '..', '.migration-data');
const PROPOSED_PATH = path.join(REPORT_DIR, 'tutorial-meta-author-proposed.csv');
const ORPHANS_PATH = path.join(REPORT_DIR, 'tutorial-meta-author-orphans.csv');

// --- Pure resolver (exported for testing) ----------------------------------

/**
 * Resolve a legacy TutorialMeta.owner string to a Users row.
 *
 * @param {string|null} ownerText - the legacy `owner` value
 * @param {Array<{ID, uuid, email, firstName, lastName}>} users
 * @returns {{
 *   match: object|null,
 *   candidates: object[],
 *   proposedEmail: string|null,
 *   orphanReason: 'empty'|'unmatched'|'ambiguous'|null,
 * }}
 */
function resolveLegacyOwner(ownerText, users) {
  if (ownerText == null || ownerText === '') {
    return { match: null, candidates: [], proposedEmail: null, orphanReason: 'empty' };
  }

  // 1. Try to extract an embedded email — e.g. "Thomas Jung <thomas.jung@sap.com>".
  const emailMatch = ownerText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) {
    const email = emailMatch[0].toLowerCase().trim();
    const candidates = users.filter((u) => u.email && u.email.toLowerCase() === email);
    if (candidates.length === 1) {
      return { match: candidates[0], candidates, proposedEmail: candidates[0].email, orphanReason: null };
    }
    if (candidates.length > 1) {
      return { match: null, candidates, proposedEmail: null, orphanReason: 'ambiguous' };
    }
    // Email-shaped but no Users row matches → unmatched.
    return { match: null, candidates: [], proposedEmail: null, orphanReason: 'unmatched' };
  }

  // 2. Try name-shape: exact "firstName lastName".
  const trimmed = ownerText.trim();
  const candidates = users.filter((u) => {
    if (!u.firstName || !u.lastName) return false;
    return `${u.firstName} ${u.lastName}` === trimmed;
  });
  if (candidates.length === 1) {
    return { match: candidates[0], candidates, proposedEmail: candidates[0].email, orphanReason: null };
  }
  if (candidates.length > 1) {
    return { match: null, candidates, proposedEmail: null, orphanReason: 'ambiguous' };
  }

  return { match: null, candidates: [], proposedEmail: null, orphanReason: 'unmatched' };
}

// Export for unit tests.
module.exports = { resolveLegacyOwner };

// --- Script body -----------------------------------------------------------

async function main() {
  await cds.connect.to('db');
  const db = cds.db;

  // Load all Users — small table, easier than per-row lookups.
  const users = await db.run(
    `SELECT "ID", "uuid", "email", "firstName", "lastName" FROM "COM_SAP_DEVELOPERS_IMS_USERS"`,
  );
  console.log(`[backfill] Loaded ${users.length} users.`);

  // Load all TutorialMeta rows where owner is set but ownerEmail is NULL.
  const metaRows = await db.run(
    `SELECT m."ID", m."OWNER", t."slug" AS "tutorialSlug"
     FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" m
     INNER JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t."ID" = m."tutorial_ID"
     WHERE m."OWNER" IS NOT NULL AND m."OWNEREMAIL" IS NULL`,
  );
  console.log(`[backfill] Candidate rows: ${metaRows.length} (owner set, ownerEmail null)`);

  const proposed = [];
  const orphans = [];
  for (const r of metaRows) {
    const result = resolveLegacyOwner(r.OWNER, users);
    if (result.match) {
      proposed.push({
        metaId: r.ID,
        tutorialSlug: r.tutorialSlug,
        ownerInput: r.OWNER,
        proposedEmail: result.proposedEmail,
        matchedUserId: result.match.ID,
      });
    } else {
      orphans.push({
        metaId: r.ID,
        tutorialSlug: r.tutorialSlug,
        ownerInput: r.OWNER,
        reason: result.orphanReason,
        candidates: result.candidates.map((c) => `${c.email}(${c.ID})`).join('|'),
      });
    }
  }

  // Write CSVs.
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(
    PROPOSED_PATH,
    'metaId,tutorialSlug,ownerInput,proposedEmail,matchedUserId\n' +
      proposed.map((p) => `${p.metaId},${p.tutorialSlug},"${p.ownerInput}",${p.proposedEmail},${p.matchedUserId}`).join('\n'),
  );
  fs.writeFileSync(
    ORPHANS_PATH,
    'metaId,tutorialSlug,ownerInput,reason,candidates\n' +
      orphans.map((o) => `${o.metaId},${o.tutorialSlug},"${o.ownerInput}",${o.reason},"${o.candidates}"`).join('\n'),
  );

  console.log(`[backfill] Proposed: ${proposed.length}, orphans: ${orphans.length}`);
  console.log(`[backfill]   ${PROPOSED_PATH}`);
  console.log(`[backfill]   ${ORPHANS_PATH}`);

  if (!commit) {
    console.log('[backfill] DRY RUN — no DB writes. Use --commit to apply.');
    process.exit(0);
  }

  // Apply UPDATEs.
  let updated = 0;
  for (const p of proposed) {
    const res = await db.run(
      `UPDATE "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" SET "OWNEREMAIL" = ? WHERE "ID" = ? AND "OWNEREMAIL" IS NULL`,
      [p.proposedEmail, p.metaId],
    );
    if (res > 0) updated++;
  }
  console.log(`[backfill] Applied ${updated} ownerEmail UPDATEs.`);
  console.log(
    `[backfill] NEXT: re-run scripts/backfill-tutorial-authors.cjs --commit to pick up these rows via author_ID.`,
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[backfill] FAILED:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
}
