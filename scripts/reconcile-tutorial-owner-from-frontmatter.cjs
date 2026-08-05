#!/usr/bin/env node
// scripts/reconcile-tutorial-owner-from-frontmatter.cjs
//
// Systemic reconciliation of TutorialMeta.owner / ownerEmail from tutorial
// frontmatter, plus fill-NULL seeding of Users.githubLogin.
//
// WHY (author-ownership incident, 2026-08):
//   Prod TutorialMeta ownership is broken at scale: ~1,474 of 2,905 rows have
//   NO owner, and an unknown subset are MIS-ATTRIBUTED by the IMS migration
//   (e.g. Matthäus Schüle's 5 wrapper tutorials wrongly say "Achim Seubert",
//   though all 6 declare `author_name: Matthäus Schüle` in their source
//   frontmatter). The migration never carried author identity into HANA
//   (Tutorials.author_ID = 0/2905, Users.githubLogin = 0/797k populated), so
//   the ONLY trustworthy owner source is the tutorial markdown frontmatter.
//
// AUTHORITY (Tom): tutorial frontmatter is the source of truth. When
// frontmatter `author_name` DIFFERS from the current owner, frontmatter WINS —
// there is no modifiedBy skip, because prod modifiedBy cannot distinguish an
// admin correction from a past bulk write (1,410 rows are thomas.jung@sap.com).
// The dry-run CSV — every proposed change, reviewed before --commit — is the
// safeguard.
//
// WHAT IT WRITES (ADR 0006 semantics):
//   1. TutorialMeta.owner   ← frontmatter author_name (display name).
//        OVERWRITE when different. This is the Admin UI "Owner" column (the
//        priority-4 join) and the primary user-visible fix. No Users join
//        needed — the display name comes straight from frontmatter.
//   2. TutorialMeta.ownerEmail ← Users.email resolved via
//        author_profile → githubLogin → Users row. FILL-NULL ONLY (never
//        clobber a monitoring signal; matches the publish-path invariant).
//   3. Users.githubLogin    ← login parsed from author_profile, for the Users
//        row matched by name/email. FILL-NULL ONLY. Strengthens the #1494
//        identity-resolution path going forward.
//
// Owner ≠ committer (#862): author_name/author_profile IS the declared author,
// so it is the correct owner source (unlike contributor/committer email).
//
// FRONTMATTER SOURCE (no GitHub re-fetch needed): reads built Hugo pages
// hugo/content/tutorials/<slug>.md (derived `author`/`authorProfile`/
// `githubLogin`), falling back to raw .tutorial-cache/<slug>.md
// (`author_name`/`author_profile`). Requires `npm run fetch-tutorials`
// (+ build for the Hugo tree) to have populated one of those first.
//
// Flags:
//   --dry-run        (default) preview + write CSV to .migration-data/
//   --commit         apply the writes (requires a fresh <60min dry-run CSV)
//   --verbose        per-row logging
//   --initiator <s>  audit label written to modifiedBy
//   --content-dir <p> override hugo/content/tutorials/ (tests)
//   --cache-dir <p>  override .tutorial-cache/ (tests)
//
// Creds: workstation via `cds bind --exec` (CAP db connection), same as the
// sibling backfill scripts. Container pin: when run against prod, confirm the
// bound HDI container is the one the LIVE app serves (blue-green switch was
// observed 2026-08-05) before --commit.
//
// Idempotent: a second run yields all "no-change".

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const cds = require('@sap/cds');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const VERBOSE = argv.includes('--verbose');
function argVal(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dflt;
}
const INITIATOR = argVal('--initiator', process.env.INITIATOR
  || `scripts/reconcile-tutorial-owner-from-frontmatter@${process.env.USER || process.env.USERNAME || 'unknown'}`);
const CONTENT_DIR = argVal('--content-dir', path.join(process.cwd(), 'hugo', 'content', 'tutorials'));
const CACHE_DIR = argVal('--cache-dir', path.join(process.cwd(), '.tutorial-cache'));
const DRY_RUN_CSV = path.join(process.cwd(), '.migration-data', 'reconcile-owner-from-frontmatter.dryrun.csv');
const CSV_STALE_MS = 60 * 60 * 1000; // 60 min

// ─── Pure helpers (unit-tested; no I/O) ──────────────────────────────────

