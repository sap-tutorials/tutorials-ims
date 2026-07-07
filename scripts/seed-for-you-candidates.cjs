#!/usr/bin/env node
'use strict';

/**
 * seed-for-you-candidates.cjs — Seed the HomepageForYouCandidates pool.
 *
 * The "For you" row on the developer-portal homepage draws from
 * `com.sap.developers.ims.HomepageForYouCandidates`. The pool must hold
 * at least 15 active rows so every role/cloud/deployment combo has ≥3
 * matches — otherwise the row is hidden entirely (see the min:3 guard in
 * srv/lib/homepage/persona-scoring.js and the runbook at
 * docs/authors/homepage-for-you-runbook.md §"Healthy pool size").
 *
 * This script is idempotent. It reads the current set of
 * `targetSlug` values in the target DB and only inserts rows whose slug
 * is not already present. Re-running is safe and is the intended way to
 * top-up after a curator has deleted a few rows manually.
 *
 * Deliberately NOT a CSV under db/data/. Every deploy that changes a
 * CSV hash rewrites every `import_columns` column on every existing
 * row of that table — which would wipe curator edits to personaTags,
 * personaWeight, personaHidden, active. See MEMORY.md
 * "CSV changes wipe admin-editable columns on deploy" (issue #1029).
 *
 * Prerequisites:
 *   - `cf login` to the target space (DEV by default).
 *   - `cds bind --to <tutorials-db>` (creates .cdsrc-private.json).
 *
 * Usage:
 *   cds bind --exec -- node scripts/seed-for-you-candidates.cjs --dry-run
 *   cds bind --exec -- node scripts/seed-for-you-candidates.cjs --commit
 *
 * Flags:
 *   --dry-run    Print what would be inserted; do not write. Mutually
 *                exclusive with --commit. One of the two is required —
 *                same convention as scripts/seed-blog-posts.cjs so nobody
 *                accidentally writes production data.
 *   --commit     Actually perform the insert.
 *   --force      Insert even if a matching targetSlug already exists.
 *                (Adds a second row for the same target — rare;
 *                normally curator edits are preserved by NOT re-inserting.)
 */

const cds = require('@sap/cds');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const COMMIT  = args.includes('--commit');
const FORCE   = args.includes('--force');

if (DRY_RUN === COMMIT) {
  console.error('Refusing to run without exactly one of --dry-run or --commit.');
  process.exit(2);
}

// ── Row set ──────────────────────────────────────────────────────────────
//
// Design goals:
//   • ≥15 active rows so a fresh DEV env clears the min:3 threshold for
//     every role/cloud/deployment profile the homepage vocabulary allows.
//   • Every row carries ≥1 persona tag. Untagged rows never surface — the
//     "For you" scorer requires at least one tag match (persona-scoring.js).
//   • Slugs point at tutorials that exist under hugo/content/tutorials/ so
//     the nightly link-health job does not flip them to BROKEN.
//   • Weight is 3–7 for strong matches, 0 for generic reach. Avoid the
//     ±8..±10 extremes reserved for uniquely important content (runbook).
//   • `active: true` and `linkStatus: 'UNKNOWN'` — the nightly job will
//     set OK/BROKEN on next run.
//
// Persona-tag grammar comes from srv/lib/branch/profile-fields.js:
//   role:{developer|architect|sysadmin|student}
//   deployment:{cloud|onprem}
//   cloud:{btp|aws|azure|gcp|alibaba|oracle|ibm}
//
// The `sortOrder` column ties matched-weight rows; keep 100 as the default
// and only vary it to force a specific display position among equals.

