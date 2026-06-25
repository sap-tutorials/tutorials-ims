#!/usr/bin/env node
'use strict';

/**
 * export-advocates.cjs — Snapshot the Developer Advocate roster to JSON.
 *
 * Reads every Advocates row (plus its topics, links, and photo BLOBs) from
 * the currently-bound CAP database and writes a self-contained snapshot to
 * .migration-data/advocates.json. The companion script import-advocates.cjs
 * restores the snapshot into any other CAP-bound DB.
 *
 * Spec: docs/superpowers/specs/2026-06-25-advocate-export-import-design.md
 *
 * Usage:
 *   cf login                              # to the source space (DEV typically)
 *   npm run export:advocates              # writes .migration-data/advocates.json
 *
 *   # Or explicitly:
 *   cds bind --exec -- node scripts/export-advocates.cjs
 *
 * Flags:
 *   --out <path>   Override the output file (default: .migration-data/advocates.json)
 *   --dry-run      Don't write the file; print summary only
 */

const cds = require('@sap/cds');
const fs = require('fs');
const path = require('path');
const {
  SCHEMA_VERSION,
  isHanaDb,
  advocateTableInfo,
} = require('./lib/advocate-io.cjs');

function parseArgs(argv) {
  const args = { out: '.migration-data/advocates.json', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--out') {
      if (i + 1 >= argv.length) { console.error('--out requires a value'); process.exit(2); }
      args.out = argv[++i];
    }
    else if (a === '--help' || a === '-h') {
      console.log(__filename, '- see header comment for usage');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  await cds.load('*');
  const db = await cds.connect.to('db');
  const isHana = isHanaDb(db);
  const T = advocateTableInfo(isHana);

  console.log(`[advocates-export] schemaVersion=${SCHEMA_VERSION}`);
  console.log(`[advocates-export] DB kind: ${db.kind} (isHana=${isHana})`);

  // Fetch every Advocate, left-joining Users to resolve email at export time.
  // No LargeBinary columns here, so no LOB-locator concern. We DO include
  // bio (LargeString / CLOB) — CLOBs return inline as JS strings on HANA,
  // unlike LargeBinary.
  //
  // Column aliases are quoted with mixed case so the JS-side result objects
  // expose `userEmail`, `firstName`, etc. — unquoted aliases come back
  // UPPERCASED from HANA.
  const c = T.cols;
  const advocateRows = await db.run(`
    SELECT
      A.${c.id}             AS "id",
      A.${c.slug}           AS "slug",
      A.${c.firstName}      AS "firstName",
      A.${c.lastName}       AS "lastName",
      A.${c.title}          AS "title",
      A.${c.pronouns}       AS "pronouns",
      A.${c.location}       AS "location",
      A.${c.region}         AS "region",
      A.${c.bio}            AS "bio",
      A.${c.isActive}       AS "isActive",
      A.${c.sortOverride}   AS "sortOverride",
      A.${c.joinedDate}     AS "joinedDate",
      A.${c.hasPhoto}       AS "hasPhoto",
      A.${c.photoUpdatedAt} AS "photoUpdatedAt",
      A.${c.photoUrl}       AS "photoUrl",
      U.${c.email}          AS "userEmail"
    FROM ${T.advocates} AS A
    LEFT JOIN ${T.users} AS U ON U.${c.id} = A.${c.userFk}
    ORDER BY A.${c.slug}
  `);
  console.log(`[advocates-export] Found ${advocateRows.length} advocate(s)`);

  // Detect duplicate userEmail values in source (would cause @assert.unique.user
  // violation on import). NULL emails are allowed multiple times — HANA's
  // UNIQUE-on-nullable treats NULLs as distinct.
  const seenEmails = new Map();
  for (const a of advocateRows) {
    if (!a.userEmail) continue;
    const lower = a.userEmail.toLowerCase();
    if (seenEmails.has(lower)) {
      throw new Error(
        `Two advocates have the same userEmail in source DB: ` +
        `'${seenEmails.get(lower)}' and '${a.slug}' both linked to ${a.userEmail}. ` +
        `Fix in source admin UI before re-running.`
      );
    }
    seenEmails.set(lower, a.slug);
  }

  // Topics — natural-key join on Tags.slug. Tags.slug is unique-asserted, so
  // one row per (advocate, tagSlug) pair. Inner join: if a Tag has been
  // deleted in source after the AdvocateTopic was created, the dangling
  // junction row is dropped from the export (it's already broken anyway).
  const topicRows = await db.run(`
    SELECT
      AT.${c.advocateFk} AS "advocateId",
      T.${c.slug}        AS "tagSlug"
    FROM ${T.topics} AS AT
    INNER JOIN ${T.tags} AS T ON T.${c.id} = AT.${c.tagFk}
    ORDER BY AT.${c.advocateFk}, T.${c.slug}
  `);

  const linkRows = await db.run(`
    SELECT
      ${c.advocateFk} AS "advocateId",
      ${c.kind}       AS "kind",
      ${c.url}        AS "url",
      ${c.label}      AS "label",
      ${c.sortOrder}  AS "sortOrder"
    FROM ${T.links}
    ORDER BY ${c.advocateFk}, ${c.sortOrder}, ${c.kind}
  `);

  // Index by advocate.id for assembly.
  const topicsByAdvocate = new Map();
  for (const t of topicRows) {
    if (!topicsByAdvocate.has(t.advocateId)) topicsByAdvocate.set(t.advocateId, []);
    topicsByAdvocate.get(t.advocateId).push({ tagSlug: t.tagSlug });
  }
  const linksByAdvocate = new Map();
  for (const l of linkRows) {
    if (!linksByAdvocate.has(l.advocateId)) linksByAdvocate.set(l.advocateId, []);
    linksByAdvocate.get(l.advocateId).push({
      kind: l.kind,
      url: l.url,
      label: l.label,
      sortOrder: l.sortOrder,
    });
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    sourceDb: `${db.kind} (${process.env.CF_ORGANIZATION_NAME || 'unknown-org'}/${process.env.CF_SPACE_NAME || 'unknown-space'})`,
    advocateCount: advocateRows.length,
    advocates: advocateRows.map(a => ({
      slug: a.slug,
      firstName: a.firstName,
      lastName: a.lastName,
      title: a.title,
      pronouns: a.pronouns,
      location: a.location,
      region: a.region,
      bio: a.bio,
      isActive: a.isActive,
      sortOverride: a.sortOverride,
      joinedDate: a.joinedDate,
      hasPhoto: a.hasPhoto,
      photoUpdatedAt: a.photoUpdatedAt,
      photoUrl: a.photoUrl,
      userEmail: a.userEmail || null,
      topics: topicsByAdvocate.get(a.id) || [],
      links:  linksByAdvocate.get(a.id)  || [],
      photo:  null,  // populated in Task 3
    })),
  };

  const topicsCount = [...topicsByAdvocate.values()].reduce((n, arr) => n + arr.length, 0);
  const linksCount  = [...linksByAdvocate.values()].reduce((n, arr) => n + arr.length, 0);
  console.log(`[advocates-export] Topics: ${topicsCount}, Links: ${linksCount}`);

  if (args.dryRun) {
    console.log('[advocates-export] --dry-run: would write payload (no file)');
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(payload, null, 2));
  const bytes = fs.statSync(args.out).size;
  console.log(`[advocates-export] Wrote ${args.out} (${(bytes / 1024).toFixed(1)} KB)`);
})().catch(err => {
  console.error('[advocates-export] FAILED:', err);
  process.exit(1);
});
