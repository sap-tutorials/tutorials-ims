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
// Deliberately minimal — we only need `authorProfile`, `githubLogin`, and
// `author` (name) out of a well-formed YAML frontmatter. Bringing in
// js-yaml would work but this pattern-based extractor is dependency-free
// and fast enough (10ms × ~1400 files).

function extractFrontmatter(mdPath) {
  let raw;
  try {
    raw = fs.readFileSync(mdPath, 'utf8');
  } catch {
    return null; // no file, tutorial hasn't been rebuilt
  }
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  let login = null;
  // authorProfile: https://github.com/<login>
  //   or:          https://github.com/<login>/
  const profileMatch = fm.match(/^authorProfile:\s*['"]?(https?:\/\/github\.com\/([A-Za-z0-9-]+))\/?['"]?\s*$/m);
  if (profileMatch && profileMatch[2]) login = profileMatch[2].toLowerCase();

  // githubLogin: <login>
  if (!login) {
    const loginMatch = fm.match(/^githubLogin:\s*['"]?([A-Za-z0-9-]+)['"]?\s*$/m);
    if (loginMatch && loginMatch[1]) login = loginMatch[1].toLowerCase();
  }

  // author: <human name> — the display name of the tutorial's declared
  // author, as scraped from the GitHub commit's `author.name` field for
  // the file's authoring commit. This is a signal INDEPENDENT of
  // TutorialMeta.ownerEmail (which encodes monitoring, not authorship),
  // so we can use it to safely augment loginToUserId without dragging
  // the ownerEmail corruption we're trying to repair into the map.
  //
  // Skip generic placeholders — "Unknown", "SAP Community", empty strings.
  let authorName = null;
  const authorMatch = fm.match(/^author:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m);
  if (authorMatch && authorMatch[1]) {
    const raw = authorMatch[1].trim();
    // Filter out the sentinel values the parser emits when GitHub metadata
    // doesn't carry a real human author.
    if (raw && raw.toLowerCase() !== 'unknown' && raw.toLowerCase() !== 'sap community' && !raw.includes('@')) {
      authorName = raw;
    }
  }

  return { login, authorName };
}

// Backward-compat wrapper — the second scan below still uses the
// pattern-based extractor directly.
function extractFrontmatterLogin(mdPath) {
  const fm = extractFrontmatter(mdPath);
  return fm ? fm.login : null;
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
  // live publish path uses for Phase 0. DEV has sparse githubLogin, so
  // we augment below using a signal INDEPENDENT of the corrupted
  // TutorialMeta.ownerEmail data.
  const loginRows = await db.run(
    `SELECT "ID" AS id, LOWER(TRIM("GITHUBLOGIN")) AS login FROM ${T_USERS} WHERE "GITHUBLOGIN" IS NOT NULL AND LENGTH(TRIM("GITHUBLOGIN")) > 0`,
  );
  const loginToUserId = new Map();
  for (const r of loginRows || []) {
    const login = r.login || r.LOGIN;
    const id = r.id || r.ID;
    if (login && !loginToUserId.has(login)) loginToUserId.set(login, id);
  }

  // Prime name → Users.ID map from firstName + lastName + displayName. The
  // frontmatter's `author:` field is the tutorial's declared author name
  // (scraped from the GitHub commit author.name for the authoring commit).
  // It is INDEPENDENT of TutorialMeta.ownerEmail — that's the whole point
  // of augmenting on it: we don't want to re-import the corruption we're
  // trying to repair.
  //
  // Two lookup shapes handled:
  //   - "first last" (both fields set) — canonical
  //   - displayName — some Users rows only carry this
  // Both are normalized to lower-case with collapsed whitespace so
  // "Dhrubajyoti  Paul" (double-space) still hits.
  const nameToUserId = new Map();
  const nameRows = await db.run(
    `SELECT "ID" AS id, "FIRSTNAME" AS firstname, "LASTNAME" AS lastname, "DISPLAYNAME" AS displayname FROM ${T_USERS}`,
  );
  const normName = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const r of nameRows || []) {
    const id = r.id || r.ID;
    const first = (r.firstname || r.FIRSTNAME || '').trim();
    const last = (r.lastname || r.LASTNAME || '').trim();
    const display = (r.displayname || r.DISPLAYNAME || '').trim();
    if (first && last) {
      const key = normName(`${first} ${last}`);
      if (!nameToUserId.has(key)) nameToUserId.set(key, id);
    }
    if (display) {
      const key = normName(display);
      if (!nameToUserId.has(key)) nameToUserId.set(key, id);
    }
  }

  // Scan all tutorial frontmatter into a per-slug record. We keep both
  // the login AND the declared author name — the augmentation below uses
  // the name to make sure we're mapping the login to the right person.
  const files = fs.readdirSync(CONTENT_DIR);
  const bySlug = new Map(); // slug → { login, authorName }
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const slug = file.slice(0, -3).toLowerCase();
    const fm = extractFrontmatter(path.join(CONTENT_DIR, file));
    if (fm && (fm.login || fm.authorName)) bySlug.set(slug, fm);
  }
  console.log(`[repair] scanned ${bySlug.size} tutorial frontmatter file(s) with authorProfile/githubLogin/author`);

  // Augment loginToUserId by name match. For each unique frontmatter login,
  // gather the declared `author:` names that appear alongside it across
  // ALL slugs. If a single unambiguous name resolves to a Users row via
  // firstName+lastName (or displayName), register the mapping.
  //
  // Why this is safe: TutorialMeta.ownerEmail is not consulted here. The
  // signal chain is: GitHub commit author.name → frontmatter `author:` →
  // Users.firstName+lastName. All three come from different sources
  // (GitHub, tutorial markdown, IDP profile) that agree on the person's
  // real name.
  //
  // Ambiguity guard: if a single login is paired with multiple DIFFERENT
  // author names across slugs (rare — usually a person only authors under
  // one name), we skip the augmentation for that login. Better to leave
  // it out than register a wrong mapping.
  let augmentedLogins = 0;
  let ambiguousLogins = 0;
  const uniqueLogins = new Set();
  const loginToNames = new Map(); // login → Set<normalized author name>
  for (const [, fm] of bySlug) {
    if (!fm.login) continue;
    uniqueLogins.add(fm.login);
    if (fm.authorName) {
      if (!loginToNames.has(fm.login)) loginToNames.set(fm.login, new Set());
      loginToNames.get(fm.login).add(normName(fm.authorName));
    }
  }
  for (const login of uniqueLogins) {
    if (loginToUserId.has(login)) continue; // already known
    const names = loginToNames.get(login);
    if (!names || names.size === 0) continue; // no name signal — skip
    // Resolve every candidate name to a Users.ID; skip if any of them
    // resolve to DIFFERENT users (ambiguous — better to leave out).
    const resolvedIds = new Set();
    for (const name of names) {
      const id = nameToUserId.get(name);
      if (id) resolvedIds.add(id);
    }
    if (resolvedIds.size === 0) continue; // no Users match
    if (resolvedIds.size > 1) {
      ambiguousLogins++;
      continue;
    }
    loginToUserId.set(login, [...resolvedIds][0]);
    augmentedLogins++;
  }
  console.log(`[repair] loginToUserId: ${loginRows?.length ?? 0} seeded from Users.githubLogin + ${augmentedLogins} inferred via name-match (skipped ${ambiguousLogins} ambiguous)`);

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

    const fmLogin = (bySlug.get(slug) && bySlug.get(slug).login) || null;

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

    // Corroboration guard: if the tutorial's frontmatter declares a
    // GitHub login AND that login also shows up in the contributors'
    // noreply-email form, the person shown in the frontmatter genuinely
    // did commit against this tutorial. Even if the resolver couldn't
    // bridge them via emailToUserId (their Users row uses a corporate
    // email, not the noreply form), leaving the row alone is safer than
    // nulling it. Riley's rbrainey-sandbox-1 is the canonical case —
    // frontmatter says rbrainey authored, contributors[0].email is
    // rbrainey@users.noreply.github.com, ownerEmail is riley's corporate
    // email. The Phase-C footprint matches, but this is legitimate
    // self-monitoring; not a Phase-C fault.
    //
    // Login parse regex: strip either `<login>@users.noreply.github.com`
    // or `<id>+<login>@users.noreply.github.com` (both GitHub-emitted
    // shapes).
    let corroboratedByContributor = false;
    const fmSlug = bySlug.get(slug);
    if (isPhaseCFootprint && fmSlug && fmSlug.login) {
      const fmLoginLc = fmSlug.login.toLowerCase();
      for (const c of contributors) {
        const em = c.email ? String(c.email).trim().toLowerCase() : '';
        if (!em) continue;
        const m = em.match(/^(?:\d+\+)?([a-z0-9-]+)@users\.noreply\.github\.com$/);
        if (m && m[1] === fmLoginLc) {
          corroboratedByContributor = true;
          break;
        }
      }
    }

    if (isPhaseCFootprint && !corroboratedByContributor) {
      summary.nullOut++;
      nullOutList.push({ slug, current: currentAuthor, ownerEmail });
    } else if (isPhaseCFootprint && corroboratedByContributor) {
      // Legitimate self-monitoring; frontmatter + contributor agree on
      // authorship even though the resolver couldn't reproduce (e.g. because
      // the author has no Users.githubLogin populated). Log as suspect so
      // Ops can see it, but do NOT null.
      summary.suspectNoFootprint++;
      suspectList.push({
        slug,
        current: currentAuthor,
        ownerEmail,
        reason: `frontmatter login '${fmSlug.login}' corroborated by a contributor noreply email — likely self-monitoring, not Phase-C fault`,
      });
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
