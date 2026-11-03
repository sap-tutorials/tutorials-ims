// scripts/patch-draft-cascade-constraints.cjs
// Build-time generator: emits a standalone *.hdbconstraint artifact per Fiori
// draft table so SAP HANA enforces ON DELETE CASCADE of draft rows when their
// DraftAdministrativeData record is removed (the `dad` draft delete strategy /
// cds.fiori.draft_admin_integrity).
//
// Background (#2993): the FK must NOT be inlined into the generated
// *_drafts.hdbtable — HDI rejects that with error 8250014
// ("this artifact type must not have references to other objects"). The correct
// HDI artifact is a separate .hdbconstraint (plugin com.sap.hana.di.constraint,
// already registered in the generated .hdiconfig).
//
// The referenced table DRAFT_DRAFTADMINISTRATIVEDATA is created by the CAP
// runtime, but it lives in the SAME HDI container schema as the draft tables and
// has primary key DRAFTUUID (verified against the deployed DEV container), so
// the ALTER TABLE ... ADD CONSTRAINT that HDI renders at deploy time resolves.
//
// .hdbconstraint file format (confirmed from SAP-samples: hana-shine-xsa
// core-db/src/data/PO_CONST.hdbconstraint and others) — SQL constraint body with
// NO `ALTER TABLE ... ADD CONSTRAINT` verb:
//
//   CONSTRAINT <name>
//   ON "<child-table>" FOREIGN KEY ("<fk-col>")
//   REFERENCES "<parent-table>" ("<parent-col>") ON DELETE CASCADE
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

// Bare (unquoted) in the generated .hdbtable → HANA folds to UPPERCASE.
const FK_COLUMN_SRC = 'DraftAdministrativeData_DraftUUID';
const FK_COLUMN = 'DRAFTADMINISTRATIVEDATA_DRAFTUUID';
const PARENT_TABLE = 'DRAFT_DRAFTADMINISTRATIVEDATA';
const PARENT_COLUMN = 'DRAFTUUID';

// Extract the physical table name from `COLUMN TABLE <name> (` (first line).
function tableNameOf(hdbtableContent) {
  const m = hdbtableContent.match(/COLUMN\s+TABLE\s+("?)([A-Za-z0-9_.]+)\1\s*\(/);
  return m ? m[2] : null;
}

/**
 * For each *_drafts.hdbtable under genDir that carries the DraftAdministrativeData
 * FK column, write a sibling *_drafts.hdbconstraint declaring the ON DELETE
 * CASCADE foreign key. Leaves the .hdbtable untouched.
 *
 * @param {string} genDir  Path to the gen dir (default gen/db/src/gen).
 * @returns {{ patched: string[], skipped: string[] }}
 * @throws {Error} when no *_drafts.hdbtable files are found.
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
    const content = fs.readFileSync(filepath, 'utf8');

    // Only tables that actually carry the draft-admin FK column.
    if (!content.includes(FK_COLUMN_SRC)) {
      skipped.push(filename);
      continue;
    }

    const table = tableNameOf(content);
    if (!table) {
      // Can't determine the table name — skip rather than emit a broken artifact.
      skipped.push(filename);
      continue;
    }

    // Deterministic constraint name, bounded well under HANA's 127-char limit.
    const constraintName = `${table}_dadFkCascade`;
    const constraintFile = filename.replace(/\.hdbtable$/, '.hdbconstraint');
    const constraintPath = path.join(genDir, constraintFile);

    const body =
      `CONSTRAINT ${constraintName}\n` +
      `ON "${table}" FOREIGN KEY ("${FK_COLUMN}")\n` +
      `REFERENCES "${PARENT_TABLE}" ("${PARENT_COLUMN}") ON DELETE CASCADE\n`;

    // Idempotent: skip rewrite if an identical artifact already exists.
    if (fs.existsSync(constraintPath) && fs.readFileSync(constraintPath, 'utf8') === body) {
      skipped.push(filename);
      continue;
    }

    fs.writeFileSync(constraintPath, body, { encoding: 'utf8' });
    patched.push(constraintFile);
  }

  return { patched, skipped };
}

// CLI entry point
if (require.main === module) {
  const genDir = process.argv[2] || 'gen/db/src/gen';
  try {
    const result = patchDraftCascadeConstraints(genDir);
    console.log(`wrote ${result.patched.length} .hdbconstraint / skipped ${result.skipped.length}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { patchDraftCascadeConstraints };
