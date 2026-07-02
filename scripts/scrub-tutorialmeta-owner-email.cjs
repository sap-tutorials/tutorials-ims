#!/usr/bin/env node
// scripts/scrub-tutorialmeta-owner-email.cjs
//
// One-shot scrub for #862 reopen: null out TutorialMeta.ownerEmail values
// that cannot be corroborated against frontmatter authorProfile or the
// TutorialMeta.owner free-text field.
//
// Background: legacy IMS migration stamped ownerEmail on 58 DEV rows for
// Riley alone (production IMS returns 1 for the same user). That column
// is the exclusive signal for MyOwnedTutorials — a correct-shape endpoint
// still returns 58 spurious rows until this scrub runs.
//
// Corroboration rules (per spec §C3):
//   1. expectedEmails ← Set of Users.email derived from INDEPENDENT signals:
//        - frontmatter authorProfile → Users.githubLogin → email
//        - TutorialMeta.owner as "firstName + ' ' + lastName" → email
//        - TutorialMeta.owner as email (if @-shaped) matching Users.email
//   2. If current ownerEmail in expectedEmails → OK.
//   3. If current ownerEmail not in expectedEmails and expectedEmails non-empty
//        → NULL-OUT (on --commit).
//   4. If expectedEmails is empty → LEAVE ALONE (absence of evidence != evidence).
//   5. If frontmatter file missing on disk AND owner is null → LEAVE ALONE.
//
// Learned from #879: never derive expected values from the same column
// you're auditing. ownerEmail is the input under review; expectations come
// from frontmatter + owner-free-text only.
//
// Flags:
//   --dry-run   (default) preview + write CSV to .migration-data/
//   --commit    apply UPDATE SET ownerEmail = NULL for null-out set
//   --initiator <str> audit label
//   --content-dir <path> override hugo/content/tutorials/ (for tests)
//
// Safety: --commit REQUIRES a fresh (< 60 min) dry-run CSV to exist.
// If the mtime gate blocks a legitimate re-commit, re-run --dry-run.

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
    : process.env.INITIATOR || 'scripts/scrub-tutorialmeta-owner-email';
const contentDirIdx = argv.indexOf('--content-dir');
const CONTENT_DIR =
  contentDirIdx >= 0
    ? argv[contentDirIdx + 1]
    : path.join(process.cwd(), 'hugo', 'content', 'tutorials');
const DRY_RUN_CSV = path.join(
  process.cwd(),
  '.migration-data',
  'scrub-owner-email-dryrun.csv'
);
const CSV_STALE_MS = 60 * 60 * 1000; // 60 min

