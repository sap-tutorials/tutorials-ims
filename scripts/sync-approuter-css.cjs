#!/usr/bin/env node
/**
 * sync-approuter-css.cjs  (#2920)
 *
 * WHY THIS EXISTS
 * ----------------
 * A content rebuild (rebuild-content.yml / rebuild-content-qa.yml) publishes
 * tutorial/page HTML to HANA. The approuter serves the fingerprinted stylesheet
 * `/css/sap-fundamental.<sha256>.css` as STATIC, and (post-#1659, Phase C.4) that
 * static only changes on a full MTA deploy — a content rebuild never ships CSS.
 *
 * `sap-fundamental.css` is generated from source (gitignored since #2896) and is
 * the ONE fingerprinted stylesheet that is NOT Hugo-minified (head.html:73 is a
 * bare `| fingerprint`, no `| minify`), so its /css/<hash>.css URL == sha256 of
 * the on-disk bytes. Therefore if a rebuild builds it from HEAD source while the
 * deployed approuter still serves an OLDER build, the baked HTML references a
 * hash the approuter does not serve → the approuter-asset guard blocks publish
 * (the recurring 2026-10 freeze, #2920) OR, worse, pages publish unstyled.
 *
 * Every OTHER fingerprinted stylesheet is either committed to git (cannot drift:
 * rebuild and deploy read identical bytes) or Hugo-minified (self-heals: Hugo
 * re-minifies+re-hashes whatever on-disk bytes are present at build time). So
 * `sap-fundamental.css` is the entire drift surface.
 *
 * WHAT THIS DOES
 * ----------------
 * Instead of regenerating `sap-fundamental.css` from HEAD source on the rebuild
 * path, fetch the bytes the DEPLOYED approuter currently serves and write them to
 * `hugo/assets/css/sap-fundamental.css`. Hugo then fingerprints to the SAME hash
 * the approuter serves → baked HTML always references a stylesheet the approuter
 * has → guard always passes, pages always styled, regardless of deploy lag.
 *
 * The DEPLOY path is unchanged: `build:all` still runs `build:css` from source,
 * which is what rotates the hash on deploy. This script runs ONLY on the rebuild
 * path, making content-publish FOLLOW the deploy instead of racing ahead of it.
 *
 * FAIL-OPEN: if the approuter is unreachable or serves no discoverable
 * sap-fundamental href (e.g. a brand-new env with nothing deployed yet), fall
 * back to building from source so a fresh environment still works.
 *
 * Usage:
 *   node scripts/sync-approuter-css.cjs --approuter-url <origin>
 *     [--page <path>]   page to read the href from (default "/")
 *     [--out <file>]    output css path (default hugo/assets/css/sap-fundamental.css)
 *
 * Exit codes: 0 synced-or-fell-back-cleanly · 1 hard failure (integrity mismatch).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(REPO_ROOT, 'hugo', 'assets', 'css', 'sap-fundamental.css');
// Pages to try, in order, when discovering the served href. The homepage is
// approuter static and always carries the head partial; tutorials are HANA-served
// but also reference the same shared CSS. Multiple candidates tolerate a route
// that 404s/redirects on one surface.
const DEFAULT_PAGES = ['/', '/browse/', '/tutorials/'];
const HREF_RE = /\/css\/sap-fundamental\.([a-f0-9]{64})\.css/i;
// A browser-like UA: the PROD approuter sits behind Akamai, which 403s unknown
// (node/curl) agents. The cfapps origin does not, but passing a browser UA keeps
// this correct whether pointed at the origin or the edge host.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function log(msg) { process.stderr.write(`[sync-approuter-css] ${msg}\n`); }

function parseArgs(argv) {
  const out = { approuterUrl: '', page: '', outFile: DEFAULT_OUT };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--approuter-url') out.approuterUrl = argv[++i];
    else if (a === '--page') out.page = argv[++i];
    else if (a === '--out') out.outFile = path.resolve(argv[++i]);
  }
  return out;
}

async function fetchWithRetry(url, { asBuffer = false } = {}) {
  const attempts = 3;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    try {
      // redirect:'manual' — an auth-gate 30x must read as non-200 (→ fall back),
      // never silently followed into a login page we'd then hash.
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': UA },
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res.status !== 200) return { ok: false, status: res.status };
      const body = asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.text();
      return { ok: true, status: 200, body };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  return { ok: false, status: 0, error: lastErr && (lastErr.message || String(lastErr)) };
}

function buildFromSource() {
  log('falling back to build:css from source (approuter CSS unavailable)');
  // npm is npm.cmd on Windows, npm on POSIX. Resolve explicitly rather than
  // shell:true (which triggers Node DEP0190 and would be injection-prone with
  // dynamic args — these are fixed literals, but keep it clean).
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCmd, ['run', 'build:css'], { cwd: REPO_ROOT, stdio: 'inherit' });
}

async function main() {
  const { approuterUrl, page, outFile } = parseArgs(process.argv);
  if (!approuterUrl) {
    log('no --approuter-url given → build from source');
    buildFromSource();
    return 0;
  }
  const base = approuterUrl.replace(/\/+$/, '');
  const pages = page ? [page] : DEFAULT_PAGES;

  // 1) Discover the served sap-fundamental href from a rendered page.
  let href = '';
  for (const p of pages) {
    const r = await fetchWithRetry(base + p);
    if (r.ok && r.body) {
      const m = HREF_RE.exec(r.body);
      if (m) { href = m[0]; log(`discovered served CSS via ${p}: ${href}`); break; }
    } else {
      log(`page ${p} → HTTP ${r.status}${r.error ? ` (${r.error})` : ''}`);
    }
  }
  if (!href) {
    log('could not discover a served sap-fundamental href on any candidate page');
    buildFromSource();
    return 0;
  }
  const expectedHash = HREF_RE.exec(href)[1].toLowerCase();

  // 2) Fetch those bytes.
  const got = await fetchWithRetry(base + href, { asBuffer: true });
  if (!got.ok || !got.body) {
    log(`fetch of ${href} → HTTP ${got.status}${got.error ? ` (${got.error})` : ''}; building from source`);
    buildFromSource();
    return 0;
  }

  // 3) Integrity: the bytes MUST hash to the fingerprint in their own URL. A
  //    mismatch means a corrupt/edge-mangled response — NEVER write that; it is a
  //    hard failure (building from source here would reintroduce drift silently).
  const actualHash = crypto.createHash('sha256').update(got.body).digest('hex');
  if (actualHash !== expectedHash) {
    log(`INTEGRITY FAILURE: fetched bytes hash ${actualHash.slice(0, 12)} ≠ url hash ${expectedHash.slice(0, 12)}`);
    return 1;
  }

  // 4) Write into the Hugo assets dir so Hugo fingerprints to the SAME hash.
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, got.body);
  log(`wrote ${got.body.length} bytes → ${path.relative(REPO_ROOT, outFile)} (hash ${expectedHash.slice(0, 12)}, matches approuter)`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { log(`unexpected error: ${e && e.stack ? e.stack : e}`); process.exit(1); });
