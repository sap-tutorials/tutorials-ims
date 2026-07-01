#!/usr/bin/env node
// scripts/repair-author-id-phase-c.cjs
//
// One-shot repair for the #862 reopen: Tutorials.author_ID rows that were
// set exclusively via the removed Phase (c) `ownerEmail` fallback in
// resolveTutorialAuthor.js. On DEV that path silently promoted tutorials
// to the wrong "author" because their TutorialMeta.ownerEmail carried
// stale monitoring assignments from the legacy IMS migration.
//
// ─── Algorithm (v2 — Phase-0 aware) ────────────────────────────────────
//
// The first version of this script fed Phase 0 with a null frontmatter
// login, which meant it flagged 278 rows as "null-out" on DEV — including
// legitimate rows whose author_ID was originally set via Phase 0. That
// was too broad. This version reconstructs the Phase 0 signal from disk
// so the classification matches what a fresh publish run would produce.
//
// Per tutorial with author_ID IS NOT NULL:
//   1. Read the tutorial's Hugo frontmatter from
//        hugo/content/tutorials/<slug>.md
//      - Extract `authorProfile` (e.g. https://github.com/rbrainey) and
//        derive the GitHub login.
//      - Fallback: read `githubLogin` field directly if present.
//   2. Rebuild the resolver's inputs from HANA:
//      - contributors           ← TutorialContributors rows
//      - ownerEmail             ← TutorialMeta.ownerEmail
//      - frontmatterGithubLogin ← from step 1
//      - loginToUserId          ← Users.githubLogin map + augmented
//        mapping harvested from cross-tutorial contributor emails
//        (best-effort noreply→corporate matching)
//   3. Run resolveTutorialAuthor with the NEW code (Phase (c) removed).
//   4. Classify each row:
//        - resolver.authorUserId === current → OK (Phase 0/a/b reproduces)
//        - resolver.authorUserId !== current → CONFLICT (leave alone, log)
//        - resolver.authorUserId === null AND current row's author is
//          exactly the ownerEmail's user → PHASE-C FOOTPRINT → null-out
//        - resolver.authorUserId === null AND no Phase-C match → SUSPECT
//          (leave alone, log; ops decides)
//
// The extra "phase-c footprint" gate is critical safety: without it we'd
// null rows where Phase 0 signal is genuinely missing from the frontmatter
// but the current author_ID isn't a Phase (c) artifact (e.g. an admin
// correction). The footprint condition — current author_ID user's email
// EQUALS ownerEmail — is the exact fingerprint the removed Phase (c) left.
//
// ─── Flags ─────────────────────────────────────────────────────────────
//
//   --dry-run   (default) preview only, print classifications + a CSV
//   --commit    apply UPDATE ... SET author_ID = NULL for the null-out set
//   --initiator <str> audit label; defaults to `scripts/repair-author-id-phase-c`
//   --content-dir <path> override the tutorial content path (default:
//                        hugo/content/tutorials/). Useful for testing.
//
// Idempotency: WHERE author_ID IS NOT NULL narrows re-runs to a no-op
// after --commit clears the null-out set.
//
// Usage (must be run from a tree with hugo/content/tutorials populated —
// i.e. after `npm run build:all`; typically the PRIMARY tree, since
// hugo/content/tutorials/ is gitignored):
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
const contentDirIdx = argv.indexOf('--content-dir');
const CONTENT_DIR =
  contentDirIdx >= 0
    ? argv[contentDirIdx + 1]
    : path.join(process.cwd(), 'hugo', 'content', 'tutorials');

const T_TUTORIALS = '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"';
const T_CONTRIBUTORS = '"COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS"';
const T_TUTORIAL_META = '"COM_SAP_DEVELOPERS_IMS_TUTORIALMETA"';
const T_USERS = '"COM_SAP_DEVELOPERS_IMS_USERS"';

// ─── Frontmatter helpers ───────────────────────────────────────────────
//
// Deliberately minimal — we only need `authorProfile` and `githubLogin`
// out of a well-formed YAML frontmatter. Bringing in js-yaml would work
// but this pattern-based extractor is dependency-free and fast enough
// (10ms × ~1400 files).

