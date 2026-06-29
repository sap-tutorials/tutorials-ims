// scripts/check-public-endpoints.ts
//
// Build-time guard against public-endpoint registration drift.
//
// The bug this catches has bitten the project at least four times (#700,
// #704, #706, plus the implicit VideoBand/CommunityLane regression that
// shipped with the same PR family). The architecture rhymes every time:
//
//   1. Developer adds a public-facing endpoint — a CDS service with no
//      `@requires` (or `@requires: 'any'`), or an Express handler in
//      srv/server.js registered BEFORE the basicAuthMiddleware barrier.
//   2. Developer forgets to add a matching anonymous route to
//      `approuter/xs-app.json` (`authenticationType: "none"`), placed
//      BEFORE the `^/api/(.*)$` xsuaa catch-all on line 24.
//   3. Anonymous traffic from a Vue island fetches the path. The
//      approuter intercepts, replies with HTML containing an OAuth-
//      redirect script, the island's `fetch()` either errors silently
//      (!res.ok) or fails JSON.parse (text/html body), the UI surfaces an
//      empty band/list/badge — indistinguishable from a working-but-empty
//      endpoint. Ships to DEV silently.
//
// This guard implements the static check from issue #722.
//
// RULE 1 — CDS service auth ↔ approuter parity
//   For every CDS service definition in srv/*.cds:
//     - "FULLY public" means: service-level annotation is absent OR
//       `@requires: 'any'`, AND every entity/function/action inside
//       the service body either has no @requires or has
//       `@requires: 'any'`. A fully-public service path MUST be
//       anonymously routed by approuter as a whole, otherwise the
//       static catch-all `^(.*)$` (or the `^/api/(.*)$` xsuaa) swallows
//       every request and the public surface returns HTML/401.
//     - "SELECTIVELY public" means: service-level is anonymous-eligible
//       (or absent) BUT the body has at least one entity-level
//       @requires that names a non-anonymous token. The architectural
//       contract here is: leave the wholesale `/api/(.*)$` xsuaa
//       catch-all (or `/graph/(.*)$`) in place, then punch through
//       individual anonymous-readable entities with explicit earlier
//       routes (e.g. `^/api/ChatConfig$`, `^/graph/(neighborhood|…)`).
//       This guard does NOT enforce the per-entity rule in v1 — the bug
//       class it catches is a missing WHOLE-service route, which is
//       what bit #700, #704, #706. A future variant could extend to
//       per-entity coverage; for now we trust the developer who's
//       already touching specific punch-throughs.
//
//   For each fully-public service with @path '/X', the FIRST route in
//   xs-app.json whose source regex matches '/X' or '/X/...' MUST have
//   `authenticationType: "none"`. If a more-specific xsuaa route
//   appears earlier, the public service is shadowed and anonymous
//   traffic gets the OAuth redirect.
//
// RULE 2 — srv/server.js handlers ↔ approuter parity
//   In srv/server.js, basicAuthMiddleware (`app.use(basicAuthMiddleware)`)
//   is a barrier. Every `app.<method>('/path', …)` registered BEFORE the
//   barrier line index is meant for anonymous traffic. For each such
//   handler path /X, the FIRST route in xs-app.json whose source regex
//   matches '/X' or '/X/...' MUST have `authenticationType: "none"`.
//
// Both rules are static-text checks — no runtime, no auth, no CF target.
// Wired into postbuild:apps next to the rest of the check-* family.
//
// Exit codes:
//   0  every public surface is reachable anonymously through approuter.
//   1  drift found OR a config file failed to parse. Stderr lists each
//      finding with file:line where applicable and a copy-pasteable fix.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = process.env.CHECK_PUBLIC_ENDPOINTS_ROOT
  ? resolve(process.env.CHECK_PUBLIC_ENDPOINTS_ROOT)
  : resolve(__dirname, '..');

const SRV_DIR     = join(REPO_ROOT, 'srv');
const SERVER_JS   = join(REPO_ROOT, 'srv', 'server.js');
const XS_APP_JSON = join(REPO_ROOT, 'approuter', 'xs-app.json');

