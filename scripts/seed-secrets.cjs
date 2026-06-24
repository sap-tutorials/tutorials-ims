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

  await cds.connect.to('db');
  showBinding();

  const { Secrets } = cds.entities('com.sap.developers.ims');
  const existing = await SELECT.from(Secrets).columns('key');
  const existingKeys = new Set(existing.map(r => r.key));
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

  await INSERT.into(Secrets).entries(toInsert);
  console.log(`\nInserted ${toInsert.length} new tracked secrets.`);
  console.log('Next: visit /admin-ui/#secrets-display to set each row\'s value');
  console.log('and (optionally) expiresAt + lastRotatedAt. The daily 04:11 UTC');
  console.log('expiry-check cron surfaces warnings via the bell-icon popover.');
}

main()
  .catch(err => { console.error('Seed failed:', err.message); process.exit(1); })
  .finally(() => process.exit(0));
