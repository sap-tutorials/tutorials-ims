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
// LOCAL-HUGO MODE — CSS always; hashed island JS with --check-islands:
//   Hugo computes CSS content-hashes deterministically from committed source on
//   EVERY build, so the /css hrefs match what a full build ships. Island JS is
//   content-hashed via the Vite build + hugo/data/island_manifest.json. As of the
//   slug-targeted island-build fix (2026-08), that manifest IS rebuilt in every
//   content-producing mode, so locally-rendered HTML carries hashed island refs
//   too — pass --check-islands to probe them (the rebuild-content slug guard does).
//   The unhashed fallback (/js/name.js) is never probed (it can't fingerprint-drift).
//
// SERVED-CONTENT MODE (--served-base, #1678) — CSS *and* hashed JS:
//   Defense-in-depth companion to PR #1677 (the retention root-cause fix). Instead
//   of reading local hugo/public, this mode fetches the ACTUAL HANA-served tutorial
//   AND concept pages from a target approuter (the green/idle app during a
//   blue-green deploy) and probes both the /css *and* the hashed /js bundles those
//   live pages reference against that same approuter. This catches the
//   deploy-vs-shared-content mismatch that broke CSS on 2026-08-12: a fingerprint-
//   changing deploy whose new approuter dropped a hash that already-published HANA
//   content still points at. JS is safe to probe here (unlike local-hugo mode)
//   because the served HTML is ground truth — no Hugo rebuild / stale manifest is
//   involved; the unhashed fallback (/js/name.js) is always excluded.
//
// Usage:
//   # local-hugo (rebuild-content slug guard, CSS-only):
//   node scripts/check-approuter-assets.cjs --approuter-url <url> --hugo-dir <dir> [--slug <s>] [--slugs a,b,c]
//   (PUBLISH_SLUG env is honored as a --slug fallback, matching publish-content.ts.)
//   With no slug given, ALL rendered tutorial pages are scanned.
//
//   # served-content (deploy pre-swap guard, CSS + hashed JS):
//   node scripts/check-approuter-assets.cjs --served-base <url> [--served-pages /a/,/b/] [--sample-size N] [--advisory]
//   With no --served-pages, sample-size tutorial + concept pages are discovered
//   from <url>/sitemap.xml. --advisory turns a missing asset into a loud
//   non-blocking warning (exit 0) — used on the operator-gated deploy path.
//
// Exit codes: 0 = every referenced asset is served (or advisory/inconclusive) ·
//             1 = missing asset (blocking) / tooling error.

const fs = require('node:fs');
const path = require('node:path');

// Best-effort: shrink undici's keep-alive so sockets close right after each
// response instead of lingering ~4s. Without this, this script's fetches leave
// keep-alive sockets open that process.exit() force-closes — which on Windows
// (Node) can abort the process with exit code 0xC0000409 instead of the intended
// 0/1, flapping the served-mode HTTP tests. setGlobalDispatcher targets the same
// Symbol.for('undici.globalDispatcher.1') that native fetch reads, so this tames
// global fetch too. Wrapped in try/catch: if undici isn't resolvable we simply
// keep the default behavior (the failure mode is Windows-only and cosmetic).
try {
  const { setGlobalDispatcher, Agent } = require('undici');
  setGlobalDispatcher(new Agent({ pipelining: 0, keepAliveTimeout: 10, keepAliveMaxTimeout: 10 }));
} catch {
  /* undici not present — global fetch still works */
}

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
    else if (a === '--served-base') out.servedBase = argv[++i];
    else if (a === '--served-pages') out.servedPages = argv[++i];
    else if (a === '--sample-size') out.sampleSize = argv[++i];
    else if (a === '--advisory') out.advisory = true;
    else if (a === '--check-islands') out.checkIslands = true;
  }
  return out;
}

