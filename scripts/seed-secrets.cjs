#!/usr/bin/env node
// scripts/seed-secrets.cjs
//
// Seed the Secrets HANA entity with the known tracked-secret registry.
// Run via: npx cds bind --exec -- node scripts/seed-secrets.cjs [--commit]
//
// Safe-by-default: WITHOUT --commit this script is a dry-run — it only
// reports which rows would be inserted and which already exist. Use
// --commit to actually write. Idempotent on `key`, so re-running is safe
// even after admin edits.
//
// The Secrets CSV seed (db/data/com.sap.developers.ims-Secrets.csv) is
// intentionally empty to avoid HDI clobbering admin-edited rows on every
// deploy. This script is the one-shot bootstrap for any environment
// (DEV / QA / PROD) where the Secrets table is empty.
//
// Add NEW tracked secrets via:
//   1) Admin UI at /admin-ui/#secrets-display, OR
//   2) Edit this file's INITIAL_SECRETS array + re-run with --commit
//
// Note: this script SEEDS the metadata rows (key, description, rotation
// owner). It does NOT set the secret VALUES — those go in via the admin
// UI's "Set Value" / "Rotate" controls, which write to the BTP Credential
// Store (not HANA).

const cds = require('@sap/cds');

const INITIAL_SECRETS = [
  {
    key: 'GITHUB_DISPATCH_TOKEN',
    description: 'Fine-grained GitHub PAT for workflow_dispatch on rebuild-content.yml. Read at runtime by srv/lib/rebuild-trigger.js (credstore-first, env fallback).',
    kind: 'github-pat',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: 'https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/operations/github-dispatch-pat-rotation.md',
    expiresAt: null,
  },
  {
    key: 'CONTENT_API_KEY',
    description: 'Bearer token for POST /content/publish, /content/rollback, /content/code-check-specs, /build/repo-catalog, /content/validate-specs. Read at runtime by srv/lib/content-store.js.',
    kind: 'content-api-key',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'SUBMISSION_SALT_SECRET',
    description: 'IP-hash salt for /feedback/submit rate-limiter. Read at runtime by srv/lib/feedback-salt.js. Rotation invalidates in-memory rate-limit keys (acceptable).',
    kind: 'salt',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'SMTP_PASS',
    description: 'SMTP credential for outbound contributor-notifications mail. Read at runtime by srv/lib/mail-client.js (credstore-first, env fallback).',
    kind: 'smtp-credential',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  // SMTP transport config — moved from mtaext env vars into credstore so all
  // five SMTP fields live in one place. Admin UI becomes the sole source of
  // truth; no redeploy needed to rotate the relay host/user/from-address.
  // See docs/superpowers/plans/<dated>-credstore-runtime-config.md.
  {
    key: 'SMTP_HOST',
    description: 'SMTP relay hostname for outbound contributor-notifications mail (e.g. smtpauth.mail.net.sap). Read at runtime by srv/lib/mail-client.js via the shared secret-resolver.',
    kind: 'smtp-config',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'SMTP_PORT',
    description: 'SMTP relay port for outbound contributor-notifications mail. Typical values: 587 (submission, STARTTLS) or 465 (implicit TLS). Read at runtime by srv/lib/mail-client.js; defaults to 587 if unset or non-numeric.',
    kind: 'smtp-config',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'SMTP_USER',
    description: 'SMTP relay username (authentication identity) for outbound contributor-notifications mail. Paired with SMTP_PASS. Read at runtime by srv/lib/mail-client.js.',
    kind: 'smtp-config',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'SMTP_FROM',
    description: 'From-address used on outbound contributor-notifications mail (e.g. developers@sap.com). Must be an address the SMTP relay authorizes the SMTP_USER to send as. Read at runtime by srv/lib/mail-client.js.',
    kind: 'smtp-config',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'TUTORIALS_GITHUB_TOKEN',
    description: 'GitHub PAT for CI tutorial-fetcher (CI-only — not consumed by tutorials-srv). Tracked here for rotation/expiry visibility only.',
    kind: 'github-pat',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'AI_AUTHOR_AICORE_SERVICE_KEY',
    description: 'BTP service key for AI Core orchestration (CI-only — not consumed by tutorials-srv). Tracked here for rotation/expiry visibility only. Vendor-defined rotation.',
    kind: 'service-key',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'YOUTUBE_API_KEY',
    description: 'YouTube Data API v3 key for the SAPDevs Video band on the new homepage (issue #639). Read at runtime by srv/lib/youtube-fetcher.js via the shared secret-resolver. Powers the featured Friday Developer News card + 3 most-recent uploads from the @sapdevs channel. Daily quota 10000 units; 15-min server cache keeps usage at ~500 units/day. Vendor-rotated via Google Cloud Console (no automatic expiry).',
    kind: 'youtube-api-key',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
];

function showBinding() {
  // cds.env.requires.db gets the resolved binding (HANA when cds bind --exec'd,
  // sqlite for local dev, etc.). We print just enough to confirm the operator
  // is pointing at the right environment before committing writes.
  const dbReq = cds.env.requires?.db ?? {};
  const kind = dbReq.kind ?? '(unknown)';
  const creds = dbReq.credentials ?? {};
  const url = creds.url ?? creds.host ?? '(no host)';
  const schema = creds.schema ?? creds.user ?? '(default)';
  console.log('────────────────────────────────────────────────────────────');
  console.log(`DB binding:  kind=${kind}`);
  console.log(`             host/url=${url}`);
  console.log(`             schema=${schema}`);
  console.log('────────────────────────────────────────────────────────────');
}

async function main() {
  const commit = process.argv.includes('--commit');

  // Per [[feedback_cds_entities_runtime_only]], `cds.entities(...)` can be
  // undefined in plain CJS scripts even after `cds bind --exec` has wired the
  // DB binding. We don't fight it — use raw SQL like the other one-shots
  // (setup-dev-data.cjs, repair-mixed-case-tutorial-duplicates.cjs). The HANA
  // table name follows the namespace-to-uppercase-underscore convention.
  const db = await cds.connect.to('db');
  showBinding();

  const TABLE = 'COM_SAP_DEVELOPERS_IMS_SECRETS';
  // HANA quotes "KEY" because it's a reserved word. The column name itself is
  // just KEY (no trailing underscore — that would only happen if the CSV/CDS
  // escape strategy added one; CAP's HANA emitter uses bare quoted "KEY").
  const existing = await db.run(`SELECT "KEY" FROM ${TABLE}`);
  const existingKeys = new Set(existing.map(r => r.KEY));
  const toInsert = INITIAL_SECRETS.filter(s => !existingKeys.has(s.key));
  const alreadyPresent = INITIAL_SECRETS.filter(s => existingKeys.has(s.key));

  if (alreadyPresent.length > 0) {
    console.log(`\nAlready present (${alreadyPresent.length}/${INITIAL_SECRETS.length}):`);
    alreadyPresent.forEach(s => console.log(`  ✓ ${s.key}`));
  }

  if (toInsert.length === 0) {
    console.log(`\nAll ${INITIAL_SECRETS.length} known secrets already present — nothing to do.`);
    return;
  }

  console.log(`\nWould insert ${toInsert.length} row(s):`);
  toInsert.forEach(s => console.log(`  + ${s.key.padEnd(36)} kind=${s.kind}`));

  if (!commit) {
    console.log('\nDry-run mode — no rows written.');
    console.log('Re-run with --commit to actually insert:');
    console.log('  npx cds bind --exec -- node scripts/seed-secrets.cjs --commit');
    return;
  }

  // Raw-SQL INSERT (see comment above on cds.entities-not-callable). Generate
  // UUIDs explicitly since cuid's auto-fill only fires through CDS QL.
  // managed-aspect timestamps default to NULL when omitted — first admin write
  // (set/rotate/clear value) updates lastRotatedAt + modifiedAt, which is
  // exactly the audit story we want anyway.
  const { randomUUID } = require('node:crypto');
  for (const s of toInsert) {
    await db.run(
      `INSERT INTO ${TABLE} ("ID", "KEY", "DESCRIPTION", "KIND", "ROTATIONOWNER", "ROTATIONDOCSURL", "EXPIRESAT")
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), s.key, s.description, s.kind, s.rotationOwner, s.rotationDocsUrl, s.expiresAt],
    );
  }
  console.log(`\nInserted ${toInsert.length} new tracked secrets.`);
  console.log('Next: visit /admin-ui/#secrets-display to set each row\'s value');
  console.log('and (optionally) expiresAt + lastRotatedAt. The daily 04:11 UTC');
  console.log('expiry-check cron surfaces warnings via the bell-icon popover.');
}

main()
  .catch(err => { console.error('Seed failed:', err.message); process.exit(1); })
  .finally(() => process.exit(0));
