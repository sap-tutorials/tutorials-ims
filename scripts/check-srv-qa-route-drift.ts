// scripts/check-srv-qa-route-drift.ts
//
// Build-time guard against the recurring class of bugs documented in
// [[feedback_srv_qa_route_drift_not_caught_by_lint]]: when srv/server.js
// adds a new `app.METHOD('/content/...')` registration but srv-qa/server.js
// is not updated to match, the deployed `tutorials-srv-qa` returns 404
// for that endpoint. The chunked-publish pipeline (#585) hit this; so did
// /content/validate-answer-specs.
//
// The sibling check (scripts/check-srv-qa-cp-list.ts) catches IMPORT drift
// — every transitive `./` import reachable from srv-qa/ must be in the
// .deploy/mta.yaml cp list. It does NOT catch ROUTE drift, because both
// server.js files import from srv/lib/content-store.js — the imports stay
// symmetric while the route registrations diverge.
//
// Approach (Tier 2 = parallel structures, expected to stay in sync):
//
//   1. Extract every `app.<method>('/content/...')` registration from
//      srv/server.js — these are the "prod surface" for the content
//      pipeline (the publish CLI's contract).
//   2. Extract the same from srv-qa/server.js.
//   3. Diff. Any prod route NOT present on srv-qa is a finding unless
//      it appears in the ALLOWLIST below (intentional srv-only routes).
//
// Why only /content/*?
//
//   srv has many surfaces (/api, /admin, /build, /chat, /search, /display
//   …) that are intentionally srv-only — wiring them all to srv-qa would
//   create a noisy allowlist. /content/* is THE drift-prone surface
//   because:
//     - It's the publish-content CLI's contract (mechanical, automated)
//     - srv-qa is supposed to be a parallel author-preview channel
//     - Every new /content/* route on srv has a near-100% chance of
//       being needed on srv-qa too (or explicitly excluded)
//
// Out of scope on purpose:
//   - Method-only changes (GET→POST) — the path:method pair is what we
//     check, so a method change shows up as both "missing new" and
//     "extra old", which is the right signal
//   - Middleware chain differences (e.g. srv-qa wraps GETs in
//     requireAuthorScope, srv leaves them anonymous) — intentional
//     design difference, see srv-qa/server.js docstring
//   - Routes in the rollback / preview / health surface — these are
//     handled per-srv (no symmetry expected)
//
// Wired into the prebuild:apps script set next to check-srv-qa-cp-list.
//
// Exit codes:
//   0  every /content/* route on srv has a matching route on srv-qa
//      (or is in ALLOWLIST_ONLY_ON_SRV)
//   1  one or more routes drift. Stderr lists missing routes with the
//      copy-pasteable srv-qa/server.js line.

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = process.env.CHECK_SRV_QA_ROUTE_ROOT
  ? resolve(process.env.CHECK_SRV_QA_ROUTE_ROOT)
  : resolve(__dirname, '..');

const SRV_SERVER    = join(REPO_ROOT, 'srv', 'server.js');
const SRV_QA_SERVER = join(REPO_ROOT, 'srv-qa', 'server.js');

/**
 * Routes that are intentionally registered ONLY on srv, never on srv-qa.
 * Each entry needs a one-line reason — review will reject blank justifications.
 *
 * Format: 'METHOD /path'
 */
