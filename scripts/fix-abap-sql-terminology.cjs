#!/usr/bin/env node
// scripts/fix-abap-sql-terminology.cjs
//
// Issue #2426: the `abap-open-sql` concept displays stale terminology.
// "Open SQL" was renamed to "ABAP SQL" years ago
// (https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/abennews-753-abap_sql.html),
// yet the concept's LLM-extracted name reads "ABAP Open SQL SELECT Statements".
// That name propagates onto every concept card that references it (via
// ConceptEdges target.name / source.name in buildConceptsPayload).
//
// This one-shot operator CLI corrects the DISPLAY without changing the URL
// slug (`/concepts/abap-open-sql/` stays — no redirect infra for concepts):
//   1. Rename Concepts.name  → "ABAP SQL" and set a short, terminology-correct
//      description (fits the current String(500) column; the richer markdown
//      definition arrives in PR-2).
//   2. Add a ConceptAliases row alias="Open SQL" (source=ADMIN) so the old term
//      stays discoverable in the ⌘K palette / $search without being displayed.
//
// A db-level INSERT bypasses the KnowledgeGraphService hooks that normally
// (a) normalize `aliasLower` (knowledge-graph-service.js:879) and
// (b) re-aggregate the parent's `aliasSearchBlob` (…:912-928), so this script
// performs BOTH explicitly — otherwise the palette would not match "Open SQL".
//
// Idempotent: re-running is a no-op for the alias (unique on [concept, aliasLower])
// and re-applies the same name/description.
//
// After running with --commit, republish the concept BLOBs (name change
// propagates to the 2 referencing pages automatically via the live edge join):
//   gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims \
//     --ref DEV -f slug=abap-open-sql        # or a full render-concepts run
//
// Usage:
//   node scripts/fix-abap-sql-terminology.cjs             # dry-run (default)
//   node scripts/fix-abap-sql-terminology.cjs --commit    # apply

const cds = require('@sap/cds');

const SLUG = 'abap-open-sql';
const NEW_NAME = 'ABAP SQL';
// ≤500 chars (current Concepts.description column width). Plain text — the
// existing template escapes it. Richer markdown + inline links come in PR-2.
const NEW_DESCRIPTION =
  'ABAP SQL is the SAP-recommended way to read and change data in the ABAP '
  + 'database layer, using SELECT, INSERT, UPDATE, and DELETE statements '
  + 'embedded directly in ABAP code. It was formerly called "Open SQL"; that '
  + 'term is deprecated. See the ABAP Keyword Documentation for the '
  + 'authoritative statement reference.';
const OLD_ALIAS = 'Open SQL';

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const commit = args.has('--commit');
  if (!commit && !args.has('--dry-run')) {
    console.log('fix-abap-sql-terminology: defaulting to --dry-run (pass --commit to apply)');
  }

  // Load the CDS model so cds.entities(...) works under `cds bind --exec`
  // (the serving lifecycle does this for you; the CLI does not). cds.linked +
  // priming cds.model.entities BEFORE connect are both required (#757/#911).
  cds.model = cds.linked(await cds.load('*'));
  void cds.model.entities;
  const db = await cds.connect.to('db');

  const { Concepts, ConceptAliases } = cds.entities('com.sap.developers.ims');

  let concept;
  try {
    concept = await db.run(
      SELECT.one.from(Concepts).columns('ID', 'slug', 'name', 'description').where({ slug: SLUG })
    );
  } catch (err) {
    console.error(
      'fix-abap-sql-terminology: query failed — is the DB deployed and populated?\n'
      + '  Run against real data via:  cds bind --exec -- node scripts/fix-abap-sql-terminology.cjs --commit\n'
      + `  (${err.message})`
    );
    process.exit(1);
  }
  if (!concept) {
    console.error(`fix-abap-sql-terminology: concept slug='${SLUG}' not found — nothing to do.`);
    process.exit(1);
  }
  console.log(`fix-abap-sql-terminology: concept ${SLUG} (ID=${concept.ID})`);
  console.log(`  name:        "${concept.name}"  ->  "${NEW_NAME}"`);
  console.log(`  description: "${(concept.description || '').slice(0, 60)}…"  ->  set (${NEW_DESCRIPTION.length} chars)`);

  const aliasLower = OLD_ALIAS.toLowerCase().trim();
  const existingAlias = await db.run(
    SELECT.one.from(ConceptAliases).columns('ID').where({ concept_ID: concept.ID, aliasLower })
  );
  console.log(`  alias:       "${OLD_ALIAS}" (aliasLower="${aliasLower}") ${existingAlias ? '[already present — skip]' : '[will INSERT]'}`);

  if (!commit) {
    console.log('fix-abap-sql-terminology: dry-run complete — no changes written.');
    process.exit(0);
  }

  await db.tx(async (tx) => {
    await tx.run(
      UPDATE(Concepts).set({ name: NEW_NAME, description: NEW_DESCRIPTION }).where({ ID: concept.ID })
    );
    if (!existingAlias) {
      await tx.run(
        INSERT.into(ConceptAliases).entries({
          concept_ID: concept.ID,
          alias: OLD_ALIAS,
          aliasLower,          // service before-hook is bypassed on db-level INSERT — set explicitly
          source: 'ADMIN',
        })
      );
    }
    // Re-aggregate aliasSearchBlob on the parent (the after-hook that normally
    // does this fires only on the service path). Mirror knowledge-graph-service.js:920-924.
    const remaining = await tx.run(
      SELECT.from(ConceptAliases).columns('aliasLower').where({ concept_ID: concept.ID })
    );
    const blob = remaining.map(r => r.aliasLower).filter(Boolean).join(',');
    await tx.run(UPDATE(Concepts).set({ aliasSearchBlob: blob }).where({ ID: concept.ID }));
    console.log(`  aliasSearchBlob -> "${blob}"`);
  });

  console.log('fix-abap-sql-terminology: committed. Now republish concept BLOBs (see header).');
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