function extractFrontmatterLogin(mdPath) {
  let raw;
  try {
    raw = fs.readFileSync(mdPath, 'utf8');
  } catch {
    return null; // no file, tutorial hasn't been rebuilt
  }
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  // authorProfile: https://github.com/<login>
  //   or:          https://github.com/<login>/
  const profileMatch = fm.match(/^authorProfile:\s*['"]?(https?:\/\/github\.com\/([A-Za-z0-9-]+))\/?['"]?\s*$/m);
  if (profileMatch && profileMatch[2]) return profileMatch[2].toLowerCase();

  // githubLogin: <login>
  const loginMatch = fm.match(/^githubLogin:\s*['"]?([A-Za-z0-9-]+)['"]?\s*$/m);
  if (loginMatch && loginMatch[1]) return loginMatch[1].toLowerCase();

  return null;
}

async function main() {
  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const db = await cds.connect.to('db');

  const { resolveTutorialAuthor } = await import('../srv/lib/resolve-tutorial-author.js');

  console.log(`[repair] mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'} initiator=${INITIATOR}`);
  console.log(`[repair] content-dir=${CONTENT_DIR}`);

  if (!fs.existsSync(CONTENT_DIR)) {
    console.error(`[repair] FATAL: content dir not found: ${CONTENT_DIR}`);
    console.error(`[repair] Run \`npm run build:all\` first, or use --content-dir <path>.`);
    process.exit(2);
  }

  // Prime the email → Users.ID map ONCE. Same shape used by the live
  // resolver caller in content-publish-session.js.
  const userRows = await db.run(
    `SELECT "ID" AS id, LOWER(TRIM("EMAIL")) AS email FROM ${T_USERS} WHERE "EMAIL" IS NOT NULL AND LENGTH(TRIM("EMAIL")) > 0`,
  );
  const emailToUserId = new Map();
  for (const r of userRows || []) {
    const email = r.email || r.EMAIL;
    const id = r.id || r.ID;
    if (email && !emailToUserId.has(email)) emailToUserId.set(email, id);
  }

  // Prime login → Users.ID from Users.githubLogin. This is the map the
  // live publish path uses for Phase 0. If DEV Users have sparse
  // githubLogin (common), Phase 0 misses a lot — that's the whole reason
  // v1 of this script over-flagged. We augment it below.
  const loginRows = await db.run(
    `SELECT "ID" AS id, LOWER(TRIM("GITHUBLOGIN")) AS login FROM ${T_USERS} WHERE "GITHUBLOGIN" IS NOT NULL AND LENGTH(TRIM("GITHUBLOGIN")) > 0`,
  );
  const loginToUserId = new Map();
  for (const r of loginRows || []) {
    const login = r.login || r.LOGIN;
    const id = r.id || r.ID;
    if (login && !loginToUserId.has(login)) loginToUserId.set(login, id);
  }

  // Augment loginToUserId: for every tutorial with a frontmatter login AND
  // an ownerEmail that matches a Users row, INFER the login→user mapping.
  // This is exactly what the publish-time bootstrap in
  // content-publish-session.js does (line ~756), transplanted client-side
  // so this script can reason about Phase 0 without needing HANA writes
  // first. The augmented map lives only in memory; no DB writes here.
  let augmentedLogins = 0;
  const files = fs.readdirSync(CONTENT_DIR);
  const bySlugLogin = new Map(); // slug → frontmatter login
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const slug = file.slice(0, -3).toLowerCase();
    const login = extractFrontmatterLogin(path.join(CONTENT_DIR, file));
    if (login) bySlugLogin.set(slug, login);
  }
  console.log(`[repair] scanned ${bySlugLogin.size} tutorial frontmatter file(s) with authorProfile/githubLogin`);

  // Second pass — for each slug's frontmatter login, check DB for a
  // Users row with matching email (via TutorialMeta.ownerEmail or
  // TutorialContributors) and register the login → user mapping.
  // Query in one batch for efficiency.
  const uniqueLogins = Array.from(new Set(bySlugLogin.values()));
  for (const login of uniqueLogins) {
    if (loginToUserId.has(login)) continue; // already known
    // For each slug that carries this login, look up ownerEmail + contribs
    // for a match. This is O(N * M) worst-case but N is ~1400 and we bail
    // on first hit so it's fast in practice.
    const matchingSlugs = [...bySlugLogin.entries()]
      .filter(([, l]) => l === login)
      .map(([s]) => s);
    let found = null;
    for (const slug of matchingSlugs.slice(0, 20)) { // cap at 20 slugs per login
      const rows = await db.run(
        `SELECT LOWER(TRIM(m."OWNEREMAIL")) AS email
           FROM ${T_TUTORIAL_META} m
           JOIN ${T_TUTORIALS} t ON t.ID = m.TUTORIAL_ID
          WHERE LOWER(t.SLUG) = ?
            AND m."OWNEREMAIL" IS NOT NULL`,
        [slug],
      );
      const email = rows?.[0]?.email || rows?.[0]?.EMAIL;
      if (email && emailToUserId.has(email)) {
        found = emailToUserId.get(email);
        break;
      }
    }
    if (found) {
      loginToUserId.set(login, found);
      augmentedLogins++;
    }
  }
  console.log(`[repair] loginToUserId: ${loginRows?.length ?? 0} seeded from Users.githubLogin + ${augmentedLogins} inferred from frontmatter+ownerEmail`);

  // ─── Scan ─────────────────────────────────────────────────────────────
  const rows = await db.run(
    `SELECT "ID" AS id, "SLUG" AS slug, "AUTHOR_ID" AS author_id FROM ${T_TUTORIALS} WHERE "AUTHOR_ID" IS NOT NULL`,
  );
  console.log(`[repair] scanning ${rows.length} tutorial(s) with author_ID set\n`);

  const summary = { ok: 0, conflict: 0, nullOut: 0, suspectNoFootprint: 0 };
  const nullOutList = [];
  const conflictList = [];
  const suspectList = []; // resolver can't reproduce but not a Phase-C footprint

  for (const t of rows) {
    const tutorialId = t.id ?? t.ID;
    const slug = (t.slug ?? t.SLUG ?? '').toLowerCase();
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

    const fmLogin = bySlugLogin.get(slug) || null;

    const resolved = resolveTutorialAuthor({
      contributors,
      ownerEmail,
      emailToUserId,
      frontmatterGithubLogin: fmLogin,
      loginToUserId,
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

    // resolved.authorUserId === null — can we prove this is a Phase-C
    // footprint? The Phase-C footprint is: the current author_ID's user
    // has an email EQUAL to TutorialMeta.ownerEmail. That's the exact
    // fingerprint the removed fallback left; anything else is a mystery
    // (could be an admin correction, a resolver bug from a previous
    // codebase version, etc.) and we leave it alone.
    const normOwnerEmail = ownerEmail ? String(ownerEmail).trim().toLowerCase() : null;
    const ownerEmailUserId = normOwnerEmail ? emailToUserId.get(normOwnerEmail) : null;
    const isPhaseCFootprint = ownerEmailUserId && ownerEmailUserId === currentAuthor;

    if (isPhaseCFootprint) {
      summary.nullOut++;
      nullOutList.push({ slug, current: currentAuthor, ownerEmail });
    } else {
      summary.suspectNoFootprint++;
      suspectList.push({
        slug,
        current: currentAuthor,
        ownerEmail,
        reason: normOwnerEmail
          ? 'author_ID does NOT match ownerEmail-user; not a Phase-C footprint'
          : 'no ownerEmail; not a Phase-C footprint',
      });
    }
  }

  console.log(`[repair] classified ${rows.length} rows:`);
  console.log(`  ok                     ${summary.ok}   (resolver reproduces current author_ID via Phase 0/a/b)`);
  console.log(`  conflict               ${summary.conflict}   (resolver disagrees — LEAVING ALONE)`);
  console.log(`  null-out (Phase-C fp)  ${summary.nullOut}   (current author_ID matches ownerEmail user AND resolver can't reproduce)`);
  console.log(`  suspect (no fp)        ${summary.suspectNoFootprint}   (resolver can't reproduce but no Phase-C footprint — LEAVING ALONE)`);
  console.log();

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
  if (suspectList.length > 0) {
    console.log(`[repair] first 10 suspects (leaving alone — resolver can't reproduce, but no Phase-C fingerprint):`);
    for (const r of suspectList.slice(0, 10)) {
      console.log(`  - ${r.slug}  current=${r.current}  ownerEmail=${r.ownerEmail ?? '<null>'} — ${r.reason}`);
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