const ALLOWLIST_ONLY_ON_SRV: Record<string, string> = {
  'POST /content/code-check-specs':
    'AI code-check (#171) — gated behind ChatSettings.codeCheckEnabled feature flag; ' +
    'not yet wired for QA author-preview. Re-evaluate when credstore-backed ChatSettings ' +
    'reach QA.',
  'GET /content/tutorial-model/*slug':
    'Legacy AEM `.model.json` compat shim for SAP Discovery Center cards (#1685) — a public ' +
    'prod content surface consumed externally against prod, not tutorial-draft author preview. ' +
    'Discovery Center has no QA integration and srv-qa does not wire srv/lib/model-json.js. ' +
    'Same rationale as the concept-page entries below.',
  'GET /content/concepts/:slug':
    'KG concept landing pages (#446, Phase 3 Track 3-A) — a public prod content surface, ' +
    'not tutorial-draft author preview. The QA channel serves in-flight tutorials from ' +
    '-Contribution repos; concept pages are out of its scope.',
  'GET /content/concepts-index':
    'CAP-served /concepts/ LIST page (#1327 Task 2) — same public prod content surface as ' +
    'GET /content/concepts/:slug above (it is the index for those concept pages), not ' +
    'tutorial-draft author preview. The QA channel serves in-flight tutorials; concept ' +
    'pages are out of its scope.',
  'POST /content/publish/render-concepts':
    'Concept-detail publish rendering (#1327 Task 3) — renders concept pages into a publish ' +
    'session for the same public prod concept surface as GET /content/concepts/:slug. Not ' +
    'a tutorial-draft author-preview endpoint; the QA channel has no concept publish flow.',
  'POST /content/orphan-purge':
    'CI-only batched soft-delete for prod content maintenance (#823). Not an author-preview ' +
    'endpoint — the QA channel has no orphan-purge maintenance flow.',
  'POST /content/validate-answer-specs':
    'AI-grader reference-answer specs (#209). Removed from srv-qa (#1375): the handler resolves ' +
    'entities from the prod namespace com.sap.developers.ims, which the QA model ' +
    '(com.sap.developers.ims.qa) does not load, and srv-qa has no runtime reader of ' +
    'ValidateAnswerSpecs (author preview re-parses rules.vr live). The publish CLI skips this ' +
    'step for channel=qa. Re-evaluate only if QA gains a runtime /api/validate-answer surface.',
  'GET /content/authors/:login':
    'CAP-served /authors/{login}/ pages (#1659 Phase C) — a public prod content surface that ' +
    'aggregates across published tutorials, not tutorial-draft author preview. Same rationale ' +
    'as the concept-page entries above: the QA channel serves in-flight tutorials from ' +
    '-Contribution repos; author profile pages are out of its scope, and srv-qa wires no ' +
    'authorServeHandler / author publish flow.',
};

/**
 * Routes that are intentionally registered ONLY on srv-qa, never on srv.
 * (e.g. author-only preview rendering.) Same justification rule.
 */
const ALLOWLIST_ONLY_ON_SRV_QA: Record<string, string> = {
  // /preview/render is srv-qa-specific (author-only Hugo rendering).
  // Not under /content/* — out of the lint's scope by design.
};

export interface Route {
  method: string;
  path: string;
  line: number;
}

/**
 * Extract every `app.<METHOD>(<PATH>, ...)` registration where the path
 * begins with `/content/`. Strips // and /* ... *\/ comments first so
 * commented-out routes don't count.
 *
 * Returns the routes in source order with their 1-based line numbers
 * (relative to the original, uncommented content — we map back via a
 * line-shift table).
 */