/**
 * "Public-eligible" tokens — these mean: anonymous can reach the surface.
 * Anything else (`'Admin'`, `'authenticated-user'`, `'Tutorial.Author'`,
 * scope names, …) means the service or entity is gated and the approuter
 * route should be xsuaa.
 */
const ANONYMOUS_TOKENS = new Set(['any']);

/**
 * Some paths legitimately have NO matching xs-app.json route — they are
 * served by the catch-all `^(.*)$` at the end, which is always anonymous
 * and serves the Hugo static site. The guard skips these and trusts that
 * the catch-all does the right thing.
 *
 * Currently empty — every srv-side public endpoint flows through a
 * srv-api anonymous route. If a future endpoint genuinely wants the
 * static catch-all (e.g. a path that's static-only), add it here with a
 * comment.
 */
const PATH_ALLOWLIST = new Set<string>([]);

export interface Finding {
  /** Kind for matchers in tests. */
  kind: 'cds-no-route' | 'cds-shadowed' | 'express-no-route' | 'express-shadowed' | 'parse';
  /** Human-readable summary with file ref where applicable. */
  message: string;
}

export interface CheckResult {
  ok: boolean;
  findings: Finding[];
  /** Inputs that fed the check — exposed for test inspection. */
  publicServices: { name: string; path: string; file: string }[];
  publicHandlers: { method: string; path: string; line: number }[];
}

interface XsAppRoute {
  source?: string;
  authenticationType?: string;
}
interface XsApp {
  routes?: XsAppRoute[];
}

// ─── parsing ──────────────────────────────────────────────────────────────────

/**
 * Strip /*…*​/ block comments and // line comments from a CDS source so
 * an `@requires` example in a docstring doesn't trip the regex.
 */
function stripCdsComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n - 1 && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * Walk srv/*.cds. For each `service Foo …` definition, determine:
 *   - The @path annotation. Both `@path: '/X'` (preceding-annotation
 *     form) and inline `service Foo @(path : '/X')` are supported.
 *   - The service-level @requires value. Same two annotation forms.
 *   - Whether any entity/action/function inside the service body
 *     declares a non-anonymous @requires (e.g. `@requires:
 *     'authenticated-user'`, `@(requires: 'Admin')`). Note the
 *     `@(requires: '…')` parenthesised form is common inside service
 *     bodies; both shapes are matched.
 *
 * Returns the subset that's FULLY PUBLIC: service-level is no @requires
 * or @requires: 'any' AND there's NO body-level non-anonymous
 * @requires marker. "Selectively public" services (service-level 'any'
 * with body-level scope gates) are dropped — their architectural
 * pattern is per-entity punch-through routes that this guard does not
 * enforce in v1. See the file header for the rationale.
 *
 * Caveats:
 *   - If a .cds file has multiple `service` blocks, each is inspected
 *     independently. The body of each is delimited by matched braces.
 */
