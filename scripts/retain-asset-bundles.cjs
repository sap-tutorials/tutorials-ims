'use strict';

const { readdirSync, existsSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { mergeRetention } = require('./lib/asset-retention.cjs');

// <name>-<hash>.<js|css>, hash >= 8 chars of [A-Za-z0-9_-] with at least one uppercase or digit.
// Vite/Hugo content hashes are base62 and effectively always contain an uppercase letter or digit
// within 8 chars, so pure-lowercase-no-digit hashes are rare/nonexistent. This filters out
// committed files that mimic the pattern (e.g., consent-trustarc.js) without requiring island-manifest
// cross-reference (which only covers islands, not Hugo-fingerprinted CSS). Acceptable for MVP.
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
  const allFiles = [...jsFiles, ...cssFiles];
  const currentFiles = allFiles.map(x => x.file);

  let retainedManifest = [];
  if (approuter) {
    const prior = await fetchJson(`${approuter.replace(/\/$/, '')}/_retained-assets.json`);
    if (Array.isArray(prior)) retainedManifest = prior;
    else console.warn('[retain-assets] no usable prior manifest — starting fresh (fail-open).');
  } else {
    console.warn('[retain-assets] APPROUTER_URL unset — no carry-forward this build.');
  }

  const { toDownload, manifest } = mergeRetention({ currentFiles, retainedManifest, nowMs, windowMs });

  // Map downloaded files back to their kind/dir for download placement.
  const fileMetadata = new Map(allFiles.map(f => [f.file, f]));

  // Carry forward: download each in-window prior bundle into its dir.
  let ok = 0, miss = 0;
  for (const file of toDownload) {
    const meta = fileMetadata.get(file) || { kind: file.endsWith('.css') ? 'css' : 'js', dir: file.endsWith('.css') ? args.cssDir : args.jsDir };
    const got = await downloadTo(`${approuter.replace(/\/$/, '')}/${meta.kind}/${file}`, join(meta.dir, file));
    if (got) ok++; else { miss++; console.warn(`[retain-assets] could not fetch carried ${file} — skipping (fail-open).`); }
  }

  writeFileSync(args.manifestOut, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[retain-assets] current=${currentFiles.length} carried=${ok} missed=${miss} manifest=${manifest.length} → ${args.manifestOut}`);
}

module.exports = { collectHashedFiles, parseArgs, main };

if (require.main === module) {
  main().catch(e => { console.warn('[retain-assets] fail-open:', e.message); process.exit(0); });
}