// ─── Frontmatter helpers (same shape as repair-author-id-phase-c.cjs) ─
//
// Distinguishes "file missing" (return null — expected for gitignored dirs
// and orphan slugs) from "read failed" (re-throw — surfaces I/O issues to
// the > 5% read-error abort guard in main()).
function extractFrontmatter(mdPath) {
  let raw;
  try {
    raw = fs.readFileSync(mdPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return null;
  const yaml = m[1];
  const pick = (key) => {
    const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm');
    const found = re.exec(yaml);
    if (!found) return null;
    return found[1].trim().replace(/^["']|["']$/g, '');
  };
  const authorProfile = pick('author_profile') || pick('authorProfile');
  const githubLogin = authorProfile
    ? (authorProfile.match(/github\.com\/([A-Za-z0-9-]+)/i)?.[1] ?? null)
    : (pick('githubLogin') || null);
  return { authorProfile, githubLogin };
}

async function main() {
  const log = cds.log('scrub-owner-email');
  log.info(`mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'} initiator=${INITIATOR}`);
  log.info(`db.kind=${cds.env?.requires?.db?.kind ?? '<unknown>'}`);

  // ── mtime gate ────────────────────────────────────────────────────
  if (COMMIT) {
    let stat;
    try {
      stat = fs.statSync(DRY_RUN_CSV);
    } catch {
      console.error(
        `--commit refused: ${DRY_RUN_CSV} does not exist. Run the script ` +
          `once without --commit to generate it, review the output, then ` +
          `re-run with --commit within 60 minutes.`
      );
      process.exit(2);
    }
    const age = Date.now() - stat.mtimeMs;
    if (age > CSV_STALE_MS) {
      console.error(
        `--commit refused: dry-run CSV is stale (${Math.round(age / 60000)}m old, ` +
          `> 60m). Re-run 'node scripts/scrub-tutorialmeta-owner-email.cjs' ` +
          `(no --commit) to regenerate, review the output, then re-run with ` +
          `--commit within 60 minutes.`
      );
      process.exit(2);
    }
  }

  await cds.connect.to('db');
  const { TutorialMeta, Tutorials, Users } = cds.entities('com.sap.developers.ims');

  // ── Preload Users so we can map in-memory ─────────────────────────
  const users = await SELECT.from(Users).columns(
    'ID', 'uuid', 'email', 'firstName', 'lastName', 'githubLogin'
  );
  const usersByLogin = new Map();
  const usersByName = new Map();
  const usersByEmail = new Map();
  for (const u of users) {
    if (u.githubLogin) usersByLogin.set(u.githubLogin.toLowerCase(), u);
    if (u.firstName && u.lastName) {
      usersByName.set(`${u.firstName} ${u.lastName}`.toLowerCase(), u);
    }
    if (u.email) usersByEmail.set(u.email.toLowerCase(), u);
  }
  log.info(`loaded ${users.length} users (${usersByLogin.size} with githubLogin)`);

  // ── Row set: TutorialMeta joined to Tutorials.slug ────────────────
  const metas = await SELECT.from(TutorialMeta)
    .columns('ID', 'tutorial_ID', 'owner', 'ownerEmail');
  const tutIds = metas.map((m) => m.tutorial_ID).filter(Boolean);
  const tuts = tutIds.length
    ? await SELECT.from(Tutorials).columns('ID', 'slug').where({ ID: { in: tutIds } })
    : [];
  const slugByTutId = new Map(tuts.map((t) => [t.ID, t.slug]));

  let readErrors = 0;
  const buckets = { ok: [], 'null-out': [], 'no-frontmatter': [], 'no-signals': [], 'no-owner-email': [] };

  for (const meta of metas) {
    const slug = slugByTutId.get(meta.tutorial_ID);
    if (!meta.ownerEmail) { buckets['no-owner-email'].push({ meta, slug, expected: [] }); continue; }

    const mdPath = slug ? path.join(CONTENT_DIR, `${slug}.md`) : null;
    let frontmatter = null;
    if (mdPath) {
      try {
        frontmatter = extractFrontmatter(mdPath);
      } catch (err) {
        readErrors++;
        log.warn(`frontmatter read failed for ${slug}: ${err.message}`);
      }
    }

    // Build expectedEmails from INDEPENDENT signals (never ownerEmail itself)
    const expected = new Set();
    if (frontmatter?.githubLogin) {
      const u = usersByLogin.get(frontmatter.githubLogin.toLowerCase());
      if (u?.email) expected.add(u.email.toLowerCase());
    }
    if (meta.owner) {
      const key = meta.owner.toLowerCase();
      const uByName = usersByName.get(key);
      if (uByName?.email) expected.add(uByName.email.toLowerCase());
      if (/@/.test(meta.owner)) {
        const uByEmail = usersByEmail.get(key);
        if (uByEmail?.email) expected.add(uByEmail.email.toLowerCase());
      }
    }

    const current = meta.ownerEmail.toLowerCase();

    if (expected.has(current)) {
      buckets.ok.push({ meta, slug, expected: [...expected] });
    } else if (expected.size === 0) {
      if (!frontmatter && !meta.owner) {
        buckets['no-frontmatter'].push({ meta, slug, expected: [] });
      } else {
        buckets['no-signals'].push({ meta, slug, expected: [] });
      }
    } else {
      buckets['null-out'].push({ meta, slug, expected: [...expected] });
    }
  }

  // Abort on wide read failure (> 5% of rows)
  if (readErrors > metas.length * 0.05) {
    console.error(
      `${readErrors}/${metas.length} frontmatter reads failed (> 5% threshold). ` +
        `Rebuild hugo/content/tutorials with 'npm run build:all' and rerun.`
    );
    process.exit(2);
  }

  // ── Write CSV ────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(DRY_RUN_CSV), { recursive: true });
  const rows = ['slug,bucket,current_ownerEmail,expected_emails,owner_freetext'];
  for (const [bucket, entries] of Object.entries(buckets)) {
    for (const e of entries) {
      const expectedStr = (e.expected || []).join('|');
      const owner = e.meta.owner ? e.meta.owner.replace(/,/g, ';') : '';
      rows.push(
        `${e.slug ?? ''},${bucket},${e.meta.ownerEmail ?? ''},${expectedStr},${owner}`
      );
    }
  }
  fs.writeFileSync(DRY_RUN_CSV, rows.join('\n') + '\n');
  log.info(`wrote ${DRY_RUN_CSV}`);

  console.log(
    `\nsummary: ok=${buckets.ok.length} null-out=${buckets['null-out'].length} ` +
      `no-signals=${buckets['no-signals'].length} no-frontmatter=${buckets['no-frontmatter'].length} ` +
      `no-owner-email=${buckets['no-owner-email'].length}`
  );

  if (!COMMIT) {
    log.info(`dry-run only — review ${DRY_RUN_CSV} then rerun with --commit within 60m`);
    return;
  }

  if (!buckets['null-out'].length) {
    log.info('nothing to update');
    return;
  }

  for (const e of buckets['null-out']) {
    await UPDATE(TutorialMeta).set({ ownerEmail: null }).where({ ID: e.meta.ID });
    log.info(`NULLED ${e.slug} (was ${e.meta.ownerEmail})`);
  }
  log.info(`committed ${buckets['null-out'].length} row(s) — TutorialMeta.ownerEmail set to NULL`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