// Collect same-origin asset refs from a rendered HTML string. Always collects
// `/css/*.css` hrefs. When `includeJs` is set — served-content mode, or
// local-hugo `--check-islands` — ALSO collects HASHED `/js/*-<hash>.js` script src's — the unhashed fallback
// (`/js/name.js`, e.g. /js/joule.js) is deliberately excluded, mirroring the
// deploy-mta.cjs Step 2.5 hashed-bundle convention (#1604). Tolerant of Hugo's
// minified output where attributes are UNQUOTED (href=/css/x.css) as well as
// quoted. External (https://…) refs are excluded (only absolute-path same-origin).
function extractAssetRefs(html, { includeJs = false } = {}) {
  const refs = new Set();
  // href[=][quote?]/css/….css up to the attribute boundary. [^"'\s>]+ stops at
  // the closing quote / whitespace / tag-end in minified (unquoted) output.
  const cssRe = /href\s*=\s*["']?(\/css\/[^"'\s>]+\.css)/gi;
  let m;
  while ((m = cssRe.exec(html)) !== null) refs.add(m[1]);
  if (includeJs) {
    // src[=][quote?]/js/….js — then keep only the ones whose basename ends in
    // `-<8+ hashish chars>.js` (the fingerprinted island bundles). The unhashed
    // fallback path never fingerprint-drifts, so it must not be probed.
    const jsRe = /src\s*=\s*["']?(\/js\/[^"'\s>]+\.js)/gi;
    while ((m = jsRe.exec(html)) !== null) {
      if (/-[A-Za-z0-9_-]{8,}\.js$/.test(m[1])) refs.add(m[1]);
    }
  }
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

// ---------------------------------------------------------------------------
// Served-content mode helpers (#1678)
// ---------------------------------------------------------------------------

// GET a URL with the same retry/timeout posture as probe(), returning the body
// on a 200. redirect:'manual' so an auth-gate 30x is seen as non-200 (→ skipped
// / inconclusive) rather than silently following a login redirect.
async function fetchText(url) {
  const attempts = 3;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: ac.signal });
      const body = res.status === 200 ? await res.text() : '';
      clearTimeout(timer);
      return { ok: res.status === 200, status: res.status, body };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  return { ok: false, status: 0, body: '', error: lastErr && (lastErr.message || String(lastErr)) };
}

// Normalise a --served-pages entry to an absolute path. A full URL is reduced to
// its pathname so callers can paste sitemap <loc> values verbatim.
function normPath(p) {
  if (/^https?:\/\//i.test(p)) {
    try {
      return new URL(p).pathname;
    } catch {
      return p;
    }
  }
  return p.startsWith('/') ? p : '/' + p;
}

function clampSample(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.min(n, 25);
}

// Discover a deterministic sample of tutorial AND concept page paths from the
// target's public sitemap. <loc> values use the CANONICAL host, so we keep only
// the pathname and re-base onto --served-base at fetch time. Sorted (not random —
// Math.random is banned here and determinism aids debugging) so the same sample
// is checked every run.
async function discoverServedPages(base, sampleSize) {
  const r = await fetchText(base + '/sitemap.xml');
  if (!r.ok || !r.body) return [];
  const locs = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(r.body)) !== null) locs.push(m[1]);
  const tutorials = [];
  const concepts = [];
  for (const loc of locs) {
    let pth;
    try {
      pth = new URL(loc).pathname;
    } catch {
      continue;
    }
    if (/^\/tutorials\/[^/]+/.test(pth)) tutorials.push(pth);
    else if (/^\/concepts\/[^/]+/.test(pth)) concepts.push(pth);
  }
  tutorials.sort();
  concepts.sort();
  return [...tutorials.slice(0, sampleSize), ...concepts.slice(0, sampleSize)];
}

