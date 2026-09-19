#!/usr/bin/env node
// scripts/seed-abap-keyword-docu.cjs
//
// #2426: a reviewer noted that ABAP concept pages surface no links to the
// ABAP Keyword Documentation, where a developer would expect the authoritative
// statement reference. The help-docs corpus can't reach it: the fetcher walks
// help.sap.com's /docs/ deliverable-metadata API, but the ABAP Keyword Docu
// lives under a different scheme (abapdocu_latest_index_htm) the walker can't
// traverse. A bespoke fetcher for that scheme is disproportionate to the need.
//
// Instead this seeds a small, hand-curated set of HelpDocs + HelpDocConceptLinks
// rows pointing the top ABAP concepts at their canonical Keyword Docu pages.
// The links flow through buildConceptsPayload into the concept page's "Docs
// explaining this concept" grid with the SAP Help badge — the same surface the
// automated corpus uses — and become grounding for the PR-3 definition
// generator.
//
// Idempotent: each (helpDoc, concept, predicate, anchor) is unique; the script
// pre-checks and skips existing rows, so re-running is safe.
//
// Usage:
//   node scripts/seed-abap-keyword-docu.cjs             # dry-run (default)
//   node scripts/seed-abap-keyword-docu.cjs --commit    # apply
//
// Run against real data:  cds bind --exec -- node scripts/seed-abap-keyword-docu.cjs --commit

const cds = require('@sap/cds');
const { createHash } = require('node:crypto');

const SOURCE = 'help-sap-com';
const PRODUCT = 'abap';
const PREDICATE = 'explains';
const CONFIDENCE = 1.00;        // curated, not LLM-inferred
const KEYWORD_DOCU_BASE = 'https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US';

// Curated: concept slug -> authoritative ABAP Keyword Documentation page.
// conceptSlug must be an existing Concepts.slug (rows for missing concepts are
// skipped with a warning). Extend as more ABAP concepts warrant an anchor.
const SEEDS = [
  { conceptSlug: 'abap-open-sql', htm: 'abenabap_sql.htm',
    title: 'ABAP SQL — ABAP Keyword Documentation',
    snippet: 'Authoritative reference for ABAP SQL (formerly Open SQL): SELECT, INSERT, UPDATE, DELETE and the full statement syntax.' },
  { conceptSlug: 'abap-data-dictionary', htm: 'abenddic.htm',
    title: 'ABAP Dictionary — ABAP Keyword Documentation',
    snippet: 'Reference for the ABAP Dictionary (DDIC): database tables, data elements, domains, and structured types.' },
  { conceptSlug: 'abap-internal-tables', htm: 'abenitab.htm',
    title: 'Internal Tables — ABAP Keyword Documentation',
    snippet: 'Reference for ABAP internal tables: table types, keys, and the statements that read and modify them.' },
  { conceptSlug: 'abap-cds-analytical-models', htm: 'abencds.htm',
    title: 'ABAP CDS — ABAP Keyword Documentation',
    snippet: 'Reference for ABAP Core Data Services (CDS): view entities, associations, annotations, and access control.' },
  { conceptSlug: 'abap-inline-declarations', htm: 'abeninline_declarations.htm',
    title: 'Inline Declarations — ABAP Keyword Documentation',
    snippet: 'Reference for inline declarations with DATA(...) and @DATA(...) operators in ABAP.' },
];

// Mirror the fetcher's slug shape: 'hd-<source>__<canonicalizedPath>', <=150 chars.
function helpDocSlug(htm) {
  const canon = `abapdocu/${htm}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return `hd-${SOURCE}__${canon}`.slice(0, 150);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const commit = args.has('--commit');
  if (!commit && !args.has('--dry-run')) {
    console.log('seed-abap-keyword-docu: defaulting to --dry-run (pass --commit to apply)');
  }

  cds.model = cds.linked(await cds.load('*'));
  void cds.model.entities;
  const db = await cds.connect.to('db');

  const { Concepts } = cds.entities('com.sap.developers.ims');
  const { HelpDocs, HelpDocConceptLinks } = cds.entities('com.sap.developers.ims.external');

  let planned = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const seed of SEEDS) {
    let concept;
    try {
      concept = await db.run(
        // slug-canonical: seed.conceptSlug is a hardcoded lowercase constant in SEEDS
        SELECT.one.from(Concepts).columns('ID', 'slug').where({ slug: seed.conceptSlug })
      );
    } catch (err) {
      console.error(
        'seed-abap-keyword-docu: query failed — is the DB deployed and populated?\n'
        + '  Run against real data via:  cds bind --exec -- node scripts/seed-abap-keyword-docu.cjs --commit\n'
        + `  (${err.message})`
      );
      process.exit(1);
    }
    if (!concept) {
      console.warn(`  skip: concept '${seed.conceptSlug}' not found`);
      skipped++;
      continue;
    }
    const url = `${KEYWORD_DOCU_BASE}/${seed.htm}`;
    const slug = helpDocSlug(seed.htm);
    const contentHash = createHash('sha256').update(`${seed.title}|${url}|${SOURCE}|${PRODUCT}`).digest('hex');

    console.log(`  ${seed.conceptSlug} -> ${seed.title}`);
    console.log(`    url:  ${url}`);
    console.log(`    slug: ${slug}`);

    if (!commit) { planned++; continue; }

    await db.tx(async (tx) => {
      // Upsert the HelpDocs row (unique on slug).
      // slug-canonical: `slug` is built by helpDocSlug() which lowercases
      const existingDoc = await tx.run(SELECT.one.from(HelpDocs).columns('ID').where({ slug }));
      let helpDocId = existingDoc?.ID;
      if (helpDocId) {
        await tx.run(UPDATE(HelpDocs).set({
          title: seed.title, url, source: SOURCE, product: PRODUCT,
          sourceId: seed.htm, contentHash, lastSeenAt: now,
        }).where({ ID: helpDocId }));
      } else {
        await tx.run(INSERT.into(HelpDocs).entries({
          slug, source: SOURCE, title: seed.title, description: seed.snippet,
          url, sourceId: seed.htm, contentHash, product: PRODUCT, lastSeenAt: now,
        }));
        // Fetch the generated ID (cuid) back by slug.
        // slug-canonical: `slug` is built by helpDocSlug() which lowercases
        helpDocId = (await tx.run(SELECT.one.from(HelpDocs).columns('ID').where({ slug }))).ID;
      }

      // Insert the link if absent (unique on [helpDoc, concept, predicate, anchor]).
      const existingLink = await tx.run(
        SELECT.one.from(HelpDocConceptLinks).columns('ID')
          .where({ helpDoc_ID: helpDocId, concept_ID: concept.ID, predicate: PREDICATE, anchor: null })
      );
      if (existingLink) {
        skipped++;
        return;
      }
      await tx.run(INSERT.into(HelpDocConceptLinks).entries({
        helpDoc_ID: helpDocId,
        concept_ID: concept.ID,
        predicate: PREDICATE,
        confidence: CONFIDENCE,
        anchor: null,
        snippet: seed.snippet.slice(0, 200),
        extractedAt: now,
        modelVersion: 'curated-2426',
      }));
      planned++;
    });
  }

  console.log(`seed-abap-keyword-docu: ${commit ? 'committed' : 'planned'} ${planned} link(s), skipped ${skipped}.`);
  if (commit) console.log('Now republish concept BLOBs so the links appear on the pages.');
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