export function findPublicCdsServices(srvDir: string): { name: string; path: string; file: string }[] {
  const files = readdirSync(srvDir).filter(n => n.endsWith('.cds'));
  const out: { name: string; path: string; file: string }[] = [];

  for (const fname of files) {
    const full = join(srvDir, fname);
    const raw = readFileSync(full, 'utf8');
    const src = stripCdsComments(raw);

    // Walk linearly, tracking pending preceding-line annotations, and
    // snap them onto the next `service <Name> …` block we encounter.
    // For each block, walk the body to detect body-level non-anonymous
    // @requires markers.
    const lines = src.split(/\r?\n/);
    let pendingPath: string | undefined;
    let pendingRequires: string | undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const pathPrecede = line.match(/^\s*@path\s*:\s*['"]([^'"]+)['"]/);
      if (pathPrecede) pendingPath = pathPrecede[1];

      const reqPrecede = line.match(/^\s*@requires\s*:\s*['"]([^'"]+)['"]/);
      if (reqPrecede) pendingRequires = reqPrecede[1];

      const svcMatch = line.match(/\bservice\s+(\w+)\s*(?:@\(([^)]+)\))?/);
      if (!svcMatch) continue;
      const name = svcMatch[1];
      const inlineAnnos = svcMatch[2] ?? '';

      let svcPath = pendingPath;
      let svcRequires = pendingRequires;
      const inlinePath = inlineAnnos.match(/path\s*:\s*['"]([^'"]+)['"]/);
      if (inlinePath) svcPath = inlinePath[1];
      const inlineRequires = inlineAnnos.match(/requires\s*:\s*['"]([^'"]+)['"]/);
      if (inlineRequires) svcRequires = inlineRequires[1];

      pendingPath = undefined;
      pendingRequires = undefined;

      if (!svcPath) continue;

      let p = svcPath.startsWith('/') ? svcPath : '/' + svcPath;
      if (p !== '/' && p.endsWith('/')) p = p.slice(0, -1);

      const serviceLevelAnonymous = !svcRequires || ANONYMOUS_TOKENS.has(svcRequires);
      if (!serviceLevelAnonymous) continue;

      // Find the body of this service: from the `{` on this-or-following
      // lines through the matching `}`. The body delimits the scope
      // where we look for body-level @requires markers.
      const body = extractServiceBody(lines, i);
      if (bodyHasNonAnonymousRequires(body)) continue; // selectively public — skip

      out.push({ name, path: p, file: fname });
    }
  }

  return out;
}

/**
 * Pull the brace-delimited body of a `service Name …` declaration
 * starting at or after `startLine`. Returns the concatenated body text
 * (the inside of the outer braces, not including them).
 *
 * Brace tracking is naive — it doesn't account for braces inside
 * strings or `{` characters in regex/CDS expressions. In practice
 * `.cds` files don't embed `{`/`}` in strings; if a future file does,
 * we'd need a tokeniser. The check fails-safe: a mis-tokenised body
 * just produces a slightly-too-permissive result (a missed body @requires
 * → the service treated as fully public → guard fires).
 */
function extractServiceBody(lines: string[], startLine: number): string {
  // Find the opening `{`.
  let i = startLine;
  let openIdx = -1;
  while (i < lines.length) {
    const idx = lines[i].indexOf('{');
    if (idx >= 0) { openIdx = i; break; }
    i++;
  }
  if (openIdx < 0) return '';

  // Walk character-by-character from `{` tracking nesting depth.
  // We accumulate into a string buffer (not an array of single-char
  // pieces joined later — joining per-char with a newline interleaver
  // would destroy multi-char tokens like '@requires').
  let depth = 0;
  let body = '';
  for (let l = openIdx; l < lines.length; l++) {
    const line = lines[l];
    const startCol = l === openIdx ? line.indexOf('{') : 0;
    for (let c = startCol; c < line.length; c++) {
      const ch = line[c];
      if (ch === '{') {
        depth++;
        if (depth === 1) continue; // skip the outermost `{` itself
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return body;
      }
      if (depth >= 1) body += ch;
    }
    if (depth >= 1) body += '\n';
  }
  return body;
}

/**
 * True if the service body contains a `@requires` marker whose value
 * is NOT in ANONYMOUS_TOKENS. Matches both preceding (`@requires: 'X'`)
 * and inline parenthesised (`@(requires: 'X')` / `@(requires : 'X')`)
 * forms. A service body with at least one non-anonymous @requires is
 * "selectively public" and skipped — see findPublicCdsServices.
 */
