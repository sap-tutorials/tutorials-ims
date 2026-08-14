#!/usr/bin/env node
// scripts/check-shipped-qa-bundle.cjs
//
// DEPLOY GUARD — verify the QA author-preview navigator is present INSIDE the
// built mtar's approuter bundle, BEFORE `cf deploy`.
//
// WHY THIS EXISTS (recurring "no QA navigator on PROD" incident):
//   `/tutorials-qa/` (route → `/qa/index.html`, localDir static, scope
//   Tutorial.Author in approuter/xs-app.json) is served from the approuter's
//   `static/qa/` tree. That tree is produced by `build:qa` → `hugo/public-qa`,
//   which `.deploy/mta.yaml`'s approuter builder COPIES into `static/qa` during
//   `mbt build` (it does NOT render it). But `build:all`/`build:deploy` never
//   run `build:qa`, so a local `npm run deploy` ships whatever stale/empty
//   `hugo/public-qa` happens to be on disk — and `/tutorials-qa/*` then 404s.
//   Nothing verified the QA nav actually made it into the mtar, so the breakage
//   was invisible until a human noticed the navigator was gone on the live env
//   (twice). curl can't catch it either — the routes are XSUAA-gated and return
//   a login stub to unauthenticated probes.
//
//   This guard cracks the newest mtar, opens the approuter archive, and asserts
//   the QA navigator entrypoints are present. If missing, the deploy fails loud
//   with the exact fix (run the QA build before packaging).
//
// HOW THE BUNDLE IS NESTED (same as check-shipped-admin-bundle.cjs):
//   <mtar> (zip)
//     └─ tutorials-approuter/data.zip (zip)
//          └─ static/qa/index.html                       ← QA navigator page
//          └─ static/qa/tutorial-navigator/index.html    ← #1675 dedicated nav
//
// Usage:
//   node scripts/check-shipped-qa-bundle.cjs <path-to.mtar>
//   node scripts/check-shipped-qa-bundle.cjs            # newest in .deploy/mta_archives
//
// Exit codes: 0 = QA navigator present · 1 = missing / tooling error.
//
// WHY .cjs + `yauzl`: matches scripts/check-shipped-admin-bundle.cjs — yauzl is
// a direct project dependency (pure-JS zip reader), so this runs identically on
// Windows git-bash and Linux CI with no `unzip` binary on PATH.

const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');

const ROOT = path.resolve(__dirname, '..');
const MTAR_DIR = path.join(ROOT, '.deploy', 'mta_archives');
const INNER_ZIP = 'tutorials-approuter/data.zip';
// The QA navigator entrypoints that MUST ship for /tutorials-qa/ to work.
// index.html backs the `^/tutorials-qa/?$` → `/qa/index.html` route; the
// tutorial-navigator page (#1675) backs the dedicated QA navigator BLOB seed.
const REQUIRED = [
  'static/qa/index.html',
  'static/qa/tutorial-navigator/index.html',
];

const C = {
  red: s => `\x1b[31m${s}\x1b[0m`,
  grn: s => `\x1b[32m${s}\x1b[0m`,
  ylw: s => `\x1b[33m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
};
function die(msg) {
  console.error('\n' + C.red('[check-shipped-qa-bundle] FAILED: ') + msg + '\n');
  process.exit(1);
}

// Read a zip (from a file path OR an in-memory Buffer) → Map(entryName -> Buffer).
// Pure-JS via yauzl (mirrors check-shipped-admin-bundle.cjs).
function readZipEntries(input) {
  return new Promise((resolve, reject) => {
    const onZip = (err, zip) => {
      if (err) return reject(err);
      const out = new Map();
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; } // directory
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const chunks = [];
          stream.on('data', c => chunks.push(c));
          stream.on('end', () => { out.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    };
    if (Buffer.isBuffer(input)) yauzl.fromBuffer(input, { lazyEntries: true }, onZip);
    else yauzl.open(input, { lazyEntries: true }, onZip);
  });
}

async function main() {
  let mtar = process.argv[2];
  if (!mtar) {
    if (!fs.existsSync(MTAR_DIR)) die(`no mtar given and ${path.relative(ROOT, MTAR_DIR)} does not exist.`);
    const mtars = fs.readdirSync(MTAR_DIR).filter(f => f.endsWith('.mtar'))
      .map(f => ({ f, m: fs.statSync(path.join(MTAR_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!mtars.length) die(`no .mtar found in ${path.relative(ROOT, MTAR_DIR)}.`);
    mtar = path.join(MTAR_DIR, mtars[0].f);
  }
  if (!fs.existsSync(mtar)) die(`mtar not found: ${mtar}`);

  console.log(C.dim(`[check-shipped-qa-bundle] mtar: ${path.relative(ROOT, mtar)}`));

  let outerEntries;
  try {
    outerEntries = await readZipEntries(mtar);
  } catch (e) {
    die(`could not read the mtar as a zip archive: ${e && e.message || e}`);
  }
  const innerBuf = outerEntries.get(INNER_ZIP);
  if (!innerBuf) {
    die(`the mtar does not contain ${INNER_ZIP} — is this a full build including the approuter module?\n` +
        `             A srv-only (\`-m tutorials-srv\`) or scoped build will not carry the QA navigator.`);
  }
  let shipped;
  try {
    shipped = await readZipEntries(innerBuf);
  } catch (e) {
    die(`could not read the approuter archive (${INNER_ZIP}) as a zip: ${e && e.message || e}`);
  }

  const missing = REQUIRED.filter(p => !shipped.has(p));
  // Also flag the degenerate "empty static/qa" case explicitly for a clearer message.
  const anyQa = [...shipped.keys()].some(k => k.startsWith('static/qa/'));

  if (missing.length) {
    console.error('\n' + C.red('[check-shipped-qa-bundle] the QA author-preview navigator is NOT in the mtar:'));
    for (const m of missing) console.error(C.red('  MISSING from mtar: ') + m);
    if (!anyQa) console.error(C.red('  (static/qa/ is entirely absent — the QA channel was not built into this approuter.)'));
    console.error('\n' + C.ylw('  Cause: `build:qa` did not run before `mbt build`, so `.deploy/mta.yaml` copied a'));
    console.error(C.ylw('  stale/empty hugo/public-qa into static/qa. Deploying this ships a broken /tutorials-qa/'));
    console.error(C.ylw('  (404 — the recurring "no QA navigator" incident).'));
    console.error('\n' + C.ylw('  Fix before packaging:'));
    console.error(C.ylw('    CAP_BASE_URL=<deployed-srv> npm run fetch-tutorials:qa && npm run build:qa'));
    console.error(C.ylw('  then rebuild the mtar (mbt build). CI deploys build QA inline via root mta.yaml.') + '\n');
    process.exit(1);
  }

  console.log(C.grn('  ✓ QA navigator present in mtar ') +
              C.dim(`(${REQUIRED.join(', ')})`));
  process.exit(0);
}

main().catch((e) => die(String(e && e.stack || e)));
