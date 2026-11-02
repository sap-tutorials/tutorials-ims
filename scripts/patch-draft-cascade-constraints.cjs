// scripts/patch-draft-cascade-constraints.cjs
// Build-time patch: appends ON DELETE CASCADE foreign keys to generated draft
// .hdbtable files so that SAP HANA will enforce cascade-delete of draft rows
// when their DraftAdministrativeData record is removed.
//
// Background (#2993): CAP's `cds.fiori.draft_admin_integrity` flag requires
// that every *_drafts table carries a real HANA FK with ON DELETE CASCADE to
// DRAFT_DRAFTADMINISTRATIVEDATA. The flag stays OFF in package.json (the
// in-memory SQLite unit tier does not understand .hdbconstraint DDL); this
// script makes the constraints deployable without enabling the flag.
//
// Usage (CLI):
//   node scripts/patch-draft-cascade-constraints.cjs [genDir]
//   genDir defaults to gen/db/src/gen
//
// Exported API:
//   patchDraftCascadeConstraints(genDir) -> { patched: string[], skipped: string[] }

'use strict';

const fs = require('fs');
const path = require('path');

const FK_COLUMN = 'DraftAdministrativeData_DraftUUID';
const FK_CLAUSE =
  'FOREIGN KEY ("DraftAdministrativeData_DraftUUID") REFERENCES "DRAFT_DRAFTADMINISTRATIVEDATA"("DRAFTUUID") ON DELETE CASCADE';

/**
 * Enumerate all *_drafts.hdbtable files under genDir, and for each one that
 * contains the FK column but not yet ON DELETE CASCADE, inject the FK clause
 * as the last element inside the COLUMN TABLE (...) body.
 *
 * @param {string} genDir  Absolute (or cwd-relative) path to the gen dir.
 * @returns {{ patched: string[], skipped: string[] }}
 * @throws {Error} when no *_drafts.hdbtable files are found in genDir.
 */
function patchDraftCascadeConstraints(genDir) {
  const entries = fs.readdirSync(genDir);
  const draftFiles = entries.filter((f) => f.endsWith('_drafts.hdbtable'));

  if (draftFiles.length === 0) {
    throw new Error(
      `no *_drafts.hdbtable files found in ${genDir} — run cds build --production first`
    );
  }

  const patched = [];
  const skipped = [];

  for (const filename of draftFiles) {
    const filepath = path.join(genDir, filename);
    const original = fs.readFileSync(filepath, 'utf8');

    // Skip if this table doesn't have the FK column (draft tables from other
    // namespaces, or tables generated without draft admin support).
    if (!original.includes(FK_COLUMN)) {
      skipped.push(filename);
      continue;
    }

    // Idempotency: if the FK clause is already present, skip.
    if (/ON DELETE CASCADE/i.test(original)) {
      skipped.push(filename);
      continue;
    }

    // Inject the FK clause as the last item inside the COLUMN TABLE (...) body.
    // The closing ) is the last non-whitespace character after PRIMARY KEY(...).
    // Strategy: find the last ) and insert ", <FK_CLAUSE>\n" before it.
    const lastParen = original.lastIndexOf(')');
    if (lastParen === -1) {
      // Malformed file — skip rather than corrupt it.
      skipped.push(filename);
      continue;
    }

    const patched_content =
      original.slice(0, lastParen) +
      ',\n  ' +
      FK_CLAUSE +
      '\n' +
      original.slice(lastParen);

    fs.writeFileSync(filepath, patched_content, { encoding: 'utf8' });
    patched.push(filename);
  }

  return { patched, skipped };
}

// CLI entry point
if (require.main === module) {
  const genDir = process.argv[2] || 'gen/db/src/gen';
  try {
    const result = patchDraftCascadeConstraints(genDir);
    console.log(`patched ${result.patched.length} / skipped ${result.skipped.length}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { patchDraftCascadeConstraints };
