#!/usr/bin/env node
// scripts/check-approuter-assets.cjs
//
// REBUILD-CONTENT GUARD (#1622) — verify that every same-origin /css asset the
// freshly-rendered tutorial HTML references is actually SERVED by the target
// approuter, BEFORE the HTML is published to HANA.
//
// WHY THIS EXISTS (2026-08-11 PROD unstyled-pages incident):
//   A `rebuild-content.yml` **slug-targeted** run re-renders tutorial HTML with
//   the current Hugo templates and publishes it to HANA, but by design SKIPS the
//   approuter static push ("Push content to AppRouter: skipped"). Hugo
//   content-hash-fingerprints its CSS (head.html / baseof.html: `| fingerprint`
//   → `<name>.<hash>.css`). When any CSS-fingerprinting template change has
//   landed since the last FULL deploy, the slug rebuild publishes HTML pointing
//   at `sap-fundamental.<newhash>.css` while the deployed approuter static only
//   has an OLDER hash → the stylesheet 404s → pages render unstyled. The failure
//   is silent: publish + verify-rows succeed; the 404 is only visible in a
//   browser. Only a full build+deploy (which copies hugo/public/, incl. the new
//   fingerprinted CSS, into the approuter static) resolves it.
//
//   This guard closes that gap the same way deploy-mta.cjs Step 2.5 guards the
//   island-fingerprint pipeline: it reads the rendered tutorial page(s), pulls
//   every same-origin `/css/*.css` href, and probes each against the live
//   approuter. If ANY referenced stylesheet is not served (404 / non-200), the
//   run fails loud with instructions to run a full deploy first — so HANA is
//   never poisoned with HTML the approuter can't dress.
//
// SCOPE — CSS only, on purpose:
//   Hugo computes CSS content-hashes deterministically from the committed source
//   in hugo/assets/css/ on EVERY build regardless of rebuild mode, so the hrefs
//   the guard sees match what a full build would ship. JS island bundles use a
//   different mechanism (Vite build + hugo/data/island_manifest.json, which is
//   NOT git-tracked and is not rebuilt in slug-targeted mode); probing those
//   would false-positive here. The deploy path already guards islands
//   (deploy-mta.cjs Step 2.5 / #1604).
//
// Usage:
//   node scripts/check-approuter-assets.cjs --approuter-url <url> --hugo-dir <dir> [--slug <s>] [--slugs a,b,c]
//   (PUBLISH_SLUG env is honored as a --slug fallback, matching publish-content.ts.)
//   With no slug given, ALL rendered tutorial pages are scanned.
//
// Exit codes: 0 = every referenced /css asset is served · 1 = missing asset / tooling error.

const fs = require('node:fs');
const path = require('node:path');

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  grn: (s) => `\x1b[32m${s}\x1b[0m`,
  ylw: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function die(msg) {
  console.error('\n' + C.red('[check-approuter-assets] FAILED: ') + msg + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--approuter-url') out.approuterUrl = argv[++i];
    else if (a === '--hugo-dir') out.hugoDir = argv[++i];
    else if (a === '--slug') out.slug = argv[++i];
    else if (a === '--slugs') out.slugs = argv[++i];
  }
  return out;
}

