#!/usr/bin/env node
// scripts/repair-author-id-phase-c.cjs
//
// One-shot repair for the #862 reopen: Tutorials.author_ID rows that were
// set exclusively via the removed Phase (c) `ownerEmail` fallback in
// resolveTutorialAuthor.js. On DEV that path silently promoted 36
// tutorials to the wrong "author" because their TutorialMeta.ownerEmail
// carried a stale monitoring assignment from the legacy IMS migration.
//
// Algorithm (per tutorial with author_ID IS NOT NULL):
//   1. Rebuild the resolver's inputs from HANA:
//      - contributors  ← TutorialContributors rows for this tutorial
//      - ownerEmail    ← TutorialMeta.ownerEmail
//      - frontmatterGithubLogin ← left null (not stored on the row; the
//        publish path is where this signal enters. If Phase 0 originally
//        placed the author_ID, we can't reproduce it here — but that also
//        means we can't tell it apart from a Phase (c) hit. We take a
//        conservative stance below).
//   2. Run resolveTutorialAuthor with the NEW code (Phase (c) removed).
//   3. Classify the row:
//      - Resolver returns authorUserId === current row.author_ID  → OK
//        (Phase 0/a/b re-produces the same answer independently)
//      - Resolver returns a DIFFERENT authorUserId  → conflict — LEAVE
//        the row alone and log. Ops decides.
//      - Resolver returns null  → the current author_ID could only have
//        come from the removed Phase (c) OR from a Phase 0 signal that
//        no longer holds (frontmatter changed, admin correction cleared,
//        etc.). Null it out. This is the load-bearing repair.
//   4. Never touch tutorials where TutorialContributors is empty AND
//      TutorialMeta.ownerEmail matches Users.email of the current
//      author_ID's Users row AND the resolver returned null → those are
//      the exact class of bug this script exists for.
//
// Idempotency: WHERE author_ID IS NOT NULL is the only filter. Re-runs
// after --commit are a no-op because the rows we cleared are now NULL.
//
// Flags:
//   --dry-run   (default) preview only, print classifications + a CSV
//   --commit    apply UPDATE ... SET author_ID = NULL for the null-out set
//   --initiator <str> audit label; defaults to `scripts/repair-author-id-phase-c`
//
// Usage:
//   npx cds bind --exec -- node scripts/repair-author-id-phase-c.cjs
//   npx cds bind --exec -- node scripts/repair-author-id-phase-c.cjs --commit

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const cds = require('@sap/cds');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const initIdx = argv.indexOf('--initiator');
const INITIATOR =
  initIdx >= 0
    ? argv[initIdx + 1]
    : process.env.INITIATOR || 'scripts/repair-author-id-phase-c';

const T_TUTORIALS = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"';
const T_CONTRIBUTORS = '"COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS"';
const T_TUTORIAL_META = '"COM_SAP_DEVELOPERS_IMS_TUTORIALMETA"';
const T_USERS = '"COM_SAP_DEVELOPERS_IMS_USERS"';

