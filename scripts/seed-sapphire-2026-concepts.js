#!/usr/bin/env node
// scripts/seed-sapphire-2026-concepts.js
//
// Seed a hand-curated set of Sapphire 2026 / newer-terms concepts into
// the Knowledge Graph and publish them immediately (issue #858).
//
// The extractor at srv/lib/kg-extract.js can only add concepts that
// appear in tutorial content. New brand terms announced at Sapphire 2026
// (Business Data Cloud, Business AI Platform / BAIP, Joule Studio,
// Agentic AI, etc.) may not yet be in enough tutorial prose to be
// picked up. This script adds them as first-class concepts so the KG
// widget, /explore/concepts/, and Joule tooling can reference them
// even before tutorial content catches up.
//
// Behavior:
// - Idempotent: uses `WHERE slug = ?` before INSERT so re-running is a
//   no-op for already-seeded rows.
// - Adjusts existing rows conservatively: if a row with the same slug
//   already exists (e.g. because the extractor found it in a tutorial),
//   we only backfill `publishedAt` if it's still NULL. Descriptions
//   authored by an admin via the Concepts Fiori tile are never
//   overwritten.
// - Default `--dry-run` (via absence of `--commit`) mirrors the sibling
//   scripts/publish-top-concepts.js pattern.
// - No embedding is generated here — the reconciliation cron (job
//   category-seed-embeddings + kg-concept extractor) will backfill
//   `embedding` on its next pass. That's fine for the widget and the
//   admin surface; only similarity-merge cares about embeddings, and
//   it's safe to have a NULL embedding.
//
// Run via:
//   npx cds bind --exec -- node scripts/seed-sapphire-2026-concepts.js               # dry-run
//   npx cds bind --exec -- node scripts/seed-sapphire-2026-concepts.js --commit      # writes
//
// After commit, verify on DEV:
//   curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/kg-stats
//   → concepts count jumps by the number of newly-added rows.
//   curl -s https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/build/concepts \
//     | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));\
//                console.log(d.concepts.filter(c=>/business-data-cloud|joule-studio|business-ai-platform|agentic-ai/.test(c.slug)))"

import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const INITIATOR = process.env.INITIATOR || 'scripts/seed-sapphire-2026-concepts';

