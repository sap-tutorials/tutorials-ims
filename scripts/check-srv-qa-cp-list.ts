// scripts/check-srv-qa-cp-list.ts
//
// Build-time guard against the recurring class of bugs documented in
// [[feedback_srv_qa_cp_list_recurring]]: when a file inside srv/lib/
// (transitively reachable from srv-qa/server.js) adds a new
// `import './foo.js'`, the new file MUST also be added to the cp list
// in .deploy/mta.yaml under tutorials-srv-qa's `build-parameters.commands`.
// Forgetting that copies the existing files but leaves the new
// dependency missing — QA boots, then crashes the first time the new
// import is exercised.
//
// This has bitten us at least twice in 4 days (different srv/lib edits),
// so a check is well-justified.
//
// Approach (Tier 3 = derive one side from the other):
//
//   1. Discover the transitive set of srv/**/*.js files reachable from
//      srv-qa/*.js's relative imports.
//   2. Parse the cp list from the bash command in .deploy/mta.yaml.
//   3. Diff: every transitive file MUST be in the cp list. Extras in
//      the cp list are allowed (warned, not failed) — sometimes a file
//      is needed for runtime reasons not visible to import analysis
//      (e.g. dynamic require inside a string-built path).
//
// Out of scope on purpose:
//   - node_modules (the buildpack handles those)
//   - Files in srv-qa itself (path: ../gen/srv-qa already includes them)
//   - Dynamic requires (`require(varName)`) — out of static analysis reach;
//     allowlist them with a comment in the cp line if needed
//   - srv/jobs/* indirect inclusions — same allowlist mechanism
//
// Wired into postbuild:apps next to the existing check scripts.
//
// Exit codes:
//   0  every transitive srv/**/*.js dependency is in the cp list
//   1  one or more dependencies are missing OR the script could not parse
//      .deploy/mta.yaml. Stderr lists missing files with copy-pasteable
//      cp-line additions.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = process.env.CHECK_SRV_QA_CP_ROOT
  ? resolve(process.env.CHECK_SRV_QA_CP_ROOT)
  : resolve(__dirname, '..');

const SRV_QA_DIR = join(REPO_ROOT, 'srv-qa');
const MTA_DEPLOY = join(REPO_ROOT, '.deploy', 'mta.yaml');

/**
 * Parse all relative import / require specifiers from a JS source.
 * Matches both:
 *   import x from './foo.js'        (with optional default + named bindings)
 *   import './foo.js'                (side-effect)
 *   const x = require('./foo.js')    (CJS)
 *   await import('./foo.js')         (dynamic, but only when the path is a literal)
 *
 * Strips // and /* ... *\/ comments first so a commented-out import
 * doesn't count.
 *
 * Skips bare specifiers (no leading '.' / '/').
 */
export function parseRelativeImports(content: string): string[] {
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];

  // ESM static import: covers default, named, namespace, and side-effect forms.
  const importRe = /\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"`]([^'"`]+)['"`]/g;
  for (const m of stripped.matchAll(importRe)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/')) out.push(spec);
  }

  // ESM dynamic import / CJS require with a literal string.
  const dynRe = /\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  for (const m of stripped.matchAll(dynRe)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/')) out.push(spec);
  }

  return out;
}

/**
 * Resolve a relative specifier from `fromFile` to an absolute path on
 * disk. Tries the given path, then the path with `.js` appended, then
 * the path treated as a directory (looking for index.js).
 *
 * Returns null when nothing on disk matches — that's a real bug
 * (broken import) but our scope is the cp list, so we just skip
 * unresolvable paths and let CI catch them via boot.
 */
export function resolveRelative(fromFile: string, spec: string): string | null {
  const base = join(dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, join(base, 'index.js')];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return resolve(c);
    } catch { /* keep trying */ }
  }
  return null;
}

/**
 * Walk transitive imports starting from `roots`. Returns the set of
 * every file (absolute path) reachable, EXCLUDING the roots themselves.
 *
 * Stops descending into node_modules (bare specifiers don't even
 * arrive here — parseRelativeImports drops them) and into files
 * outside REPO_ROOT (defence against weird `../../../` traversals).
 *
 * The walk is BFS rather than DFS only to make cycle handling
 * obviously correct (visited Set guards both forms equally).
 */
export function walkTransitive(roots: string[]): Set<string> {
  const visited = new Set<string>(roots.map(r => resolve(r)));
  const result = new Set<string>();
  const queue: string[] = [...visited];

  while (queue.length > 0) {
    const file = queue.shift()!;
    let content: string;
    try { content = readFileSync(file, 'utf8'); }
    catch { continue; }

    for (const spec of parseRelativeImports(content)) {
      const target = resolveRelative(file, spec);
      if (!target) continue;
      // Stay inside the repo. A specifier resolving outside is
      // either a bug or something we wouldn't ship anyway.
      if (!target.startsWith(resolve(REPO_ROOT))) continue;
      if (visited.has(target)) continue;
      visited.add(target);
      result.add(target);
      queue.push(target);
    }
  }
  return result;
}

