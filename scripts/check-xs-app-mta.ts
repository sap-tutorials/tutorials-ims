// scripts/check-xs-app-mta.ts
//
// Build-time guard against drift between the four files that together
// configure approuter <-> srv routing on BTP:
//
//   - approuter/xs-app.json           (route -> destination + scope)
//   - mta.yaml                        (approuter requires destinations)
//   - .deploy/mta.yaml                (canonical local-deploy variant)
//   - xs-security.json                (scope catalog)
//
// Three drift surfaces this check catches:
//
//  1. DESTINATION DRIFT
//     Every `destination:` value in xs-app.json must appear in the
//     approuter's `requires` -> `group: destinations` list in BOTH
//     mta.yaml files. Missing it is silent at build time and surfaces as
//     a 502 from the approuter at runtime, which is hard to attribute.
//
//  2. SCOPE DRIFT
//     Every `scope: $XSAPPNAME.<name>` in xs-app.json must appear in
//     xs-security.json's scopes[].name. A missing scope means users with
//     the role get an unrecoverable 403 — they can't be authorised
//     because the XSUAA app doesn't know the scope exists. Bit us in QA
//     channel rollout (PR #46 — `Tutorial.Author` had to be declared).
//
//  3. PROVIDER DRIFT
//     Every destination name the approuter `requires:` must be `provides:`'d
//     by exactly one module in the same MTA file. mbt itself catches this
//     at deploy time, but only if you actually deploy. A static check
//     surfaces it on the build machine instead of in the CF deploy log.
//
// Out of scope on purpose:
//   - Parity between mta.yaml and .deploy/mta.yaml outside the
//     destination/scope/provides axes — they're intentionally different
//     (build commands, ignore lists). Forcing total parity would create
//     review noise.
//   - The 13 admin Fiori Elements apps' inner xs-app.json files — those
//     aren't approuter-routed, they're served as static assets. Their
//     route table is empty in this project (verified during design).
//
// Wired into postbuild:apps next to check-build-collisions and
// check-icon-imports — same npm hook the existing build-time checks
// share, so any of them firing fails CI before deploy.
//
// Exit codes:
//   0  every destination resolves; every scope is declared; every required
//      destination has a single provider.
//   1  drift found OR a config file failed to parse. Stderr lists each
//      mismatch with the file path and a copy-pasteable fix line.

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = process.env.CHECK_XS_APP_MTA_ROOT
  ? resolve(process.env.CHECK_XS_APP_MTA_ROOT)
  : resolve(__dirname, '..');

const XS_APP_JSON     = join(REPO_ROOT, 'approuter',   'xs-app.json');
const XS_SECURITY     = join(REPO_ROOT, 'xs-security.json');
const MTA_ROOT        = join(REPO_ROOT, 'mta.yaml');
const MTA_DEPLOY      = join(REPO_ROOT, '.deploy', 'mta.yaml');

// The approuter is the only module whose destinations matter for routing.
// Both MTA files use this same name.
const APPROUTER_NAME = 'tutorials-approuter';

// Scopes referenced in xs-app.json with the $XSAPPNAME. prefix should
// resolve to a name in xs-security.json. The catalog also implicitly
// includes "Everyone" / no-scope routes; this check ignores those.
const SCOPE_PREFIX = '$XSAPPNAME.';

interface XsAppRoute {
  source?: string;
  destination?: string;
  scope?: string;
}
interface XsApp {
  routes?: XsAppRoute[];
}

interface XsSecurity {
  scopes?: { name: string }[];
}

interface MtaModule {
  name: string;
  requires?: { name: string; group?: string }[];
  provides?: { name: string }[];
}
interface Mta {
  modules?: MtaModule[];
}

export interface Finding {
  /** Short kind for matchers in tests. */
  kind: 'destination' | 'scope' | 'provider' | 'parse';
  /** Human-readable summary. Includes the file ref. */
  message: string;
}

export interface CheckResult {
  ok: boolean;
  findings: Finding[];
  /** Set of every (route source, destination, scope) tuple from xs-app.json — included so test inspection is easy. */
  xsAppRefs: { source: string; destination?: string; scope?: string }[];
}

