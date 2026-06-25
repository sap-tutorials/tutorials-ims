#!/usr/bin/env node
'use strict';

/**
 * import-advocates.cjs — Restore the Developer Advocate roster from a JSON snapshot.
 *
 * Reads .migration-data/advocates.json (produced by scripts/export-advocates.cjs)
 * and upserts each advocate into the currently-bound CAP database. Idempotent:
 * re-running converges target to match source. Topics/links/photo are
 * replace-not-merge.
 *
 * Uses raw cds.db.run() against entity-level CQN — no AdminService, no sharp
 * re-encoding, no after-handlers, no draft-table indirection.
 *
 * Spec: docs/superpowers/specs/2026-06-25-advocate-export-import-design.md
 *
 * Usage:
 *   cf login                              # to the target space (PROD typically)
 *   npm run import:advocates              # reads .migration-data/advocates.json
 *
 *   # Or explicitly:
 *   cds bind --exec -- node scripts/import-advocates.cjs
 *
 * Flags:
 *   --in <path>    Override the input file (default: .migration-data/advocates.json)
 */

const cds = require('@sap/cds');
const fs = require('fs');
const crypto = require('crypto');
const {
  VALID_REGIONS,
  VALID_LINK_KINDS,
  assertSchemaVersion,
  isHanaDb,
  advocateTableInfo,
} = require('./lib/advocate-io.cjs');

// better-sqlite3 rejects JS booleans as bind values; coerce to 0/1.
// HANA accepts integers for BOOLEAN columns equally well.
const boolToInt = (v) => (v === true ? 1 : v === false ? 0 : v);