/**
 * Extract the cp-source paths from the cp-list bash command in
 * .deploy/mta.yaml's tutorials-srv-qa build-parameters.commands.
 *
 * The command looks like:
 *   bash -c "mkdir -p srv/jobs && cp ../../srv/lib/foo.js
 *            ../../srv/lib/bar.js srv/lib/ && cp ../../srv/jobs/baz.js srv/jobs/"
 *
 * We need every `../../<repo-relative-path>` argument across all `cp` invocations.
 * Returns repo-relative paths (e.g. "srv/lib/content-store.js").
 */
export function extractCpList(mtaContent: string): string[] {
  const out: string[] = [];
  // Match every "../../<path>.js" segment. Specifically the bash
  // command embeds these as args to one or more cp invocations.
  // The leading "../../" is correct because the cp runs from
  // .deploy/<srv-qa-build-context>/, two levels under repo root.
  const re = /\.\.\/\.\.\/([\w./-]+\.(?:js|cjs|mjs))/g;
  for (const m of mtaContent.matchAll(re)) {
    out.push(m[1]);
  }
  // Dedup while preserving first-seen order (helps with diagnostic
  // messages that walk the list).
  const seen = new Set<string>();
  return out.filter(p => seen.has(p) ? false : (seen.add(p), true));
}

export interface CheckResult {
  ok: boolean;
  /** Files reachable from srv-qa entry points but NOT in the cp list. */
  missing: string[];
  /** Files in the cp list but NOT reachable via static analysis (likely fine — see comment). */
  extras: string[];
  /** Set of every srv/**\/*.js reachable from srv-qa entry points. */
  transitive: string[];
  /** Cp list as parsed from .deploy/mta.yaml. */
  cpList: string[];
}

export function checkSrvQaCpList(): CheckResult {
  // Roots = every JS file inside srv-qa/. Cheap to enumerate all of
  // them vs trying to identify which is the entry point — server.js
  // is, but if a future srv-qa/foo.js gets added with its own imports
  // we want those too.
  const roots: string[] = [];
  const stack: string[] = [SRV_QA_DIR];
  while (stack.length > 0) {
    const dir = stack.shift()!;
    let entries: ReturnType<typeof readdirSync>;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        stack.push(full);
      } else if (e.isFile() && /\.(js|cjs|mjs)$/.test(e.name)) {
        roots.push(full);
      }
    }
  }

  const transitiveAbs = walkTransitive(roots);

  // Filter to srv/**/* — those are the ones the cp list copies.
  // A file under srv-qa/ is already in `path: ../gen/srv-qa` so it
  // doesn't need to be cp'd. Anything outside srv/ is out of scope.
  const transitive = [...transitiveAbs]
    .map(f => relative(REPO_ROOT, f).replace(/\\/g, '/'))
    .filter(rel => rel.startsWith('srv/'))
    .sort();

  let mtaContent: string;
  try { mtaContent = readFileSync(MTA_DEPLOY, 'utf8'); }
  catch (err) {
    return {
      ok: false,
      missing: [`(could not read .deploy/mta.yaml: ${(err as Error).message})`],
      extras: [],
      transitive,
      cpList: [],
    };
  }
  const cpList = extractCpList(mtaContent).sort();

  const cpSet = new Set(cpList);
  const transSet = new Set(transitive);
  const missing = transitive.filter(f => !cpSet.has(f));
  const extras  = cpList.filter(f => !transSet.has(f));

  return { ok: missing.length === 0, missing, extras, transitive, cpList };
}

function main(): void {
  let result: CheckResult;
  try { result = checkSrvQaCpList(); }
  catch (err) {
    console.error('[check-srv-qa-cp-list] failed:', err);
    process.exit(1);
  }

  if (result.ok) {
    const extraNote = result.extras.length > 0
      ? ` (${result.extras.length} extra file(s) in cp list — likely intentional, not flagging)`
      : '';
    console.log(
      `[check-srv-qa-cp-list] OK — ${result.transitive.length} transitive srv/* dependencies, ` +
      `all in cp list${extraNote}.`
    );
    if (result.extras.length > 0) {
      console.log('  extras (in cp list, not statically reachable from srv-qa):');
      for (const f of result.extras) console.log(`    ${f}`);
    }
    return;
  }

  console.error('[check-srv-qa-cp-list] FAILED — srv-qa cp list is missing transitive dependencies:');
  console.error('');
  for (const f of result.missing) {
    console.error(`  MISSING: ${f}`);
  }
  console.error('');
  console.error('  Fix: extend the cp command in .deploy/mta.yaml under');
  console.error('       modules[name=tutorials-srv-qa].build-parameters.commands.');
  console.error('       Add each missing path with the ../../ prefix:');
  console.error('');
  for (const f of result.missing) {
    console.error(`         ../../${f}`);
  }
  console.error('');
  console.error('  Symptom if shipped without fix: tutorials-srv-qa boots, then crashes the');
  console.error('  first time the new import is exercised. See feedback_srv_qa_cp_list_recurring.');
  process.exit(1);
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirect) main();