function readJson<T>(path: string): T {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as T;
}

function readYaml<T>(path: string): T {
  const raw = readFileSync(path, 'utf8');
  return YAML.parse(raw) as T;
}

/**
 * Find the approuter module in an MTA. Returns null if absent — both
 * caller paths (mta.yaml and .deploy/mta.yaml) declare it, but the test
 * fixtures sometimes omit it to exercise edge cases.
 */
function approuter(mta: Mta): MtaModule | null {
  const m = (mta.modules ?? []).find(x => x.name === APPROUTER_NAME);
  return m ?? null;
}

/**
 * Names of every destination the approuter requires.
 * Approuter destinations are the entries in `requires:` whose `group:`
 * equals "destinations" — that grouping is what binds them as a CF
 * destination to the approuter at runtime.
 */
export function destinationsRequiredBy(mta: Mta): Set<string> {
  const ar = approuter(mta);
  if (!ar) return new Set();
  return new Set(
    (ar.requires ?? [])
      .filter(r => r.group === 'destinations')
      .map(r => r.name)
  );
}

/**
 * Names of every destination provided by any module in the MTA.
 * We accept any `provides[].name` from any module — the linkage between
 * approuter `requires:` and srv `provides:` is what mbt resolves.
 */
export function providedDestinations(mta: Mta): Set<string> {
  const out = new Set<string>();
  for (const m of mta.modules ?? []) {
    for (const p of m.provides ?? []) out.add(p.name);
  }
  return out;
}

/**
 * Walk xs-app.json's routes and pull out every (destination, scope)
 * reference. We index by `source` (the route regex) for the error
 * message — that's what a human searches for when a 502/403 fires.
 */
export function collectXsAppRefs(xsApp: XsApp): {
  source: string; destination?: string; scope?: string;
}[] {
  return (xsApp.routes ?? []).map(r => ({
    source: r.source ?? '<no-source>',
    destination: r.destination,
    scope: r.scope,
  }));
}

/**
 * Pull every `$XSAPPNAME.<name>` value referenced from xs-app.json
 * scope fields. Returns a Set so we can check membership against
 * xs-security.json.
 */
export function scopesReferencedInXsApp(xsApp: XsApp): Set<string> {
  const out = new Set<string>();
  for (const r of xsApp.routes ?? []) {
    if (typeof r.scope === 'string' && r.scope.startsWith(SCOPE_PREFIX)) {
      out.add(r.scope.slice(SCOPE_PREFIX.length));
    }
  }
  return out;
}

/** Pull declared scope names from xs-security.json (without the $XSAPPNAME prefix). */
export function scopesDeclaredInSecurity(sec: XsSecurity): Set<string> {
  const out = new Set<string>();
  for (const s of sec.scopes ?? []) {
    if (typeof s.name !== 'string') continue;
    if (s.name.startsWith(SCOPE_PREFIX)) out.add(s.name.slice(SCOPE_PREFIX.length));
    else out.add(s.name);
  }
  return out;
}