export function extractContentRoutes(source: string): Route[] {
  // Blank out comments (replacing with same-length whitespace so regex line
  // offsets stay accurate) — but STRING-AWARE. A naive /\/\*...\*\// strip
  // misfires on route literals like '/content/tutorials/*slug', where the
  // `/*` inside the string is mistaken for a block-comment opener and eats
  // everything up to the next `*/` far below (this produced a false
  // `GET /content/tutorials` drift). Walk the source tracking quote state so
  // `/*` and `//` inside '…', "…", or `…` are left intact.
  const stripped = stripCommentsPreservingStrings(source);

  const out: Route[] = [];
  // app.get / .post / .put / .delete / .patch
  const re = /\bapp\.(get|post|put|delete|patch)\s*\(\s*['"`](\/content\/[^'"`]*)['"`]/gi;
  for (const m of stripped.matchAll(re)) {
    const upToMatch = stripped.slice(0, m.index);
    const line = upToMatch.split('\n').length;
    out.push({
      method: m[1].toUpperCase(),
      path: m[2],
      line,
    });
  }
  return out;
}

/**
 * Replace `//` line comments and `/* *\/` block comments with same-length
 * whitespace (newlines preserved), WITHOUT touching comment-like sequences
 * that occur inside string literals ('…', "…", `…`). This is a minimal
 * single-pass scanner, not a full JS parser — it does not attempt to handle
 * regex literals or template-expression nesting, which don't occur on the
 * `app.method('/content/…')` lines this guard inspects.
 */
export function stripCommentsPreservingStrings(source: string): string {
  const chars = [...source];
  const out: string[] = new Array(chars.length);
  let i = 0;
  let quote: string | null = null; // current string delimiter, or null

  const blank = (ch: string) => (ch === '\n' ? '\n' : ' ');

  while (i < chars.length) {
    const ch = chars[i];
    const next = chars[i + 1];

    if (quote) {
      out[i] = ch;
      if (ch === '\\') {
        // preserve the escaped char verbatim
        if (i + 1 < chars.length) out[i + 1] = chars[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    // not in a string
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out[i] = ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < chars.length && chars[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        out[i] = blank(chars[i]); i += 1;
      }
      // blank the closing */
      if (i < chars.length) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    out[i] = ch;
    i += 1;
  }
  return out.join('');
}

export interface DriftResult {
  ok: boolean;
  /** Routes on srv with no matching route on srv-qa (and not in ALLOWLIST_ONLY_ON_SRV). */
  missingFromSrvQa: Route[];
  /** Routes on srv-qa with no matching route on srv (and not in ALLOWLIST_ONLY_ON_SRV_QA). */
  missingFromSrv: Route[];
  /** All srv /content/* routes (for diagnostics). */
  srvRoutes: Route[];
  /** All srv-qa /content/* routes (for diagnostics). */
  srvQaRoutes: Route[];
}

export function checkSrvQaRouteDrift(): DriftResult {
  const srvSource    = readFileSync(SRV_SERVER, 'utf8');
  const srvQaSource  = readFileSync(SRV_QA_SERVER, 'utf8');

  const srvRoutes   = extractContentRoutes(srvSource);
  const srvQaRoutes = extractContentRoutes(srvQaSource);

  const key = (r: Route) => `${r.method} ${r.path}`;
  const srvKeys   = new Set(srvRoutes.map(key));
  const srvQaKeys = new Set(srvQaRoutes.map(key));

  const missingFromSrvQa = srvRoutes.filter(r =>
    !srvQaKeys.has(key(r)) &&
    !(key(r) in ALLOWLIST_ONLY_ON_SRV)
  );

  const missingFromSrv = srvQaRoutes.filter(r =>
    !srvKeys.has(key(r)) &&
    !(key(r) in ALLOWLIST_ONLY_ON_SRV_QA)
  );

  return {
    ok: missingFromSrvQa.length === 0 && missingFromSrv.length === 0,
    missingFromSrvQa,
    missingFromSrv,
    srvRoutes,
    srvQaRoutes,
  };
}

function main(): void {
  let result: DriftResult;
  try { result = checkSrvQaRouteDrift(); }
  catch (err) {
    console.error('[check-srv-qa-route-drift] failed:', err);
    process.exit(1);
  }

  if (result.ok) {
    const allowlistedSrvOnly   = Object.keys(ALLOWLIST_ONLY_ON_SRV).length;
    const allowlistedSrvQaOnly = Object.keys(ALLOWLIST_ONLY_ON_SRV_QA).length;
    const allowlistNote =
      (allowlistedSrvOnly + allowlistedSrvQaOnly) > 0
        ? ` (${allowlistedSrvOnly} srv-only + ${allowlistedSrvQaOnly} srv-qa-only allowlisted)`
        : '';
    console.log(
      `[check-srv-qa-route-drift] OK — ${result.srvRoutes.length} /content/* route(s) on srv, ` +
      `${result.srvQaRoutes.length} on srv-qa${allowlistNote}.`
    );
    return;
  }

  console.error('[check-srv-qa-route-drift] FAILED — /content/* route drift detected:');
  console.error('');

  if (result.missingFromSrvQa.length > 0) {
    console.error('  Routes on srv but MISSING from srv-qa/server.js:');
    for (const r of result.missingFromSrvQa) {
      console.error(`    ${r.method} ${r.path}    (srv/server.js:${r.line})`);
    }
    console.error('');
    console.error('  Fix: add the route to srv-qa/server.js. Most /content/* routes follow:');
    console.error('    app.post(\'<path>\', express.json({ limit: \'1mb\' }), contentAuthMiddleware, <handler>);');
    console.error('  Verify the handler is destructured from createContentHandlers() and');
    console.error('  its underlying lib file is in the .deploy/mta.yaml srv-qa cp list');
    console.error('  (see check-srv-qa-cp-list.ts).');
    console.error('');
    console.error('  If the route is intentionally srv-only (e.g. feature-flagged for prod),');
    console.error('  add it to ALLOWLIST_ONLY_ON_SRV in scripts/check-srv-qa-route-drift.ts');
    console.error('  with a one-line justification.');
    console.error('');
  }

  if (result.missingFromSrv.length > 0) {
    console.error('  Routes on srv-qa but MISSING from srv/server.js:');
    for (const r of result.missingFromSrv) {
      console.error(`    ${r.method} ${r.path}    (srv-qa/server.js:${r.line})`);
    }
    console.error('');
    console.error('  Fix: either remove from srv-qa/server.js, OR add it to');
    console.error('  ALLOWLIST_ONLY_ON_SRV_QA with a one-line justification.');
    console.error('');
  }

  console.error('  Symptom if shipped without fix: tutorials-srv-qa returns 404 for the');
  console.error('  missing endpoint. The publish-content:qa CLI surfaces this as');
  console.error('  `Fatal: HTTP 404: Cannot POST /content/...`. See');
  console.error('  feedback_srv_qa_route_drift_not_caught_by_lint.');
  process.exit(1);
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirect) main();