async function main() {
  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const db = await cds.connect.to('db');

  const { resolveTutorialAuthor } = await import('../srv/lib/resolve-tutorial-author.js');

  console.log(`[repair] mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'} initiator=${INITIATOR}\n`);

  // Prime the email → Users.ID map ONCE. Same shape used by the resolver's
  // caller.
  const userRows = await db.run(
    `SELECT "ID" AS id, LOWER(TRIM("EMAIL")) AS email FROM ${T_USERS} WHERE "EMAIL" IS NOT NULL AND LENGTH(TRIM("EMAIL")) > 0`,
  );
  const emailToUserId = new Map();
  for (const r of userRows || []) {
    const email = r.email || r.EMAIL;
    const id = r.id || r.ID;
    if (email && !emailToUserId.has(email)) emailToUserId.set(email, id);
  }
  console.log(`[repair] loaded ${emailToUserId.size} Users emails`);

  // The scope: every tutorial that currently has a non-null author_ID.
  // We DELIBERATELY don't restrict by ownerEmail here — some Phase (c)
  // hits used a legitimate ownerEmail that later became stale, and we
  // want to catch every case where the resolver (Phase 0/a/b only) can't
  // reproduce the current value.
  const rows = await db.run(
    `SELECT "ID" AS id, "SLUG" AS slug, "AUTHOR_ID" AS author_id FROM ${T_TUTORIALS} WHERE "AUTHOR_ID" IS NOT NULL`,
  );
  console.log(`[repair] scanning ${rows.length} tutorial(s) with author_ID set\n`);

  const summary = {
    ok: 0,
    conflict: 0,
    nullOut: 0,
  };
  const nullOutList = []; // rows we'd clear (or did clear)
  const conflictList = []; // resolver disagrees — LEAVE ALONE, log

  for (const t of rows) {
    const tutorialId = t.id ?? t.ID;
    const slug = t.slug ?? t.SLUG;
    const currentAuthor = t.author_id ?? t.AUTHOR_ID;

    const contribRows = await db.run(
      `SELECT "EMAIL" AS email, "ROLE" AS role FROM ${T_CONTRIBUTORS} WHERE "TUTORIAL_ID" = ?`,
      [tutorialId],
    );
    const contributors = (contribRows || []).map(r => ({
      email: r.email ?? r.EMAIL ?? null,
      role: r.role ?? r.ROLE ?? null,
    }));

    let ownerEmail = null;
    const metaRows = await db.run(
      `SELECT "OWNEREMAIL" AS owneremail FROM ${T_TUTORIAL_META} WHERE "TUTORIAL_ID" = ?`,
      [tutorialId],
    );
    if (metaRows.length > 0) ownerEmail = metaRows[0].owneremail ?? metaRows[0].OWNEREMAIL ?? null;

    // Run the resolver WITHOUT Phase (c) — the new post-#862-reopen code.
    // frontmatterGithubLogin is not persisted on the row; if the original
    // set was a Phase 0 hit, the resolver returns null here (no map input)
    // and we conservatively null the row. Ops can re-run linkTutorialAuthorship
    // during the next publish which WILL re-establish Phase 0 hits.
    const resolved = resolveTutorialAuthor({
      contributors,
      ownerEmail,
      emailToUserId,
      frontmatterGithubLogin: null,
      loginToUserId: new Map(),
    });

    if (resolved.authorUserId === currentAuthor) {
      summary.ok++;
      continue;
    }
    if (resolved.authorUserId && resolved.authorUserId !== currentAuthor) {
      summary.conflict++;
      conflictList.push({
        slug,
        current: currentAuthor,
        wouldBe: resolved.authorUserId,
        source: resolved.source,
      });
      continue;
    }
    // resolved.authorUserId === null → current author_ID is unreachable
    // via Phase 0/a/b. This is the load-bearing repair.
    summary.nullOut++;
    nullOutList.push({ slug, current: currentAuthor, ownerEmail });
  }

  console.log(`[repair] classified ${rows.length} rows:`);
  console.log(`  ok           ${summary.ok}   (resolver reproduces current author_ID via Phase 0/a/b)`);
  console.log(`  conflict     ${summary.conflict}   (resolver disagrees — LEAVING ALONE)`);
  console.log(`  null-out     ${summary.nullOut}   (only reachable via removed Phase (c) or lost signals)`);
  console.log();

  // Dump the null-out list so ops can review before --commit.
  if (nullOutList.length > 0) {
    const csvPath = path.join('.migration-data', `repair-author-id-phase-c-${Date.now()}.csv`);
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    const csvLines = [
      'slug,current_author_id,current_ownerEmail',
      ...nullOutList.map(r => `${r.slug},${r.current},${JSON.stringify(r.ownerEmail ?? '')}`),
    ];
    fs.writeFileSync(csvPath, csvLines.join('\n') + '\n', 'utf8');
    console.log(`[repair] null-out preview written to ${csvPath}`);
    console.log(`[repair] first 10 slugs to null:`);
    for (const r of nullOutList.slice(0, 10)) {
      console.log(`  - ${r.slug}  (ownerEmail: ${r.ownerEmail ?? '<null>'})`);
    }
    console.log();
  }
  if (conflictList.length > 0) {
    console.log(`[repair] first 10 conflicts (ops should review):`);
    for (const r of conflictList.slice(0, 10)) {
      console.log(`  - ${r.slug}  current=${r.current}  wouldBe=${r.wouldBe} (${r.source})`);
    }
    console.log();
  }

  if (!COMMIT) {
    console.log('[repair] DRY-RUN — no changes written. Re-run with --commit to apply.');
    return;
  }

  console.log(`[repair] applying ${nullOutList.length} UPDATE(s)…`);
  let cleared = 0;
  await db.tx(async tx => {
    for (const r of nullOutList) {
      // Idempotent: filter to the specific current author_ID so a
      // concurrent publish that just moved the row (via Phase 0/a/b)
      // doesn't get accidentally cleared.
      const res = await tx.run(
        `UPDATE ${T_TUTORIALS}
            SET "AUTHOR_ID" = NULL,
                "MODIFIEDAT" = CURRENT_UTCTIMESTAMP,
                "MODIFIEDBY" = ?
          WHERE "SLUG" = ? AND "AUTHOR_ID" = ?`,
        [INITIATOR, r.slug, r.current],
      );
      const affected = typeof res === 'number' ? res : (res && res.rowCount) || 1;
      if (affected > 0) cleared++;
    }
  });
  console.log(`[repair] cleared ${cleared} row(s).`);
  console.log(`[repair] next publish will re-run linkTutorialAuthorship; Phase 0/a/b hits will re-establish author_ID for any tutorial whose signals are valid.`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[repair] FAILED:', err);
    process.exit(1);
  });
