#!/usr/bin/env node
// scripts/check-shipped-admin-bundle.cjs
//
// DEPLOY GUARD — verify the admin-UI bundle INSIDE the built mtar matches the
// current source tree, BEFORE `cf deploy`.
//
// WHY THIS EXISTS (2026-07-27, PR #1331/#1345 value-help incident):
//   A fix to app/admin/missions/webapp/ (the Path Items value-help fragment)
//   was merged to main, but the deployed DEV approuter kept serving the OLD
//   admin bundle — the live `components/missions/Component.js` was still the
//   pre-fix version. The admin apps are raw-copied into the approuter's
//   `static/admin-ui/` by the approuter module's custom builder in
//   `.deploy/mta.yaml` during `mbt build`. Any deploy that reuses a stale mtar
//   (`--skip-build`), is module-scoped to the srv (`cf deploy -m tutorials-srv`,
//   which never rebuilds the approuter), or was packaged before the merge
//   landed, ships an admin UI that silently lags source. Nothing verified the
//   shipped bundle against source, so the drift was invisible until a human
//   noticed the bug was "still there" after deploy.
//
//   This guard closes that gap: it cracks open the newest mtar, extracts the
//   approuter module archive, and diffs the shipped admin-UI component files
//   against `app/admin/<name>/webapp/`. If ANY tracked file is missing or
//   differs, the deploy fails loud — mechanism-agnostic (catches skip-build,
//   module-scoping, and pre-merge packaging alike).
//
// HOW THE BUNDLE IS NESTED:
//   <mtar> (zip)
//     └─ tutorials-approuter/data.zip (zip)
//          └─ static/admin-ui/components/<name>/...   ← shipped admin bundle
//   Source of truth: app/admin/<name>/webapp/...  (copy-components.js mirrors
//   webapp/ → dist/components/<name>/ → static/admin-ui/components/<name>/).
//
// Usage:
//   node scripts/check-shipped-admin-bundle.cjs <path-to.mtar>
//   node scripts/check-shipped-admin-bundle.cjs            # newest in .deploy/mta_archives
//
// Exit codes: 0 = bundle matches source · 1 = drift / missing / tooling error.
//
// WHY .cjs + `unzip`: matches the other scripts/*.cjs guards; `unzip` is present
// on Windows git-bash and Linux CI. Node has no built-in zip reader and we avoid
// adding a hard dependency to the deploy hot-path.

// WHY .cjs + `yauzl`: matches the other scripts/*.cjs guards; `yauzl` is a
// direct project dependency (pure-JS zip reader, no native/binary needs), so
// this runs identically on Windows git-bash and Linux CI without depending on
// an `unzip` binary being on PATH.

const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');

const ROOT = path.resolve(__dirname, '..');
// Test seam: point ADMIN_SRC at a synthetic tree (mirrors CHECK_ICON_IMPORTS_ROOT
// in check-icon-imports). Only affects the source side; the mtar is always the
// CLI arg. Real deploys never set this.
const SRC_ROOT = process.env.CHECK_SHIPPED_ADMIN_ROOT || ROOT;
const MTAR_DIR = path.join(ROOT, '.deploy', 'mta_archives');
const ADMIN_SRC = path.join(SRC_ROOT, 'app', 'admin');
const INNER_ZIP = 'tutorials-approuter/data.zip';
const SHIPPED_PREFIX = 'static/admin-ui/components';