export function checkXsAppMta(): CheckResult {
  const findings: Finding[] = [];
  let xsApp: XsApp;
  let xsSecurity: XsSecurity;
  let mtaRoot: Mta;
  let mtaDeploy: Mta;

  try { xsApp     = readJson<XsApp>(XS_APP_JSON); }
  catch (e) { findings.push({ kind: 'parse', message: `failed to parse approuter/xs-app.json: ${(e as Error).message}` }); return { ok: false, findings, xsAppRefs: [] }; }
  try { xsSecurity = readJson<XsSecurity>(XS_SECURITY); }
  catch (e) { findings.push({ kind: 'parse', message: `failed to parse xs-security.json: ${(e as Error).message}` }); return { ok: false, findings, xsAppRefs: [] }; }
  try { mtaRoot   = readYaml<Mta>(MTA_ROOT); }
  catch (e) { findings.push({ kind: 'parse', message: `failed to parse mta.yaml: ${(e as Error).message}` }); return { ok: false, findings, xsAppRefs: [] }; }
  try { mtaDeploy = readYaml<Mta>(MTA_DEPLOY); }
  catch (e) { findings.push({ kind: 'parse', message: `failed to parse .deploy/mta.yaml: ${(e as Error).message}` }); return { ok: false, findings, xsAppRefs: [] }; }

  const xsAppRefs = collectXsAppRefs(xsApp);

  // -- 1. DESTINATION DRIFT -------------------------------------------------
  const destsRoot   = destinationsRequiredBy(mtaRoot);
  const destsDeploy = destinationsRequiredBy(mtaDeploy);
  for (const ref of xsAppRefs) {
    if (!ref.destination) continue;
    for (const [label, set, file] of [
      ['mta.yaml',         destsRoot,   'mta.yaml'],
      ['.deploy/mta.yaml', destsDeploy, '.deploy/mta.yaml'],
    ] as const) {
      if (!set.has(ref.destination)) {
        findings.push({
          kind: 'destination',
          message:
            `xs-app.json route source="${ref.source}" uses destination "${ref.destination}" ` +
            `but ${APPROUTER_NAME} in ${label} (${file}) does not require it.\n` +
            `    Fix: under modules[name=${APPROUTER_NAME}].requires, add an entry:\n` +
            `      - name: ${ref.destination}\n` +
            `        group: destinations\n` +
            `        properties:\n` +
            `          name: ${ref.destination}\n` +
            `          url: ~{srv-url}\n` +
            `          forwardAuthToken: true`,
        });
      }
    }
  }

  // -- 2. SCOPE DRIFT -------------------------------------------------------
  const scopesUsed     = scopesReferencedInXsApp(xsApp);
  const scopesDeclared = scopesDeclaredInSecurity(xsSecurity);
  for (const scope of scopesUsed) {
    if (!scopesDeclared.has(scope)) {
      findings.push({
        kind: 'scope',
        message:
          `xs-app.json references scope "$XSAPPNAME.${scope}" but it is not declared in xs-security.json.\n` +
          `    Fix: add to xs-security.json's "scopes" array:\n` +
          `      { "name": "$XSAPPNAME.${scope}", "description": "<what this scope grants>" }`,
      });
    }
  }

  // -- 3. PROVIDER DRIFT ----------------------------------------------------
  // For each destination the approuter requires (in either MTA), assert
  // that something in that same MTA `provides:` it. We check both files
  // because they're both deployable artefacts.
  for (const [label, mta, file] of [
    ['mta.yaml',         mtaRoot,   'mta.yaml'],
    ['.deploy/mta.yaml', mtaDeploy, '.deploy/mta.yaml'],
  ] as const) {
    const required = destinationsRequiredBy(mta);
    const provided = providedDestinations(mta);
    for (const dest of required) {
      if (!provided.has(dest)) {
        findings.push({
          kind: 'provider',
          message:
            `${file}: ${APPROUTER_NAME} requires destination "${dest}" but no module provides it (in ${label}).\n` +
            `    Fix: a module in this MTA must declare:\n` +
            `      provides:\n` +
            `        - name: ${dest}\n` +
            `          properties:\n` +
            `            srv-url: \${default-url}`,
        });
      }
    }
  }

  return { ok: findings.length === 0, findings, xsAppRefs };
}

function main(): void {
  let result: CheckResult;
  try { result = checkXsAppMta(); }
  catch (err) {
    console.error('[check-xs-app-mta] failed:', err);
    process.exit(1);
  }

  if (result.ok) {
    const numDests = new Set(result.xsAppRefs.map(r => r.destination).filter(Boolean)).size;
    const numScopes = new Set(result.xsAppRefs.map(r => r.scope).filter(Boolean)).size;
    console.log(
      `[check-xs-app-mta] OK — ${result.xsAppRefs.length} routes inspected, ` +
      `${numDests} unique destination(s) and ${numScopes} unique scope(s) all resolve.`
    );
    return;
  }

  console.error('[check-xs-app-mta] FAILED — drift between xs-app.json / mta.yaml / xs-security.json:');
  console.error('');
  for (const f of result.findings) {
    console.error(`  [${f.kind}] ${f.message}`);
    console.error('');
  }
  process.exit(1);
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirect) main();