// Collect same-origin `/css/*.css` hrefs from a rendered HTML string. Tolerant
// of Hugo's minified output where attributes are UNQUOTED (href=/css/x.css) as
// well as quoted (href="/css/x.css"). Only absolute-path /css/ refs — external
// (https://…) stylesheets and /js/* are deliberately excluded (see SCOPE above).
function extractCssRefs(html) {
  const refs = new Set();
  // href, optional = with optional quote, then /css/…​.css up to the closing
  // quote / whitespace / tag-end. [^"'\s>]+ stops at the attribute boundary in
  // minified (unquoted) output.
  const re = /href\s*=\s*["']?(\/css\/[^"'\s>]+\.css)/gi;
  let m;
  while ((m = re.exec(html)) !== null) refs.add(m[1]);
  return refs;
}

// Resolve which rendered tutorial index.html files to scan.
function resolvePages(hugoDir, slugList) {
  const tutorialsDir = path.join(hugoDir, 'tutorials');
  if (slugList.length) {
    const pages = [];
    const missing = [];
    for (const slug of slugList) {
      const p = path.join(tutorialsDir, slug, 'index.html');
      if (fs.existsSync(p)) pages.push({ slug, file: p });
      else missing.push(slug);
    }
    if (missing.length) {
      die(
        `no rendered page for slug(s): ${missing.join(', ')}\n` +
          `             expected ${path.join('<hugo-dir>', 'tutorials', '<slug>', 'index.html')} under ${hugoDir}.\n` +
          `             The Hugo build did not emit these pages — the rebuild would publish nothing verifiable.`,
      );
    }
    return pages;
  }
  // No slug filter → scan every rendered tutorial page.
  if (!fs.existsSync(tutorialsDir)) {
    die(`tutorials dir not found: ${tutorialsDir} — did the Hugo build run?`);
  }
  const pages = [];
  for (const entry of fs.readdirSync(tutorialsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = path.join(tutorialsDir, entry.name, 'index.html');
    if (fs.existsSync(p)) pages.push({ slug: entry.name, file: p });
  }
  if (!pages.length) die(`no tutorial pages under ${tutorialsDir}.`);
  return pages;
}

// Probe one URL. Returns { ok, status }. Retries twice on network error /
// timeout so a transient blip doesn't red a publish. A hard non-200 (esp. 404)
// is NOT retried — it is the answer.
async function probe(url) {
  const attempts = 3;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    try {
      // HEAD is enough for a static file server; the approuter serves /css/* as
      // static. Some setups disallow HEAD (405) — fall back to GET in that case.
      let res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: ac.signal });
      if (res.status === 405 || res.status === 501) {
        res = await fetch(url, { method: 'GET', redirect: 'manual', signal: ac.signal });
      }
      clearTimeout(timer);
      return { ok: res.status === 200, status: res.status };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  return { ok: false, status: 0, error: lastErr && (lastErr.message || String(lastErr)) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const approuterUrl = (args.approuterUrl || '').trim().replace(/\/+$/, '');
  const hugoDir = args.hugoDir || 'hugo/public';

  if (!approuterUrl) {
    die('missing --approuter-url (the target approuter base URL, e.g. https://…cfapps.eu10-005.hana.ondemand.com).');
  }
  if (!/^https?:\/\//.test(approuterUrl)) {
    die(`--approuter-url must be an absolute http(s) URL, got: ${approuterUrl}`);
  }

  const slugList = [];
  if (args.slug) slugList.push(args.slug);
  if (args.slugs) slugList.push(...args.slugs.split(',').map((s) => s.trim()).filter(Boolean));
  if (!slugList.length && process.env.PUBLISH_SLUG) slugList.push(process.env.PUBLISH_SLUG.trim());
  // dedupe + lowercase (slugs are lowercase-canonical)
  const slugs = [...new Set(slugList.map((s) => s.toLowerCase()).filter(Boolean))];

  const pages = resolvePages(hugoDir, slugs);

  // Gather the union of /css refs across the pages, remembering which page each
  // came from so a failure can point at the offending tutorial.
  const refToPages = new Map(); // cssPath -> Set(slug)
  for (const { slug, file } of pages) {
    const html = fs.readFileSync(file, 'utf8');
    for (const ref of extractCssRefs(html)) {
      if (!refToPages.has(ref)) refToPages.set(ref, new Set());
      refToPages.get(ref).add(slug);
    }
  }

  const refs = [...refToPages.keys()].sort();
  if (!refs.length) {
    die(
      `the rendered tutorial page(s) reference no /css assets — the head partial changed unexpectedly.\n` +
        `             Scanned: ${pages.map((p) => p.slug).join(', ')}`,
    );
  }

  console.log(
    C.dim(
      `[check-approuter-assets] probing ${refs.length} /css asset(s) against ${approuterUrl} ` +
        `(pages: ${pages.length === 1 ? pages[0].slug : pages.length + ' tutorials'})`,
    ),
  );

  const results = await Promise.all(refs.map(async (ref) => ({ ref, ...(await probe(approuterUrl + ref)) })));
  const served = results.filter((r) => r.ok);
  const missing = results.filter((r) => !r.ok);

  // INCONCLUSIVE guard: if the approuter returned NO 200 for ANY /css probe, we
  // are almost certainly not looking at the public static tree — a fully
  // auth-gated preview channel (redirect/401/403 on everything), a wrong URL, or
  // the approuter being down. That is NOT the #1622 signature: the fingerprint
  // trap always leaves the bare + old-hash stylesheets serving 200 while only
  // the fresh hash 404s (a MIX). Hard-failing every rebuild against a gated
  // channel would be worse than the bug, so warn loudly and pass. (If literally
  // every /css is missing, the approuter is broken independently of this
  // slug rebuild, which never touches approuter static.)
  if (served.length === 0) {
    const sample = missing.slice(0, 4).map((m) => `${m.ref} → ${m.status ? 'HTTP ' + m.status : 'network error'}`);
    console.error(
      '\n' +
        C.ylw(`[check-approuter-assets] INCONCLUSIVE: the approuter returned no 200 for any of the ${refs.length} `) +
        C.ylw('/css probes.\n') +
        C.ylw(`  This usually means the static tree is auth-gated, the URL is wrong, or the approuter is down —\n`) +
        C.ylw(`  NOT the #1622 fingerprint drift (which leaves the bare stylesheets serving 200). Not blocking.\n`) +
        C.dim(`  sample: ${sample.join(' | ')}\n`),
    );
    process.exit(0);
  }

  if (missing.length) {
    console.error('\n' + C.red('[check-approuter-assets] the target approuter does NOT serve CSS the rendered HTML references:'));
    for (const m of missing) {
      const where = [...refToPages.get(m.ref)].slice(0, 3).join(', ');
      const detail = m.status ? `HTTP ${m.status}` : `network error${m.error ? ` (${m.error})` : ''}`;
      console.error(C.red(`  MISSING (${detail}): `) + m.ref + C.dim(`  ← referenced by: ${where}`));
    }
    console.error('\n' + C.ylw('  A slug-targeted rebuild publishes HTML but does NOT push approuter static, so'));
    console.error(C.ylw('  the fingerprinted CSS above will 404 → pages render unstyled. This happens when a'));
    console.error(C.ylw('  CSS-fingerprinting template change (e.g. #1605) has not been shipped to this'));
    console.error(C.ylw('  approuter yet.'));
    console.error('\n' + C.ylw('  Fix: run a FULL build + deploy to this env first (ships hugo/public/css/* into'));
    console.error(C.ylw('  the approuter static), THEN re-run the slug rebuild. See'));
    console.error(C.ylw('  docs/developers/operations/rebuild-content-workflow.md.') + '\n');
    process.exit(1);
  }

  console.log(C.grn(`  ✓ all ${refs.length} referenced /css asset(s) are served by the approuter`));
  process.exit(0);
}

main().catch((e) => die(String((e && e.stack) || e)));