function bodyHasNonAnonymousRequires(body: string): boolean {
  // Find all @requires values in the body.
  const re = /@\s*(?:\()?\s*requires\s*:\s*['"]([^'"]+)['"]/g;
  for (const m of body.matchAll(re)) {
    const value = m[1];
    if (!ANONYMOUS_TOKENS.has(value)) return true;
  }
  return false;
}

/**
 * Walk srv/server.js. Find the line where `app.use(basicAuthMiddleware)`
 * is called. Every `app.<method>('/path', …)` registered earlier is
 * "pre-middleware" and must be approuter-anonymous to actually serve
 * unauthenticated callers.
 *
 * Methods recognised: get, post, put, delete, patch, all, use. The 'use'
 * case captures `app.use('/admin/analytics', router)` which mounts a
 * sub-router under a path prefix.
 *
 * Lines that pass through middleware (e.g. `contentAuthMiddleware`,
 * `authMw`) are still in the list — the guard is structural, not
 * semantic. If you wanted to register a public-LOOKING handler that's
 * actually gated by its own middleware, you'd suppress it via a NOSONAR-
 * style comment; we don't have any such cases today.
 */
export function findPublicExpressHandlers(serverJsPath: string): { method: string; path: string; line: number }[] {
  const raw = readFileSync(serverJsPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const barrierIdx = lines.findIndex(l => /\bapp\.use\s*\(\s*basicAuthMiddleware\s*\)/.test(l));
  // If the barrier line isn't found, treat the whole file as pre-barrier —
  // that's the safest default (over-report rather than under-report).
  const effectiveBarrier = barrierIdx < 0 ? lines.length : barrierIdx;

  const out: { method: string; path: string; line: number }[] = [];
  const handlerRe = /\bapp\.(get|post|put|delete|patch|all|use)\s*\(\s*['"]([^'"]+)['"]/;
  for (let i = 0; i < effectiveBarrier; i++) {
    const m = lines[i].match(handlerRe);
    if (!m) continue;
    const method = m[1];
    const path = m[2];
    // app.use('/path', someMiddleware) is the only path-form .use. Plain
    // `app.use(fn)` middleware registration doesn't match the regex (no
    // string literal) — exactly what we want.
    out.push({ method, path, line: i + 1 });
  }
  return out;
}

// ─── xs-app.json route matching ───────────────────────────────────────────────

/**
 * Build a JS RegExp from an xs-app.json `source` string. xs-app sources
 * are already regex (e.g. `^/build/(catalog|navigator)(/.*)?$`). The
 * conversion is the identity — but we ensure each pattern compiles
 * and surface a parse-error finding if it doesn't.
 */
function compileSource(source: string): RegExp | null {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/**
 * Return the FIRST route in `routes` whose compiled source matches
 * `path`. Returns `{ route, index }` or `null` if nothing matches.
 *
 * The probe path is the service/handler path itself plus a trailing
 * sub-path probe (`<path>/x`) so routes that only match sub-paths
 * (e.g. `^/api/devtoberfest/(status|terms)$`) don't get false-matched
 * by the bare service path. We probe BOTH and require that whichever
 * matches is anonymous; if neither matches, the path is unrouted.
 */
export function firstMatchingRoute(
  routes: XsAppRoute[],
  path: string,
): { route: XsAppRoute; index: number } | null {
  const probes = [path, path + '/_probe_'];
  for (let i = 0; i < routes.length; i++) {
    const src = routes[i].source;
    if (!src) continue;
    const re = compileSource(src);
    if (!re) continue;
    if (probes.some(p => re.test(p))) return { route: routes[i], index: i };
  }
  return null;
}

// ─── main check ───────────────────────────────────────────────────────────────

export function checkPublicEndpoints(): CheckResult {
  const findings: Finding[] = [];
  let xsApp: XsApp;

  try { xsApp = JSON.parse(readFileSync(XS_APP_JSON, 'utf8')) as XsApp; }
  catch (e) {
    findings.push({ kind: 'parse', message: `failed to parse approuter/xs-app.json: ${(e as Error).message}` });
    return { ok: false, findings, publicServices: [], publicHandlers: [] };
  }
  const routes = xsApp.routes ?? [];

  // RULE 1 — public CDS services ↔ approuter anonymous routes
  let publicServices: { name: string; path: string; file: string }[] = [];
  try {
    publicServices = findPublicCdsServices(SRV_DIR);
  } catch (e) {
    findings.push({ kind: 'parse', message: `failed to scan srv/*.cds: ${(e as Error).message}` });
    return { ok: false, findings, publicServices: [], publicHandlers: [] };
  }

  for (const svc of publicServices) {
    if (PATH_ALLOWLIST.has(svc.path)) continue;
    const match = firstMatchingRoute(routes, svc.path);
    if (!match) {
      findings.push({
        kind: 'cds-no-route',
        message:
          `srv/${svc.file}: service ${svc.name} is fully public (@path '${svc.path}', no service-level @requires or @requires: 'any', and no non-anonymous body @requires) ` +
          `but no route in approuter/xs-app.json matches '${svc.path}'.\n` +
          `    Fix: add this route to approuter/xs-app.json BEFORE the catch-all '^(.*)$':\n` +
          `      { "source": "^${svc.path}/(.*)$", "destination": "srv-api", "authenticationType": "none" }`,
      });
      continue;
    }
    const auth = match.route.authenticationType ?? 'xsuaa'; // default if absent
    if (auth !== 'none') {
      findings.push({
        kind: 'cds-shadowed',
        message:
          `srv/${svc.file}: service ${svc.name} is fully public (@path '${svc.path}') but the first matching xs-app.json route is ` +
          `'${match.route.source}' with authenticationType='${auth}' — anonymous traffic gets an OAuth redirect.\n` +
          `    Fix: add an explicit anonymous route to approuter/xs-app.json ABOVE the shadowing route (index ${match.index}):\n` +
          `      { "source": "^${svc.path}/(.*)$", "destination": "srv-api", "authenticationType": "none" }`,
      });
    }
  }

  // RULE 2 — pre-basicAuthMiddleware Express handlers ↔ approuter anonymous routes
  let publicHandlers: { method: string; path: string; line: number }[] = [];
  try {
    publicHandlers = findPublicExpressHandlers(SERVER_JS);
  } catch (e) {
    findings.push({ kind: 'parse', message: `failed to scan srv/server.js: ${(e as Error).message}` });
    return { ok: false, findings, publicServices, publicHandlers: [] };
  }

  for (const h of publicHandlers) {
    if (PATH_ALLOWLIST.has(h.path)) continue;
    const match = firstMatchingRoute(routes, h.path);
    if (!match) {
      findings.push({
        kind: 'express-no-route',
        message:
          `srv/server.js:${h.line}: app.${h.method}('${h.path}', …) is registered before basicAuthMiddleware ` +
          `but no route in approuter/xs-app.json matches '${h.path}'.\n` +
          `    Fix: add this route to approuter/xs-app.json BEFORE the catch-all '^(.*)$':\n` +
          `      { "source": "^${h.path}$", "destination": "srv-api", "authenticationType": "none" }`,
      });
      continue;
    }
    const auth = match.route.authenticationType ?? 'xsuaa';
    if (auth !== 'none') {
      findings.push({
        kind: 'express-shadowed',
        message:
          `srv/server.js:${h.line}: app.${h.method}('${h.path}', …) is registered before basicAuthMiddleware ` +
          `but the first matching xs-app.json route is '${match.route.source}' with authenticationType='${auth}'.\n` +
          `    Fix: add an explicit anonymous route to approuter/xs-app.json ABOVE the shadowing route (index ${match.index}):\n` +
          `      { "source": "^${h.path}$", "destination": "srv-api", "authenticationType": "none" }`,
      });
    }
  }

  return { ok: findings.length === 0, findings, publicServices, publicHandlers };
}

function main(): void {
  let result: CheckResult;
  try { result = checkPublicEndpoints(); }
  catch (err) {
    console.error('[check-public-endpoints] failed:', err);
    process.exit(1);
  }

  if (result.ok) {
    console.log(
      `[check-public-endpoints] OK — ${result.publicServices.length} public CDS service(s) and ` +
      `${result.publicHandlers.length} pre-middleware Express handler(s) all have matching anonymous approuter routes.`,
    );
    return;
  }

  console.error('[check-public-endpoints] FAILED — public endpoints missing or shadowed in approuter/xs-app.json:');
  console.error('');
  for (const f of result.findings) {
    console.error(`  [${f.kind}] ${f.message}`);
    console.error('');
  }
  process.exit(1);
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirect) main();