// Served-content mode entrypoint. Fetches HANA-served tutorial/concept pages
// from --served-base and probes their css + hashed-js assets against that same
// base. Fail-open on discovery/reachability faults (never blocks a deploy on an
// unreachable/gated channel); --advisory further downgrades a genuine MISSING to
// a loud non-blocking warning for the operator-gated blue-green swap.
async function runServedMode(args) {
  const base = (args.servedBase || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) {
    die(`--served-base must be an absolute http(s) URL, got: ${base || '(empty)'}`);
  }
  const advisory = !!args.advisory;

  // Resolve which page paths to check: explicit --served-pages, else discover.
  let paths;
  if (args.servedPages) {
    paths = args.servedPages.split(',').map((s) => s.trim()).filter(Boolean).map(normPath);
  } else {
    const sampleSize = clampSample(args.sampleSize);
    paths = await discoverServedPages(base, sampleSize);
    if (!paths.length) {
      console.error(
        '\n' +
          C.ylw(`[check-approuter-assets] INCONCLUSIVE (served): could not discover any tutorial/concept `) +
          C.ylw(`pages from ${base}/sitemap.xml — not blocking.\n`),
      );
      return 0;
    }
  }

  console.log(C.dim(`[check-approuter-assets] served mode: fetching ${paths.length} page(s) from ${base} …`));

  // Fetch each sample page; collect the union of css + hashed-js refs, tracking
  // which page each came from so a failure names the offending page.
  const refToPages = new Map(); // assetPath -> Set(pagePath)
  let fetched = 0;
  for (const p of paths) {
    const r = await fetchText(base + p);
    if (!r.ok) {
      console.error(
        C.ylw(`  ! could not fetch page ${p} (${r.status ? 'HTTP ' + r.status : 'network error'}) — skipping`),
      );
      continue;
    }
    fetched++;
    for (const ref of extractAssetRefs(r.body, { includeJs: true })) {
      if (!refToPages.has(ref)) refToPages.set(ref, new Set());
      refToPages.get(ref).add(p);
    }
  }

  if (fetched === 0) {
    console.error(
      '\n' +
        C.ylw(`[check-approuter-assets] INCONCLUSIVE (served): none of the ${paths.length} sample page(s) `) +
        C.ylw(`were reachable on ${base} (auth-gated / idle route not up yet / wrong URL) — not blocking.\n`),
    );
    return 0;
  }

  const refs = [...refToPages.keys()].sort();
  if (!refs.length) {
    console.error(
      '\n' +
        C.ylw(`[check-approuter-assets] INCONCLUSIVE (served): the ${fetched} fetched page(s) reference no `) +
        C.ylw(`same-origin /css or hashed /js assets — not blocking.\n`),
    );
    return 0;
  }

  console.log(C.dim(`  probing ${refs.length} asset(s) (css + hashed js) against ${base} (${fetched} page(s))`));

  const results = await Promise.all(refs.map(async (ref) => ({ ref, ...(await probe(base + ref)) })));
  const served = results.filter((r) => r.ok);
  const missing = results.filter((r) => !r.ok);

  // INCONCLUSIVE guard (mirrors local-hugo mode): no 200 for ANY asset means we
  // are not looking at the public static tree (auth-gated / idle not up / wrong
  // URL / down) — NOT the retention-drift signature, which leaves the bare +
  // prior-hash assets serving 200 while only the drifted hash 404s (a MIX).
  if (served.length === 0) {
    const sample = missing.slice(0, 4).map((mm) => `${mm.ref} → ${mm.status ? 'HTTP ' + mm.status : 'network error'}`);
    console.error(
      '\n' +
        C.ylw(`[check-approuter-assets] INCONCLUSIVE (served): ${base} returned no 200 for any of the ${refs.length} asset probes.\n`) +
        C.ylw('  The static tree is likely auth-gated / unreachable — not the retention-drift signature. Not blocking.\n') +
        C.dim(`  sample: ${sample.join(' | ')}\n`),
    );
    return 0;
  }

  if (missing.length) {
    const head = advisory
      ? C.ylw('[check-approuter-assets] ADVISORY (served, non-blocking): ')
      : C.red('[check-approuter-assets] BLOCKING (served): ');
    const tag = advisory ? C.ylw : C.red;
    console.error('\n' + head + `${base} does NOT serve ${missing.length} asset(s) its HANA-served pages reference:`);
    for (const mm of missing) {
      const where = [...refToPages.get(mm.ref)].slice(0, 3).join(', ');
      const detail = mm.status ? `HTTP ${mm.status}` : `network error${mm.error ? ` (${mm.error})` : ''}`;
      console.error(tag(`  MISSING (${detail}): `) + mm.ref + C.dim(`  ← referenced by: ${where}`));
    }
    console.error('\n' + C.ylw('  HANA-published tutorial/concept HTML points at a fingerprinted asset this approuter'));
    console.error(C.ylw('  does not serve — the 2026-08-12 CSS-404 incident class (now covering hashed JS too).'));
    console.error(C.ylw('  Likely asset-retention (PR #1677) failed to carry the prior hash forward, or the content'));
    console.error(C.ylw('  was published against a newer fingerprint than this approuter shipped.'));
    if (advisory) {
      console.error('\n' + C.ylw('  This is ADVISORY (the blue-green swap is operator-gated): weigh it before you resume.'));
      console.error(C.ylw('  If real, do NOT resume the swap — republish content or redeploy the static first.') + '\n');
      return 0;
    }
    console.error('\n' + C.ylw('  Fix: ship the referenced hashes into approuter static (full build+deploy), or'));
    console.error(C.ylw('  republish content for the current fingerprints, then re-check.') + '\n');
    return 1;
  }

  console.log(C.grn(`  ✓ all ${refs.length} referenced asset(s) are served by ${base} (${fetched} page(s) checked)`));
  return 0;
}