function parseArgs(argv) {
  const args = { in: '.migration-data/advocates.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') {
      if (i + 1 >= argv.length) { console.error('--in requires a value'); process.exit(2); }
      args.in = argv[++i];
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

  if (!fs.existsSync(args.in)) {
    console.error(`[advocates-import] Input file not found: ${args.in}`);
    console.error(`[advocates-import] Run 'npm run export:advocates' first.`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(args.in, 'utf8'));
  assertSchemaVersion(payload);

  await cds.load('*');
  const db = await cds.connect.to('db');
  const isHana = isHanaDb(db);
  const T = advocateTableInfo(isHana);

  console.log(`[advocates-import] schemaVersion=${payload.schemaVersion}`);
  console.log(`[advocates-import] Source: ${payload.sourceDb || 'unknown'} (exported ${payload.exportedAt})`);
  console.log(`[advocates-import] Target DB kind: ${db.kind} (isHana=${isHana})`);
  console.log(`[advocates-import] Advocates in payload: ${payload.advocateCount}`);

  const c = T.cols;
  const stats = {
    advocates: { inserted: 0, updated: 0 },
    users:     { matched: 0, nulled: 0, nulledEmails: new Set() },
    topics:    { matched: 0, skipped: 0, missingTags: new Set() },
    links:     { inserted: 0 },
    photos:    { imported: 0, absent: 0 },
  };

  for (const adv of payload.advocates) {
    // ── Lightweight payload validation ──────────────────────────────
    if (!adv.slug)      throw new Error(`Advocate missing slug: ${JSON.stringify(adv).slice(0, 200)}`);
    if (!adv.firstName) throw new Error(`Advocate ${adv.slug} missing firstName`);
    if (!adv.lastName)  throw new Error(`Advocate ${adv.slug} missing lastName`);
    if (adv.region && !VALID_REGIONS.has(adv.region)) {
      throw new Error(`Advocate ${adv.slug} has invalid region: ${adv.region}`);
    }

    // ── Resolve user_ID by email (case-insensitive) ────────────────
    let userId = null;
    if (adv.userEmail) {
      const matches = await db.run(
        `SELECT ${c.id} AS "id" FROM ${T.users}
         WHERE LOWER(${c.email}) = LOWER(?)
         ORDER BY ${c.createdAt} ASC`,
        [adv.userEmail]
      );
      if (matches.length > 0) {
        userId = matches[0].id;
        stats.users.matched++;
        if (matches.length > 1) {
          console.warn(`[${adv.slug}] WARN: ${matches.length} Users rows match email ${adv.userEmail} — picking earliest createdAt`);
        }
      } else {
        stats.users.nulled++;
        stats.users.nulledEmails.add(adv.userEmail);
        console.warn(`[${adv.slug}] user FK not resolved: ${adv.userEmail} missing in target — inserting with user_ID=NULL`);
      }
    }

    // ── Upsert Advocates ────────────────────────────────────────────
    const existing = await db.run(
      `SELECT ${c.id} AS "id" FROM ${T.advocates} WHERE ${c.slug} = ?`,
      [adv.slug]
    );

    const advocateId = existing.length > 0 ? existing[0].id : crypto.randomUUID();
    const isUpdate = existing.length > 0;

    // Single source of truth for column→value pairs. One array is fragile;
    // an object literal can't drift. Pattern mirrors scripts/migrate-from-hana.js.
    const updates = {
      [c.firstName]:      adv.firstName,
      [c.lastName]:       adv.lastName,
      [c.title]:          adv.title,
      [c.pronouns]:       adv.pronouns,
      [c.location]:       adv.location,
      [c.region]:         adv.region,
      [c.bio]:            adv.bio,
      [c.isActive]:       boolToInt(adv.isActive),
      [c.sortOverride]:   adv.sortOverride,
      [c.joinedDate]:     adv.joinedDate,
      [c.hasPhoto]:       boolToInt(adv.hasPhoto),
      [c.photoUpdatedAt]: adv.photoUpdatedAt,
      [c.photoUrl]:       adv.photoUrl,
      [c.userFk]:         userId,
    };
    const updateCols = Object.keys(updates);
    const updateVals = Object.values(updates);

    if (isUpdate) {
      const setClause = updateCols.map(col => `${col} = ?`).join(', ');
      await db.run(
        `UPDATE ${T.advocates} SET ${setClause} WHERE ${c.id} = ?`,
        [...updateVals, advocateId]
      );
      stats.advocates.updated++;
    } else {
      const allCols = [c.id, c.slug, ...updateCols].join(', ');
      const placeholders = ['?', '?', ...updateCols.map(() => '?')].join(', ');
      await db.run(
        `INSERT INTO ${T.advocates} (${allCols}) VALUES (${placeholders})`,
        [advocateId, adv.slug, ...updateVals]
      );
      stats.advocates.inserted++;
    }

    // ── Replace topics ──────────────────────────────────────────────
    await db.run(
      `DELETE FROM ${T.topics} WHERE ${c.advocateFk} = ?`,
      [advocateId]
    );
    for (const t of (adv.topics || [])) {
      const tagRows = await db.run(
        `SELECT ${c.id} AS "id" FROM ${T.tags} WHERE ${c.slug} = ?`,
        [t.tagSlug]
      );
      if (tagRows.length === 0) {
        stats.topics.skipped++;
        stats.topics.missingTags.add(t.tagSlug);
        console.warn(`[${adv.slug}] topic skipped: tag '${t.tagSlug}' missing in target`);
        continue;
      }
      await db.run(
        `INSERT INTO ${T.topics} (${c.id}, ${c.advocateFk}, ${c.tagFk})
         VALUES (?, ?, ?)`,
        [crypto.randomUUID(), advocateId, tagRows[0].id]
      );
      stats.topics.matched++;
    }

    // ── Replace links ───────────────────────────────────────────────
    await db.run(
      `DELETE FROM ${T.links} WHERE ${c.advocateFk} = ?`,
      [advocateId]
    );
    for (const l of (adv.links || [])) {
      if (!VALID_LINK_KINDS.has(l.kind)) {
        throw new Error(`Advocate ${adv.slug} has link with invalid kind: ${l.kind}`);
      }
      await db.run(
        `INSERT INTO ${T.links}
           (${c.id}, ${c.advocateFk}, ${c.kind}, ${c.url}, ${c.label}, ${c.sortOrder})
         VALUES (?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), advocateId, l.kind, l.url, l.label, l.sortOrder]
      );
      stats.links.inserted++;
    }

    // ── Replace photo ───────────────────────────────────────────────
    await db.run(
      `DELETE FROM ${T.photos} WHERE ${c.advocateFk} = ?`,
      [advocateId]
    );
    if (adv.photo) {
      const photo256 = Buffer.from(adv.photo.photo256_b64, 'base64');
      const photo64  = Buffer.from(adv.photo.photo64_b64,  'base64');
      await db.run(
        `INSERT INTO ${T.photos}
           (${c.advocateFk}, ${c.photo256}, ${c.photo64}, ${c.photoMimeType},
            ${c.sizeBytes},  ${c.sha256},   ${c.uploadedAt})
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [advocateId, photo256, photo64, adv.photo.photoMimeType,
         adv.photo.sizeBytes, adv.photo.sha256, adv.photo.uploadedAt]
      );
      stats.photos.imported++;
    } else {
      stats.photos.absent++;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log('');
  console.log(`[advocates-import] Imported ${payload.advocateCount} advocates: ${stats.advocates.updated} updated, ${stats.advocates.inserted} inserted`);
  console.log(`[advocates-import] FK resolution: ${stats.users.matched} users matched, ${stats.users.nulled} NULLed`);
  if (stats.users.nulled > 0) {
    console.log(`                   (${[...stats.users.nulledEmails].join(', ')})`);
  }
  if (stats.topics.skipped > 0) {
    const tagsList = [...stats.topics.missingTags].join(', ');
    console.log(`[advocates-import] Topics:  ${stats.topics.matched} matched, ${stats.topics.skipped} skipped`);
    console.log(`                   (missing tags: ${tagsList})`);
  } else {
    console.log(`[advocates-import] Topics:  ${stats.topics.matched} matched, 0 skipped`);
  }
  console.log(`[advocates-import] Links:   ${stats.links.inserted} inserted`);
  console.log(`[advocates-import] Photos:  ${stats.photos.imported} imported, ${stats.photos.absent} had no photo`);
  console.log(`[advocates-import] Done.`);
})().catch(err => {
  console.error('[advocates-import] FAILED:', err);
  process.exit(1);
});
