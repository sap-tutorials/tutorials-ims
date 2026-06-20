#!/usr/bin/env node
// scripts/seed-secrets.cjs
// One-shot seed of the 6 known tracked secrets into the Secrets HANA entity.
// Run via: npx cds bind --exec -- node scripts/seed-secrets.cjs
//
// Idempotent on `key` — re-running is safe; existing rows are not touched.
// Add NEW tracked secrets via:
//   1) Admin UI at /admin-ui/#secrets, OR
//   2) Edit this file's INITIAL_SECRETS array + re-run.

const cds = require('@sap/cds');

const INITIAL_SECRETS = [
  {
    key: 'GITHUB_DISPATCH_TOKEN',
    description: 'Fine-grained GitHub PAT for workflow_dispatch on rebuild-content.yml.',
    kind: 'github-pat',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: 'https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/operations/github-dispatch-pat-rotation.md',
    expiresAt: null,
  },
  {
    key: 'CONTENT_API_KEY',
    description: 'Bearer token for POST /content/publish.',
    kind: 'content-api-key',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'SUBMISSION_SALT_SECRET',
    description: 'IP-hash salt for /feedback/submit rate-limiter. Rotation invalidates rate-limit keys.',
    kind: 'salt',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'SMTP_PASS',
    description: 'SMTP credential for outbound contributor-notifications mail.',
    kind: 'smtp-credential',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'TUTORIALS_GITHUB_TOKEN',
    description: 'GitHub PAT for CI tutorial-fetcher (CI-only — not on tutorials-srv).',
    kind: 'github-pat',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
  {
    key: 'AI_AUTHOR_AICORE_SERVICE_KEY',
    description: 'BTP service key for AI Core orchestration (CI-only). Vendor-defined rotation.',
    kind: 'service-key',
    rotationOwner: 'thomas.jung@sap.com',
    rotationDocsUrl: '',
    expiresAt: null,
  },
];

async function main() {
  await cds.connect.to('db');
  const { Secrets } = cds.entities('com.sap.developers.ims');
  const existing = await SELECT.from(Secrets).columns('key');
  const existingKeys = new Set(existing.map(r => r.key));
  const toInsert = INITIAL_SECRETS.filter(s => !existingKeys.has(s.key));

  if (toInsert.length === 0) {
    console.log(`All ${INITIAL_SECRETS.length} known secrets already present — nothing to do.`);
    return;
  }

  await INSERT.into(Secrets).entries(toInsert);
  console.log(`Inserted ${toInsert.length} new tracked secrets:`);
  toInsert.forEach(s => console.log(`  - ${s.key} (${s.kind})`));
  console.log('');
  console.log('Next: visit /admin-ui/#secrets to set expiresAt + lastRotatedAt for each row.');
  console.log('The expiry-check cron (04:11 UTC daily) will surface warnings via the bell-icon popover.');
}

main()
  .catch(err => { console.error('Seed failed:', err.message); process.exit(1); })
  .finally(() => process.exit(0));