// Set the exit code and let the process terminate NATURALLY once the event loop
// drains, instead of calling process.exit(). On Windows, process.exit() while
// undici's fetch sockets are still tearing down races libuv's handle cleanup and
// aborts with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" (exit code
// 0xC0000409) — swallowing the real 0/1 result. With keep-alive shrunk to ~10ms
// (see the top of this file), the sockets close almost immediately and the loop
// empties on its own. This is the served-mode path only; the local-hugo path does
// CSS-only HEAD probes and exits fine with process.exit().
function finishServed(code) {
  process.exitCode = code;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ---- served-content mode (#1678) -------------------------------------
  // Fetches HANA-served tutorial/concept pages from a target approuter and
  // probes their css + hashed-js assets against that same approuter. Distinct
  // from local-hugo mode (below), which reads local hugo/public and is CSS-only.
  if (args.servedBase) {
    finishServed(await runServedMode(args));
    return;
  }

  // ---- local-hugo mode (rebuild-content slug guard, #1622) -------------
  const approuterUrl = (args.approuterUrl || '').trim().replace(/\/+$/, '');
  const hugoDir = args.hugoDir || 'hugo/public';

  if (!approuterUrl) {
    die('missing --approuter-url (the target approuter base URL, e.g. https://…cfapps.eu10-005.hana.ondemand.com).\n' +
        '             (For the deploy pre-swap guard, use --served-base <url> instead.)');
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
  // came from so a failure can point at the offending tutorial. (Local-hugo mode
  // probes hashed island /js assets too when --check-islands is passed; else CSS-only.)
  const refToPages = new Map(); // assetPath -> Set(slug)  (css + optionally hashed island js)
  for (const { slug, file } of pages) {
    const html = fs.readFileSync(file, 'utf8');
    for (const ref of extractAssetRefs(html, { includeJs: !!args.checkIslands })) {
      if (!refToPages.has(ref)) refToPages.set(ref, new Set());
      refToPages.get(ref).add(slug);
    }
  }

  const refs = [...refToPages.keys()].sort();
  if (!refs.length) {
    const kind = args.checkIslands ? '/css or hashed island /js' : '/css';
    die(
      `the rendered tutorial page(s) reference no ${kind} assets — the head partial changed unexpectedly.\n` +
        `             Scanned: ${pages.map((p) => p.slug).join(', ')}`,
    );
  }

  console.log(
    C.dim(
      `[check-approuter-assets] probing ${refs.length} ${args.checkIslands ? 'css+island-js' : '/css'} asset(s) against ${approuterUrl} ` +
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
    const kind = args.checkIslands ? 'CSS/JS asset(s)' : 'CSS';
    console.error('\n' + C.red(`[check-approuter-assets] the target approuter does NOT serve ${kind} the rendered HTML references:`));
    for (const m of missing) {
      const where = [...refToPages.get(m.ref)].slice(0, 3).join(', ');
      const detail = m.status ? `HTTP ${m.status}` : `network error${m.error ? ` (${m.error})` : ''}`;
      console.error(C.red(`  MISSING (${detail}): `) + m.ref + C.dim(`  ← referenced by: ${where}`));
    }
    console.error('\n' + C.ylw('  A slug-targeted rebuild publishes HTML but does NOT push approuter static, so'));
    console.error(C.ylw(`  the fingerprinted ${kind} above will 404${args.checkIslands ? ' → pages render unstyled or island bundles fail to load' : ' → pages render unstyled'}. This happens when a`));
    console.error(C.ylw(`  ${args.checkIslands ? 'CSS/JS-fingerprinting template change (e.g. #1605/#1604)' : 'CSS-fingerprinting template change (e.g. #1605)'} has not been shipped to this`));
    console.error(C.ylw('  approuter yet.'));
    console.error('\n' + C.ylw('  Fix: run a FULL build + deploy to this env first (ships hugo/public/css/* into'));
    console.error(C.ylw('  the approuter static), THEN re-run the slug rebuild. See'));
    console.error(C.ylw('  docs/developers/operations/rebuild-content-workflow.md.') + '\n');
    process.exit(1);
  }

  const kindLabel = args.checkIslands ? 'css+island-js' : '/css';
  console.log(C.grn(`  ✓ all ${refs.length} referenced ${kindLabel} asset(s) are served by the approuter`));
  process.exit(0);
}

main().catch((e) => die(String((e && e.stack) || e)));