// Extract a GitHub login from an author_profile URL. Mirrors
// scripts/parsers/github-login-from-profile.ts: github.com host only, first
// path segment, GitHub login charset. Returns null for anything else
// (non-github URLs, emails, blanks).
const RESERVED_LOGINS = new Set(['orgs', 'sponsors', 'settings', 'about', 'login', 'join', 'marketplace']);
function extractGithubLogin(profile) {
  if (!profile || typeof profile !== 'string') return null;
  const m = profile.match(/github\.com\/([^/?#\s]+)/i);
  if (!m) return null;
  const login = m[1].trim();
  if (!login || RESERVED_LOGINS.has(login.toLowerCase())) return null;
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(login)) return null;
  return login;
}

// Normalize a person name for matching frontmatter author_name against
// Users.firstName+lastName. The two sources disagree on diacritics: tutorial
// frontmatter uses German umlauts ("Matthäus Schüle"), while Users rows are
// populated from SAP IDP JWT claims in ASCII transliteration ("Matthaeus
// Schuele"). Apply German transliteration (ä→ae ö→oe ü→ue ß→ss) FIRST, then
// strip any remaining accents (é→e), collapse whitespace, lowercase.
// Order matters: ü→ue must run before generic accent-strip (which would give
// ü→u → "schule", missing "schuele").
function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip remaining accents (combining marks)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}


// owner/ownerEmail/githubLogin actions. Pure — the heart of the reconciliation
// and the unit-test surface.
//
// @param cur    { owner, ownerEmail }              — current TutorialMeta row
// @param fm     { authorName, githubLogin }|null   — resolved frontmatter
// @param user   { email, githubLogin }|null        — Users row matched via login
// @returns {
//   ownerAction: 'overwrite'|'fill'|'no-change'|'skip-no-frontmatter',
//   newOwner: string|null,
//   ownerEmailAction: 'fill'|'no-change'|'skip',
//   newOwnerEmail: string|null,
//   githubLoginAction: 'seed'|'no-change'|'skip',
//   seedLogin: string|null,
// }
function buildOwnerDecision(cur, fm, user) {
  const out = {
    ownerAction: 'no-change', newOwner: null,
    ownerEmailAction: 'no-change', newOwnerEmail: null,
    githubLoginAction: 'no-change', seedLogin: null,
  };

  // ── owner ← frontmatter author_name (overwrite when different) ──
  const fmName = fm && typeof fm.authorName === 'string' ? fm.authorName.trim() : '';
  if (!fmName) {
    out.ownerAction = 'skip-no-frontmatter';
  } else if ((cur.owner ?? '').trim() === fmName) {
    out.ownerAction = 'no-change';
  } else if (!cur.owner || !cur.owner.trim()) {
    out.ownerAction = 'fill';
    out.newOwner = fmName;
  } else {
    out.ownerAction = 'overwrite';
    out.newOwner = fmName;
  }

  // ── ownerEmail ──
  // Two regimes:
  //  - owner OVERWRITE (a DIFFERENT person now owns this): the existing
  //    ownerEmail belongs to the OLD owner and is now WRONG. Recompute it to
  //    the new author's resolved email, or NULL it if unresolvable — never
  //    leave the previous owner's email under a new owner name. (NULL is
  //    correctly fillable later once githubLogin seeding resolves the user.)
  //  - otherwise (fill / no-change / skip owner): FILL-NULL only — never
  //    clobber an existing monitoring signal for the SAME owner.
  const resolvedEmail = user && user.email ? user.email : null;
  if (out.ownerAction === 'overwrite') {
    const curEmail = (cur.ownerEmail ?? '').trim();
    if (resolvedEmail && resolvedEmail.toLowerCase() === curEmail.toLowerCase()) {
      out.ownerEmailAction = 'no-change';
    } else if (resolvedEmail) {
      out.ownerEmailAction = 'overwrite';
      out.newOwnerEmail = resolvedEmail;
    } else if (curEmail) {
      // Stale email from the previous owner, and we can't resolve a new one → clear it.
      out.ownerEmailAction = 'clear';
      out.newOwnerEmail = null;
    } else {
      out.ownerEmailAction = 'skip'; // already empty, nothing to resolve
    }
  } else if (cur.ownerEmail && cur.ownerEmail.trim()) {
    out.ownerEmailAction = 'no-change';
  } else if (resolvedEmail) {
    out.ownerEmailAction = 'fill';
    out.newOwnerEmail = resolvedEmail;
  } else {
    out.ownerEmailAction = 'skip'; // nothing to fill from
  }

  // ── Users.githubLogin ← frontmatter login (FILL-NULL only, on the matched user) ──
  const fmLogin = fm && fm.githubLogin ? fm.githubLogin : null;
  if (!fmLogin || !user) {
    out.githubLoginAction = 'skip';
  } else if (user.githubLogin && user.githubLogin.trim()) {
    out.githubLoginAction = 'no-change';
  } else {
    out.githubLoginAction = 'seed';
    out.seedLogin = fmLogin;
  }

  return out;
}

// Read + parse frontmatter for a slug. Prefers the built Hugo page (derived
// author/authorProfile/githubLogin); falls back to raw .tutorial-cache
// (author_name/author_profile). Returns { authorName, githubLogin } or null
// when neither file exists. Throws only on real read failures (surfaced to the
// >5% abort guard).
function readFrontmatter(slug) {
  const pickFrom = (raw) => {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!m) return null;
    const yaml = m[1];
    const pick = (key) => {
      const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm');
      const found = re.exec(yaml);
      return found ? found[1].trim().replace(/^["']|["']$/g, '') : null;
    };
    const authorName = pick('author') || pick('author_name');
    const authorProfile = pick('authorProfile') || pick('author_profile');
    const declaredLogin = pick('githubLogin');
    const githubLogin = declaredLogin || extractGithubLogin(authorProfile);
    return { authorName: authorName || null, githubLogin: githubLogin || null };
  };

  const tryRead = (p) => {
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return undefined; // file absent
      throw err;
    }
    return pickFrom(raw);
  };

  // Built Hugo page first (login already derived), then raw cache.
  const built = tryRead(path.join(CONTENT_DIR, `${slug}.md`));
  if (built !== undefined && built) return built;
  const cached = tryRead(path.join(CACHE_DIR, `${slug}.md`));
  if (cached !== undefined && cached) return cached;
  return null;
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const log = cds.log('reconcile-owner');
  log.info(`mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'} initiator=${INITIATOR}`);
  log.info(`content-dir=${CONTENT_DIR}`);
  log.info(`cache-dir=${CACHE_DIR}`);

  // ── mtime gate: --commit requires a fresh (<60m) dry-run CSV ──
  if (COMMIT) {
    let stat;
    try {
      stat = fs.statSync(DRY_RUN_CSV);
    } catch {
      console.error(`--commit refused: ${DRY_RUN_CSV} does not exist. Run without --commit first, review, then --commit within 60m.`);
      process.exit(2);
    }
    const age = Date.now() - stat.mtimeMs;
    if (age > CSV_STALE_MS) {
      console.error(`--commit refused: dry-run CSV is ${Math.round(age / 60000)}m old (>60m). Re-run dry-run, review, then --commit within 60m.`);
      process.exit(2);
    }
  }

  // Load + compile the model so cds.entities() resolves under `cds bind --exec`.
  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  await cds.connect.to('db');
  const { TutorialMeta, Tutorials, Users } = cds.entities('com.sap.developers.ims');

  // Preload Users → maps by login and by normalized name.
  const users = await SELECT.from(Users).columns('ID', 'email', 'firstName', 'lastName', 'githubLogin');
  const usersByLogin = new Map();
  const usersByNormName = new Map();
  for (const u of users) {
    if (u.githubLogin) usersByLogin.set(u.githubLogin.toLowerCase(), u);
    if (u.firstName && u.lastName) {
      const key = normalizeName(`${u.firstName} ${u.lastName}`);
      if (key) usersByNormName.set(key, u);
    }
  }
  log.info(`loaded ${users.length} users (${usersByLogin.size} with githubLogin, ${usersByNormName.size} name-indexed)`);

  // Preload Tutorials (slug map) + TutorialMeta. Preload rather than WHERE-IN
  // (the id list exceeds HANA's packet cap — see scrub script note).
  const allTuts = await SELECT.from(Tutorials).columns('ID', 'slug');
  const slugByTutId = new Map(allTuts.map((t) => [t.ID, t.slug]));
  const metas = await SELECT.from(TutorialMeta).columns('ID', 'tutorial_ID', 'owner', 'ownerEmail');

  let readErrors = 0;
  const rows = [];
  const counts = {
    ownerOverwrite: 0, ownerFill: 0, ownerNoChange: 0, ownerNoFrontmatter: 0,
    emailFill: 0, emailOverwrite: 0, emailClear: 0, loginSeed: 0,
  };
  // Track distinct Users.githubLogin seeds (one login may back several metas).
  const loginSeeds = new Map(); // userID → login

  for (const meta of metas) {
    const slug = slugByTutId.get(meta.tutorial_ID) || null;
    let fm = null;
    if (slug) {
      try {
        fm = readFrontmatter(slug);
      } catch (err) {
        readErrors++;
        log.warn(`frontmatter read failed for ${slug}: ${err.message}`);
      }
    }

    // Resolve the Users row for ownerEmail + githubLogin seeding. Try the
    // frontmatter github login first (strongest signal), then fall back to a
    // normalized name match (author_name → Users.firstName+lastName, with
    // umlaut transliteration — the primary path today since Users.githubLogin
    // is empty but ~24 authors have a name+email from their JWT-provisioned row).
    let user = null;
    if (fm && fm.githubLogin) user = usersByLogin.get(fm.githubLogin.toLowerCase()) || null;
    if (!user && fm && fm.authorName) {
      const nk = normalizeName(fm.authorName);
      if (nk) user = usersByNormName.get(nk) || null;
    }

    const d = buildOwnerDecision(
      { owner: meta.owner, ownerEmail: meta.ownerEmail },
      fm,
      user,
    );

    if (d.ownerAction === 'overwrite') counts.ownerOverwrite++;
    else if (d.ownerAction === 'fill') counts.ownerFill++;
    else if (d.ownerAction === 'skip-no-frontmatter') counts.ownerNoFrontmatter++;
    else counts.ownerNoChange++;
    if (d.ownerEmailAction === 'fill') counts.emailFill++;
    else if (d.ownerEmailAction === 'overwrite') counts.emailOverwrite++;
    else if (d.ownerEmailAction === 'clear') counts.emailClear++;
    if (d.githubLoginAction === 'seed' && user) {
      if (!loginSeeds.has(user.ID)) { loginSeeds.set(user.ID, d.seedLogin); counts.loginSeed++; }
    }

    rows.push({ slug, meta, fm, user, d });
    if (VERBOSE && (d.ownerAction === 'overwrite' || d.ownerAction === 'fill')) {
      log.info(`[${d.ownerAction}] ${slug}: owner "${meta.owner ?? ''}" → "${d.newOwner}"`);
    }
  }

  // Abort on wide read failure (>5%).
  if (readErrors > metas.length * 0.05) {
    console.error(`${readErrors}/${metas.length} frontmatter reads failed (>5%). Populate hugo/content/tutorials (npm run build:all) or .tutorial-cache (npm run fetch-tutorials) and rerun.`);
    process.exit(2);
  }

  // Write CSV audit.
  fs.mkdirSync(path.dirname(DRY_RUN_CSV), { recursive: true });
  const header = 'slug,owner_action,current_owner,new_owner,owneremail_action,current_owneremail,new_owneremail,githublogin_action,seed_login,fm_author_name,fm_login';
  const lines = [header];
  for (const r of rows) {
    lines.push([
      csvCell(r.slug), r.d.ownerAction, csvCell(r.meta.owner), csvCell(r.d.newOwner),
      r.d.ownerEmailAction, csvCell(r.meta.ownerEmail), csvCell(r.d.newOwnerEmail),
      r.d.githubLoginAction, csvCell(r.d.seedLogin),
      csvCell(r.fm?.authorName), csvCell(r.fm?.githubLogin),
    ].join(','));
  }
  fs.writeFileSync(DRY_RUN_CSV, lines.join('\n') + '\n');
  log.info(`wrote ${DRY_RUN_CSV} (${rows.length} rows)`);

  console.log(
    `\nsummary: owner[overwrite=${counts.ownerOverwrite} fill=${counts.ownerFill} ` +
    `no-change=${counts.ownerNoChange} no-frontmatter=${counts.ownerNoFrontmatter}] ` +
    `ownerEmail[fill=${counts.emailFill} overwrite=${counts.emailOverwrite} clear=${counts.emailClear}] ` +
    `githubLogin[seed=${counts.loginSeed}]`
  );

  if (!COMMIT) {
    log.info(`dry-run only — review ${DRY_RUN_CSV}, then rerun with --commit within 60m`);
    return;
  }

  // ── COMMIT ──  cds `managed` aspect stamps modifiedBy; set the context user
  // to the initiator label so the audit trail records this reconciliation.
  cds.context = { user: new cds.User({ id: INITIATOR }) };
  let ownerWrites = 0, emailWrites = 0, loginWrites = 0;
  for (const r of rows) {
    const set = {};
    if (r.d.ownerAction === 'overwrite' || r.d.ownerAction === 'fill') set.owner = r.d.newOwner;
    // ownerEmail: 'fill' + 'overwrite' both set a value; 'clear' nulls the
    // stale previous-owner email. 'no-change'/'skip' leave it alone.
    if (r.d.ownerEmailAction === 'fill' || r.d.ownerEmailAction === 'overwrite') set.ownerEmail = r.d.newOwnerEmail;
    else if (r.d.ownerEmailAction === 'clear') set.ownerEmail = null;
    if (Object.keys(set).length) {
      await UPDATE(TutorialMeta).set(set).where({ ID: r.meta.ID });
      if (set.owner !== undefined) ownerWrites++;
      if ('ownerEmail' in set) emailWrites++;
    }
  }
  // Seed Users.githubLogin once per user (fill-NULL only).
  for (const [userID, login] of loginSeeds) {
    await UPDATE(Users).set({ githubLogin: login }).where({ ID: userID, githubLogin: null });
    loginWrites++;
  }
  log.info(`committed: owner=${ownerWrites} ownerEmail=${emailWrites} githubLogin=${loginWrites}`);
}

// Run main() only when invoked directly (not when require()'d by unit tests).
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Export the pure helpers for unit tests.
module.exports = { buildOwnerDecision, extractGithubLogin, normalizeName };