// The 14 concepts to seed. Slugs are kebab-case and lowercase (matches
// `Concepts.slug @assert.unique`). Descriptions are ≤500 chars each
// (Concepts.description column cap).
export const SAPPHIRE_2026_CONCEPTS = Object.freeze([
  {
    slug: 'business-data-cloud',
    name: 'Business Data Cloud (BDC)',
    description:
      'SAP Business Data Cloud is the unified data foundation announced at Sapphire 2026 that consolidates SAP Datasphere, SAP Analytics Cloud, and Databricks-powered analytics into a single managed offering. BDC is the strategic data plane for AI and analytics across the SAP portfolio.',
  },
  {
    slug: 'business-ai-platform',
    name: 'Business AI Platform (BAIP)',
    description:
      'The Sapphire 2026 rebrand of SAP Business Technology Platform (BTP) that emphasises its role as the AI-and-integration platform for the SAP suite. BAIP is the umbrella that covers AI Core, AI Foundation, Joule, and CAP-based extensibility on Cloud Foundry, Kyma, and the ABAP environment.',
  },
  {
    slug: 'joule-studio',
    name: 'Joule Studio',
    description:
      'A low-code authoring surface introduced with Sapphire 2026 for building, testing, and deploying Joule skills and agents against SAP business context. Joule Studio lets business developers compose agentic workflows without dropping to raw CAP or ABAP code.',
  },
  {
    slug: 'joule-agents',
    name: 'Joule Agents',
    description:
      'The next-generation autonomous agent tier of Joule announced at Sapphire 2026. Joule Agents move beyond conversational copilots to plan-and-act workflows that can reason over business objects, invoke released APIs, and hand off to human reviewers.',
  },
  {
    slug: 'agentic-ai',
    name: 'Agentic AI',
    description:
      'The paradigm shift from prompt-response LLM copilots to autonomous, tool-using AI agents that plan multi-step workflows, invoke APIs, and adapt to results. SAP\'s agentic push at Sapphire 2026 spans Joule Agents, CAP AI Agents, and the ABAP Agentic Code Migration tooling in ADT.',
  },
  {
    slug: 'abap-agentic-code-migration',
    name: 'ABAP Agentic Code Migration',
    description:
      'AI-driven code migration tooling for ABAP that plans and executes upgrades to ABAP Cloud, RAP, and released-API surfaces. Runs inside ADT (and ADT for VS Code) and applies fixes across large codebases while respecting clean-core rules.',
  },
  {
    slug: 'cap-ai-agents',
    name: 'CAP AI Agents',
    description:
      'CAP-native primitives for building AI agents that call SAP business APIs, honour @requires authorization, and stream responses via the CAP protocol adapters. Covered in the 2026 Sapphire "Building Agents with CAP" sessions and the ongoing "AI agents & CAP" workstream.',
  },
  {
    slug: 'mdk-2',
    name: 'MDK 2.0',
    description:
      'SAP Mobile Development Kit version 2, GA at Sapphire 2026. Introduces a rebuilt runtime, new UI capabilities, and improved offline-first patterns for cross-platform mobile apps that consume SAP OData services and integrate with Joule.',
  },
  {
    slug: 'sap-architecture-center',
    name: 'SAP Architecture Center',
    description:
      'The reference architecture hub at architecture.learning.sap.com that publishes vetted patterns, blueprints, and decision guides across SAP\'s technology and integration surfaces. Introduced alongside the 2026 developer content refresh.',
  },
  {
    slug: 'n8n-integration',
    name: 'n8n Integration',
    description:
      'Community-driven workflow automation with n8n integrated against SAP BTP, CAP services, and released ABAP APIs. Featured in the June 2026 SAP Developer News as an emerging low-code integration option alongside SAP Build Process Automation.',
  },
  {
    slug: 'terraform-btp',
    name: 'Terraform for BTP',
    description:
      'The SAP-maintained Terraform provider for BTP that manages subaccounts, entitlements, service instances, and role collections as code. Ongoing 2026 updates broaden coverage of AI-service provisioning and Cloud Foundry / Kyma runtime configuration.',
  },
  // Stretch — approved per issue #858 comment thread.
  {
    slug: 'btp-abap-env-2605',
    name: 'BTP ABAP Environment 2605',
    description:
      'The June 2026 release train of BTP ABAP Environment. Ships expanded released-API surface, RAP enhancements, and closer integration with ADT for VS Code and the ABAP Agentic Code Migration tooling.',
  },
  {
    slug: 'sap-cap-react',
    name: 'CAP with React',
    description:
      'First-class React support in CAP, promoted at Sapphire 2026. Combines CAP\'s CDS-driven service layer with @ui5/webcomponents-react on the frontend for a modern SPA developer experience that stays inside SAP\'s design language.',
  },
  {
    slug: 'sap-cap-vue',
    name: 'CAP with Vue',
    description:
      'Vue 3 as a supported CAP frontend option alongside React and Fiori Elements. Pairs @ui5/webcomponents directly with Vue single-file components for teams that prefer the Vue ecosystem while consuming CAP OData services.',
  },
]);

