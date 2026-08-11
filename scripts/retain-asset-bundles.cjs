'use strict';

const { readdirSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join, basename } = require('node:path');
const { mergeRetention } = require('./lib/asset-retention.cjs');

// <name>-<hash>.<js|css>, hash >= 8 chars of [A-Za-z0-9_-] with at least one uppercase or digit.
// Vite hashes look random (mixed case+digits); unhashed committed files look like words (lowercase).
// Mirrors deploy-mta.cjs Step 2.5 but filters out committed files that happen to end in -<word>.js.
const HASHED_RE = /-(?=.*[0-9A-Z])[A-Za-z0-9_-]{8,}\.(js|css)$/;

function collectHashedFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => HASHED_RE.test(f));
}

function parseArgs(argv) {
  const out = { jsDir: 'hugo/static/js', cssDir: 'hugo/static/css', manifestOut: 'hugo/static/_retained-assets.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--js-dir') out.jsDir = argv[++i];
    else if (a === '--css-dir') out.cssDir = argv[++i];
    else if (a === '--manifest-out') out.manifestOut = argv[++i];
  }
  return out;
}

async function fetchJson(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function downloadTo(url, dest, timeoutMs = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    return true;
  } catch { return false; } finally { clearTimeout(t); }
}

async function main(opts = {}) {
  const args = { ...parseArgs(process.argv.slice(2)), ...opts };
  const approuter = opts.approuterUrl ?? process.env.APPROUTER_URL ?? '';
  const windowMs = (Number(process.env.RETENTION_WINDOW_HOURS) || 48) * 3600_000;
  const nowMs = opts.nowMs ?? Date.now();

  const jsFiles = collectHashedFiles(args.jsDir).map(f => ({ file: f, dir: args.jsDir, kind: 'js' }));
  const cssFiles = collectHashedFiles(args.cssDir).map(f => ({ file: f, dir: args.cssDir, kind: 'css' }));
  const all = [...jsFiles, ...cssFiles];
  const currentFiles = all.map(x => x.file);

  let retainedManifest = [];
  if (approuter) {
    const prior = await fetchJson(`${approuter.replace(/\/$/, '')}/_retained-assets.json`);
    if (Array.isArray(prior)) retainedManifest = prior;
    else console.warn('[retain-assets] no usable prior manifest — starting fresh (fail-open).');
  } else {
    console.warn('[retain-assets] APPROUTER_URL unset — no carry-forward this build.');
  }

  const { toDownload, manifest } = mergeRetention({ currentFiles, retainedManifest, nowMs, windowMs });

  // Carry forward: download each in-window prior bundle into its dir (kind inferred by extension).
  let ok = 0, miss = 0;
  for (const file of toDownload) {
    const kind = file.endsWith('.css') ? 'css' : 'js';
    const dir = kind === 'css' ? args.cssDir : args.jsDir;
    const got = await downloadTo(`${approuter.replace(/\/$/, '')}/${kind}/${file}`, join(dir, file));
    if (got) ok++; else { miss++; console.warn(`[retain-assets] could not fetch carried ${file} — skipping (fail-open).`); }
  }

  writeFileSync(args.manifestOut, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[retain-assets] current=${currentFiles.length} carried=${ok} missed=${miss} manifest=${manifest.length} → ${args.manifestOut}`);
}

module.exports = { collectHashedFiles, parseArgs, main };

if (require.main === module) {
  main().catch(e => { console.warn('[retain-assets] fail-open:', e.message); process.exit(0); });
}