const ROWS = [
  // ── CAP + BTP starters — developer × cloud:btp ────────────────────────
  {
    kind: 'tutorial',
    targetSlug: 'btp-cap-beginner-golden-path',
    title: 'CAP Golden Path for Beginners',
    description: 'End-to-end tour of building, running, and deploying a CAP app on BTP.',
    personaTags: ['role:developer', 'role:student', 'cloud:btp', 'deployment:cloud'],
    personaWeight: 5,
  },
  {
    kind: 'tutorial',
    targetSlug: 'cap-service-deploy',
    title: 'Deploy a CAP Service',
    description: 'Package a CAP service and deploy it to Cloud Foundry on SAP BTP.',
    personaTags: ['role:developer', 'cloud:btp', 'deployment:cloud'],
    personaWeight: 4,
  },
  {
    kind: 'tutorial',
    targetSlug: 'appstudio-cap-java',
    title: 'Build a CAP Java App in Business Application Studio',
    description: 'Scaffold and run a CAP Java project directly in the browser IDE.',
    personaTags: ['role:developer', 'cloud:btp', 'deployment:cloud'],
    personaWeight: 3,
  },
  {
    kind: 'tutorial',
    targetSlug: 'btp-cf-deploy-mta',
    title: 'Deploy an MTA to Cloud Foundry',
    description: 'The canonical mbt-build + cf-deploy loop that every BTP app ships with.',
    personaTags: ['role:developer', 'role:sysadmin', 'cloud:btp', 'deployment:cloud'],
    personaWeight: 4,
  },

  // ── AI Core & GenAI — developer/architect × cloud:btp ─────────────────
  {
    kind: 'tutorial',
    targetSlug: 'ai-core-setup',
    title: 'Set up SAP AI Core',
    description: 'Provision AI Core and get your first foundation-model prompt working.',
    personaTags: ['role:developer', 'role:architect', 'cloud:btp', 'deployment:cloud'],
    personaWeight: 6,
  },
  {
    kind: 'tutorial',
    targetSlug: 'ai-core-orchestration-consumption-v2',
    title: 'Call the AI Core Orchestration Service',
    description: 'Consume grounding, templates, and content filters from a single API.',
    personaTags: ['role:developer', 'cloud:btp'],
    personaWeight: 4,
  },
  {
    kind: 'tutorial',
    targetSlug: 'ai-core-genaihub-provisioning',
    title: 'Provision Generative AI Hub',
    description: 'Enable Generative AI Hub in your BTP subaccount so teams can consume LLMs.',
    personaTags: ['role:architect', 'role:sysadmin', 'cloud:btp'],
    personaWeight: 5,
  },
  {
    kind: 'tutorial',
    targetSlug: 'ai-core-genai-hana-vector',
    title: 'Vector Search with HANA Cloud & GenAI Hub',
    description: 'Combine HANA Cloud vector engine and GenAI Hub for RAG scenarios.',
    personaTags: ['role:developer', 'role:architect', 'cloud:btp'],
    personaWeight: 4,
  },

  // ── HANA Cloud — architect × cloud:btp ────────────────────────────────
  {
    kind: 'tutorial',
    targetSlug: 'hana-cloud-mission-extend-01',
    title: 'Extend a HANA Cloud Data Model',
    description: 'Model, deploy, and query an extension schema on HANA Cloud.',
    personaTags: ['role:developer', 'role:architect', 'cloud:btp'],
    personaWeight: 3,
  },

  // ── Integration Suite — architect × cloud:btp ────────────────────────
  {
    kind: 'tutorial',
    targetSlug: 'btp-integration-suite-design-guidelines',
    title: 'Integration Suite Design Guidelines',
    description: 'Reference patterns for building enterprise integrations on BTP.',
    personaTags: ['role:architect', 'cloud:btp'],
    personaWeight: 5,
  },
  {
    kind: 'tutorial',
    targetSlug: 'api-mgmt-kyma-getting-started',
    title: 'Get Started with API Management on Kyma',
    description: 'Expose and secure a Kyma-hosted API through SAP API Management.',
    personaTags: ['role:developer', 'role:architect', 'cloud:btp'],
    personaWeight: 3,
  },

  // ── Kyma / operations — developer/sysadmin × cloud:btp ────────────────
  {
    kind: 'tutorial',
    targetSlug: 'btp-cli-setup-kyma-cluster',
    title: 'Provision a Kyma Cluster from the BTP CLI',
    description: 'Spin up a Kyma runtime environment in your subaccount without the cockpit.',
    personaTags: ['role:developer', 'role:sysadmin', 'cloud:btp', 'deployment:cloud'],
    personaWeight: 3,
  },

  // ── ABAP Cloud — developer × deployment:cloud ─────────────────────────
  {
    kind: 'tutorial',
    targetSlug: 'abap-cloud-ui-from-interface',
    title: 'Build an ABAP Cloud UI from an Interface',
    description: 'RAP-first UI generation for ABAP Cloud developers on BTP.',
    personaTags: ['role:developer', 'cloud:btp', 'deployment:cloud'],
    personaWeight: 3,
  },
  {
    kind: 'tutorial',
    targetSlug: 'abap-environment-create-abap-cloud-project',
    title: 'Create Your First ABAP Cloud Project',
    description: 'Set up ADT, connect to the ABAP environment, and create a package.',
    personaTags: ['role:developer', 'cloud:btp', 'deployment:cloud'],
    personaWeight: 3,
  },

  // ── Ops & administration — sysadmin × cloud:btp ───────────────────────
  {
    kind: 'tutorial',
    targetSlug: 'btp-cockpit-cf-getting-started-with-cf-env-and-cockpit',
    title: 'Cloud Foundry Environment & Cockpit Basics',
    description: 'Navigate the BTP cockpit and CF spaces for day-1 operations.',
    personaTags: ['role:sysadmin', 'role:student', 'cloud:btp', 'deployment:cloud'],
    personaWeight: 4,
  },
  {
    kind: 'tutorial',
    targetSlug: 'btp-cockpit-cf-managing-org-members',
    title: 'Manage Cloud Foundry Org Members',
    description: 'Invite users, assign roles, and audit membership at org level.',
    personaTags: ['role:sysadmin', 'cloud:btp'],
    personaWeight: 5,
  },
  {
    kind: 'tutorial',
    targetSlug: 'btp-cockpit-setup',
    title: 'Set up Your BTP Cockpit',
    description: 'First-time cockpit walkthrough: entitlements, subaccounts, and quotas.',
    personaTags: ['role:sysadmin', 'role:student', 'cloud:btp'],
    personaWeight: 3,
  },

  // ── Student on-ramp — student × cloud:btp ─────────────────────────────
  {
    kind: 'tutorial',
    targetSlug: 'btp-free-tier-account',
    title: 'Get a BTP Free Tier Account',
    description: 'Start building on BTP with a free tier — no credit card required.',
    personaTags: ['role:student', 'cloud:btp', 'deployment:cloud'],
    personaWeight: 7,
    sortOrder: 50,
  },

  // ── Joule agents — developer/architect ────────────────────────────────
  {
    kind: 'tutorial',
    targetSlug: 'joule-studio-codejam-0-overview',
    title: 'Joule Studio CodeJam Overview',
    description: 'Introduction to building custom agents in Joule Studio.',
    personaTags: ['role:developer', 'role:architect', 'cloud:btp'],
    personaWeight: 3,
  },

  // ── Hyperscaler-specific tilts — cloud:{aws|azure|gcp} ────────────────
  //
  // A single row per hyperscaler is enough to lift the ranker above the
  // 3-match threshold for a user whose cloud is set to that provider.
  // The runbook flags AWS-tagged content as a strong +5..+7 weight case.
  {
    kind: 'tutorial',
    targetSlug: 'ai-core-azure',
    title: 'Consume Azure OpenAI Models via AI Core',
    description: 'Route Azure OpenAI calls through SAP AI Core orchestration.',
    personaTags: ['role:developer', 'role:architect', 'cloud:azure', 'cloud:btp'],
    personaWeight: 6,
  },
  {
    kind: 'tutorial',
    targetSlug: 'btp-hyperscaler-extension',
    title: 'Extend SAP with Hyperscaler Services',
    description: 'Wire an AWS, Azure, or GCP service into a BTP extension.',
    personaTags: [
      'role:developer', 'role:architect',
      'cloud:aws', 'cloud:azure', 'cloud:gcp',
      'deployment:cloud',
    ],
    personaWeight: 5,
  },

  // ── External community content — role reach, no cloud narrowing ───────
  {
    kind: 'blog',
    targetSlug: 'https://community.sap.com/t5/technology-blogs-by-sap/bg-p/technology-blog-sap',
    title: 'SAP Technology Blog Posts',
    description: 'Latest technology deep-dives from SAP product teams and advocates.',
    personaTags: ['role:developer', 'role:architect'],
    personaWeight: 0,
    sortOrder: 200,
  },

  // ── On-prem cohort — deployment:onprem ────────────────────────────────
  //
  // On-prem developers/architects need at least 3 matching rows too, or
  // the whole "For you" row disappears for them. Two tutorials that
  // work equally well in on-prem contexts (ABAP + integration) plus the
  // community blog row above give them a valid 3-match pool.
  {
    kind: 'tutorial',
    targetSlug: 'abap-connectivity-daemon-simple',
    title: 'ABAP Connectivity Daemon — Getting Started',
    description: 'Bridge on-prem ABAP systems to messaging endpoints via the daemon.',
    personaTags: ['role:developer', 'deployment:onprem'],
    personaWeight: 3,
  },
  {
    kind: 'tutorial',
    targetSlug: 'abap-custom-analytical-queries',
    title: 'Build Custom Analytical Queries in S/4HANA',
    description: 'Model analytical CDS views and expose them as queries in S/4HANA.',
    personaTags: ['role:developer', 'role:architect', 'deployment:onprem'],
    personaWeight: 4,
  },
];

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  // Load the CDS model so `cds.entities(...)` is callable. The serving
  // lifecycle does this for you; `cds bind --exec` does not. Pattern
  // borrowed from scripts/seed-blog-posts.cjs — cds.linked + priming
  // cds.model.entities BEFORE connect. See #757 / #911.
  cds.model = cds.linked(await cds.load('*'));
  void cds.model.entities;
  const db = await cds.connect.to('db');
  const { HomepageForYouCandidates } = cds.entities('com.sap.developers.ims');

  console.log(`[for-you-seed] Target DB kind: ${db.kind}`);
  console.log(`[for-you-seed] Rows in the seed set: ${ROWS.length}`);
  console.log(`[for-you-seed] Dry run: ${DRY_RUN ? 'YES — no writes' : 'no'}`);
  console.log(`[for-you-seed] Force: ${FORCE ? 'YES — will insert duplicates' : 'no'}`);

  // Read existing targetSlug set so we can skip rows the curator (or a
  // prior run of this script) already has. Idempotency lives here — the
  // schema has no unique index on targetSlug.
  const existing = await db.run(
    SELECT.from(HomepageForYouCandidates).columns('targetSlug'),
  );
  const existingSlugs = new Set(existing.map((r) => r.targetSlug));
  console.log(`[for-you-seed] Existing rows: ${existing.length}`);

  const toInsert = [];
  const skipped = [];
  for (const row of ROWS) {
    if (!FORCE && existingSlugs.has(row.targetSlug)) {
      skipped.push(row.targetSlug);
      continue;
    }
    toInsert.push({
      // ID + timestamps are supplied by cuid + managed aspects.
      kind: row.kind,
      targetSlug: row.targetSlug,
      title: row.title,
      description: row.description ?? null,
      imageUrl: row.imageUrl ?? null,
      personaTags: row.personaTags,
      personaWeight: row.personaWeight ?? 0,
      personaHidden: row.personaHidden ?? [],
      sortOrder: row.sortOrder ?? 100,
      active: true,
      linkStatus: 'UNKNOWN',
    });
  }

  console.log(`[for-you-seed] Will insert: ${toInsert.length}`);
  console.log(`[for-you-seed] Will skip:   ${skipped.length}${skipped.length ? ` (${skipped.join(', ')})` : ''}`);

  if (DRY_RUN) {
    console.log('[for-you-seed] Dry run — done.');
    process.exit(0);
  }

  if (toInsert.length === 0) {
    console.log('[for-you-seed] Nothing to do.');
    process.exit(0);
  }

  await db.run(INSERT.into(HomepageForYouCandidates).entries(toInsert));

  // Verify by re-reading — same trap as MEMORY probe-observe-not-assert-shape:
  // asserting the write happened by checking a COUNT(*) delta on real rows.
  const after = await db.run(
    SELECT.from(HomepageForYouCandidates).columns('targetSlug'),
  );
  console.log(`[for-you-seed] Row count now: ${after.length} (was ${existing.length}, expected ${existing.length + toInsert.length})`);

  // Print a per-role match preview so the curator can eyeball coverage
  // without needing to open the admin UI.
  const full = await db.run(
    SELECT.from(HomepageForYouCandidates)
      .where({ active: true })
      .columns('personaTags'),
  );
  const roleCounts = { developer: 0, architect: 0, sysadmin: 0, student: 0 };
  for (const r of full) {
    const tags = Array.isArray(r.personaTags)
      ? r.personaTags
      : (r.personaTags ? JSON.parse(r.personaTags) : []);
    for (const role of Object.keys(roleCounts)) {
      if (tags.includes(`role:${role}`)) roleCounts[role] += 1;
    }
  }
  console.log('[for-you-seed] Active rows matching each role:');
  for (const [role, n] of Object.entries(roleCounts)) {
    const flag = n >= 3 ? 'OK ' : '!! ';
    console.log(`  ${flag}role:${role} → ${n}${n < 3 ? ' (min 3 required for the row to render)' : ''}`);
  }

  console.log('[for-you-seed] Done.');
})().catch((err) => {
  console.error('[for-you-seed] FAILED:', err.message || err);
  console.error(err.stack);
  process.exit(1);
});