async function main() {
  // Same warmup pattern as scripts/publish-top-concepts.js — boots CAP's
  // model + DB without a full server context so `cds bind --exec` works.
  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const db = await cds.connect.to('db');

  // Preflight: what's already in the DB for our target slugs?
  const targetSlugs = SAPPHIRE_2026_CONCEPTS.map(c => c.slug);
  const placeholders = targetSlugs.map(() => '?').join(',');
  const existing = await db.run(
    `SELECT slug, ID, status, publishedAt
       FROM com_sap_developers_ims_Concepts
      WHERE slug IN (${placeholders})`,
    targetSlugs,
  );

  // HANA returns UPPERCASE column names when using raw SQL. Normalize.
  const existingBySlug = new Map();
  for (const row of existing) {
    const slug = row.slug ?? row.SLUG;
    const id = row.ID;
    const status = row.status ?? row.STATUS;
    const publishedAt = row.publishedAt ?? row.PUBLISHEDAT;
    existingBySlug.set(slug, { id, status, publishedAt });
  }

  // Classify every candidate into one of three action buckets.
  const toInsert = []; // brand-new row
  const toPublish = []; // exists ACTIVE, not yet published — set publishedAt
  const skip = [];      // exists AND (already published OR non-ACTIVE, don't touch)

  for (const c of SAPPHIRE_2026_CONCEPTS) {
    const row = existingBySlug.get(c.slug);
    if (!row) {
      toInsert.push(c);
    } else if (row.status !== 'ACTIVE') {
      skip.push({ ...c, reason: `existing status=${row.status}` });
    } else if (row.publishedAt) {
      skip.push({ ...c, reason: 'already published' });
    } else {
      toPublish.push({ ...c, id: row.id });
    }
  }

  console.log(`Seed plan (${SAPPHIRE_2026_CONCEPTS.length} candidates):`);
  console.log(`  new inserts: ${toInsert.length}`);
  console.log(`  publish existing: ${toPublish.length}`);
  console.log(`  skip: ${skip.length}`);
  console.log();

  if (toInsert.length) {
    console.log(`Will INSERT + publish:`);
    for (const c of toInsert) console.log(`  + ${c.slug.padEnd(38)}  ${c.name}`);
    console.log();
  }
  if (toPublish.length) {
    console.log(`Will publish (already present, ACTIVE, publishedAt=NULL):`);
    for (const c of toPublish) console.log(`  ~ ${c.slug.padEnd(38)}  ${c.name}`);
    console.log();
  }
  if (skip.length) {
    console.log(`Will skip:`);
    for (const s of skip) console.log(`  · ${s.slug.padEnd(38)}  (${s.reason})`);
    console.log();
  }

  if (!COMMIT) {
    console.log('Dry-run — no writes. Re-run with --commit to apply.');
    return;
  }

  const now = new Date().toISOString();
  await db.tx(async tx => {
    for (const c of toInsert) {
      const id = randomUUID();
      await tx.run(
        `INSERT INTO com_sap_developers_ims_Concepts
           (ID, slug, name, description, status, extractionCount,
            publishedAt, publishedBy, firstSeenAt, lastSeenAt,
            createdAt, createdBy, modifiedAt, modifiedBy)
         VALUES (?, ?, ?, ?, 'ACTIVE', 0,
                 CURRENT_UTCTIMESTAMP, ?, CURRENT_UTCTIMESTAMP, CURRENT_UTCTIMESTAMP,
                 CURRENT_UTCTIMESTAMP, ?, CURRENT_UTCTIMESTAMP, ?)`,
        [id, c.slug, c.name, c.description, INITIATOR, INITIATOR, INITIATOR],
      );
    }
    for (const c of toPublish) {
      // Existing ACTIVE row — only backfill publishedAt/publishedBy; leave
      // name/description/extractionCount untouched so admin curation isn't
      // clobbered.
      await tx.run(
        `UPDATE com_sap_developers_ims_Concepts
            SET publishedAt = CURRENT_UTCTIMESTAMP,
                publishedBy = ?,
                modifiedAt  = CURRENT_UTCTIMESTAMP,
                modifiedBy  = ?
          WHERE ID = ? AND publishedAt IS NULL`,
        [INITIATOR, INITIATOR, c.id],
      );
    }
  });

  console.log(`Done. Inserted ${toInsert.length}; published ${toPublish.length}; skipped ${skip.length}.`);
  console.log();
  console.log(`Verify:`);
  console.log(`  curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/kg-stats`);
  console.log(`  curl -s https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/build/concepts \\`);
  console.log(`    | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.concepts.filter(c=>/^(business-data-cloud|joule-studio|business-ai-platform|agentic-ai|abap-agentic-code-migration|joule-agents|cap-ai-agents|mdk-2|sap-architecture-center|n8n-integration|terraform-btp|btp-abap-env-2605|sap-cap-react|sap-cap-vue)$/.test(c.slug)).map(c=>c.slug))"`);
}

// Only run when invoked directly, not on import (test file imports the
// concept list).
if (import.meta.url === `file://${process.argv[1]}` ||
    // Windows: import.meta.url uses forward slashes, argv[1] uses backslashes.
    // Normalise both before comparing.
    import.meta.url.replace(/\\/g, '/').endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().then(() => process.exit(0)).catch(err => {
    console.error('FAILED:', err);
    process.exit(1);
  });
}