const C = {
  red: s => `\x1b[31m${s}\x1b[0m`,
  grn: s => `\x1b[32m${s}\x1b[0m`,
  ylw: s => `\x1b[33m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
};
function die(msg) {
  console.error('\n' + C.red('[check-shipped-admin-bundle] FAILED: ') + msg + '\n');
  process.exit(1);
}

// Read a zip (from a file path OR an in-memory Buffer) and return a Map of
// entryName -> Buffer for every file entry (directories skipped). Pure-JS via
// yauzl; async under the hood, surfaced as a Promise.
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

// The per-component files whose drift actually changes runtime UI behaviour.
// Component.js (module deps / eager-loads), and every ext/ controller + fragment
// (custom columns, value-help handlers, formatters). manifest.json too — it
// wires templates, routes and controlConfiguration.
function sourceFilesFor(componentDir) {
  const webapp = path.join(ADMIN_SRC, componentDir, 'webapp');
  if (!fs.existsSync(webapp)) return [];
  const out = [];
  const push = p => { if (fs.existsSync(p)) out.push(p); };
  push(path.join(webapp, 'Component.js'));
  push(path.join(webapp, 'manifest.json'));
  const extDir = path.join(webapp, 'ext');
  if (fs.existsSync(extDir)) {
    for (const f of fs.readdirSync(extDir)) {
      if (/\.(js|fragment\.xml|xml)$/.test(f)) out.push(path.join(extDir, f));
    }
  }
  return out;
}

async function main() {
  const argMtar = process.argv[2];
  let mtar = argMtar;
  if (!mtar) {
    if (!fs.existsSync(MTAR_DIR)) die(`no mtar given and ${path.relative(ROOT, MTAR_DIR)} does not exist.`);
    const mtars = fs.readdirSync(MTAR_DIR).filter(f => f.endsWith('.mtar'))
      .map(f => ({ f, m: fs.statSync(path.join(MTAR_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!mtars.length) die(`no .mtar found in ${path.relative(ROOT, MTAR_DIR)}.`);
    mtar = path.join(MTAR_DIR, mtars[0].f);
  }
  if (!fs.existsSync(mtar)) die(`mtar not found: ${mtar}`);

  console.log(C.dim(`[check-shipped-admin-bundle] mtar: ${path.relative(ROOT, mtar)}`));

  // Discover admin components from source (same discovery basis as copy-components.js:
  // a component is a dir under app/admin/ with webapp/Component.js + manifest.json).
  const components = fs.readdirSync(ADMIN_SRC, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => fs.existsSync(path.join(ADMIN_SRC, name, 'webapp', 'Component.js'))
                 && fs.existsSync(path.join(ADMIN_SRC, name, 'webapp', 'manifest.json')));

  if (!components.length) die('found no admin components under app/admin/ — discovery basis changed?');

  // Crack the outer mtar (zip) → find the approuter module archive → crack that
  // (zip) → read every shipped file. All in-memory via yauzl (no temp files).
  let outerEntries;
  try {
    outerEntries = await readZipEntries(mtar);
  } catch (e) {
    die(`could not read the mtar as a zip archive: ${e && e.message || e}`);
  }
  const innerBuf = outerEntries.get(INNER_ZIP);
  if (!innerBuf) {
    die(`the mtar does not contain ${INNER_ZIP} — is this a full build including the approuter module?\n` +
        `             A srv-only (\`-m tutorials-srv\`) or otherwise scoped build will not carry the admin UI.`);
  }
  let shipped;
  try {
    shipped = await readZipEntries(innerBuf);
  } catch (e) {
    die(`could not read the approuter archive (${INNER_ZIP}) as a zip: ${e && e.message || e}`);
  }

  // Sanity: the shipped admin-ui component tree must exist at all.
  const componentJsRe = new RegExp(`^${SHIPPED_PREFIX}/[^/]+/Component\\.js$`);
  const hasAnyComponentJs = [...shipped.keys()].some(k => componentJsRe.test(k));
  if (!hasAnyComponentJs) {
    die(`the approuter archive carries no ${SHIPPED_PREFIX}/*/Component.js — the admin bundle was not built into this mtar.`);
  }

  const drift = [];
  const missing = [];
  let compared = 0;
  const norm = b => b.toString('utf8').replace(/\r\n/g, '\n');

  for (const comp of components) {
    for (const srcPath of sourceFilesFor(comp)) {
      const rel = path.relative(path.join(ADMIN_SRC, comp, 'webapp'), srcPath).replace(/\\/g, '/');
      const member = `${SHIPPED_PREFIX}/${comp}/${rel}`;
      const shippedBuf = shipped.get(member);
      if (shippedBuf === undefined) {
        missing.push(member);
        continue;
      }
      compared++;
      const srcBuf = fs.readFileSync(srcPath);
      // Normalise CRLF↔LF before compare: the approuter builder runs on Linux
      // in CI and on Windows locally; line-ending flips are not real drift.
      if (norm(shippedBuf) !== norm(srcBuf)) {
        drift.push({ member, src: path.relative(ROOT, srcPath) });
      }
    }
  }

  if (missing.length || drift.length) {
    console.error('\n' + C.red('[check-shipped-admin-bundle] the shipped admin bundle does NOT match source:'));
    for (const m of missing) console.error(C.red(`  MISSING from mtar: `) + m);
    for (const d of drift) console.error(C.red(`  STALE / differs:   `) + `${d.member}  ≠  ${d.src}`);
    console.error('\n' + C.ylw('  The mtar carries an admin UI that lags the source tree. Likely causes:'));
    console.error(C.ylw('    • deploying with --skip-build (reusing an old mtar)'));
    console.error(C.ylw('    • a module-scoped build that never rebuilt the approuter'));
    console.error(C.ylw('    • the mtar was packaged before the source change landed'));
    console.error(C.ylw('  Rebuild: `npm run deploy -- --env <env>` (full build, no --skip-build).') + '\n');
    process.exit(1);
  }

  console.log(C.grn(`  ✓ shipped admin bundle matches source `) +
              C.dim(`(${compared} files across ${components.length} components verified)`));
  process.exit(0);
}

main().catch((e) => die(String(e && e.stack || e)));
