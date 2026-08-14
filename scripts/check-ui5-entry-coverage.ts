// scripts/check-ui5-entry-coverage.ts
//
// Build-time coverage guard: every <ui5-*> element rendered by a Hugo layout,
// shortcode, partial, or Vue island must be registered by at least one entry
// that the page type loading that file includes (#1777 Task 6).
//
// How UI5 tags survive minification
// ----------------------------------
// The brief assumes `customElements.define("ui5-xxx")` string literals survive
// Vite minification. They do NOT in practice. Vite's output uses two decorator
// forms instead:
//   Pattern 2 (object decorator): {tag:"ui5-xxx",...}
//   Pattern 3 (string decorator):  ("ui5-xxx")]
// Pattern 1 (brief / test synthetic data) is also supported for completeness
// and so the unit tests pass against the documented interface.
//
// Runs after build:island-manifest (needs the manifest + built chunks).
// Wire into build:all: && npx tsx scripts/check-ui5-entry-coverage.ts
// Exit codes: 0 = OK, 1 = coverage gaps found or manifest missing.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MAP: {
  entryLayoutGlobs: Record<string, (p: string) => boolean>;
  entrySrcFiles: Record<string, string>;
} = _require('./ui5-entry-page-map.cjs');

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '').replace(/^\/([A-Z]:)/, '$1');
const JS_DIR = join(ROOT, 'hugo/static/js');

let _islandManifest: Record<string, string> | null = null;
function getIslandManifest(): Record<string, string> {
  if (_islandManifest) return _islandManifest;
  const p = join(ROOT, 'hugo/data/island_manifest.json');
  try {
    _islandManifest = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    throw new Error(
      `[check-ui5-entry-coverage] island_manifest.json not found at ${p} — run npm run build:island-manifest first`
    );
  }
  return _islandManifest!;
}

/**
 * Extract every `ui5-*` custom element tag registered in a built bundle.
 *
 * Three patterns are matched:
 *  1. customElements.define("ui5-xxx", ...) — brief/test synthetic data
 *  2. {tag:"ui5-xxx"} — Vite object decorator form (minified)
 *  3. ("ui5-xxx")] — Vite string decorator form (minified)
 */
export function extractDefinedTags(bundleText: string): Set<string> {
  const tags = new Set<string>();

  // Pattern 1: explicit customElements.define call (survives in some contexts / test data)
  for (const m of bundleText.matchAll(/customElements\.define\(\s*["'](ui5-[a-z0-9-]+)["']/g)) {
    tags.add(m[1]);
  }

  // Pattern 2: {tag:"ui5-xxx"} object decorator (Vite minified output)
  for (const m of bundleText.matchAll(/\{tag:\s*["'](ui5-[a-z0-9-]+)["']/g)) {
    tags.add(m[1]);
  }

  // Pattern 3: "ui5-xxx")] string decorator (Vite minified output).
  // The actual form in the bundle is [z("ui5-wizard-step")], i.e. the tag
  // is a positional string arg whose closing paren is immediately followed
  // by the array close bracket: ("ui5-xxx")].
  for (const m of bundleText.matchAll(/["'](ui5-[a-z0-9-]+)["']\s*\)\s*\]/g)) {
    tags.add(m[1]);
  }

  return tags;
}

/**
 * Collect the entry file + every chunk it transitively imports, by scanning
 * `import "..."` statements in the built JS files.
 *
 * @param entryFile  relative path from jsDir, e.g. "ui5-core-7xm581hJ.js"
 * @param jsDir      absolute path to the hugo/static/js directory
 * @returns          array of relative paths (including entryFile)
 */
export function reachableChunks(entryFile: string, jsDir: string): string[] {
  const seen = new Set<string>();
  const stack = [entryFile];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    let body = '';
    try { body = readFileSync(join(jsDir, f), 'utf8'); } catch { continue; }
    for (const m of body.matchAll(/(?:import|from)\s*["']([^"']+\.js)["']/g)) {
      // Normalise: strip leading /js/ (absolute public path) or ./ (relative)
      stack.push(m[1].replace(/^\/js\//, '').replace(/^\.\//, ''));
    }
  }
  return [...seen];
}

/** Tags registered by all chunks reachable from the named entry. */
function registeredTagsForEntry(entryName: string): Set<string> {
  const manifest = getIslandManifest();
  const url = manifest[entryName];
  if (!url) {
    throw new Error(
      `[check-ui5-entry-coverage] entry '${entryName}' missing from island_manifest.json — run npm run build:island-manifest first`
    );
  }
  const entryFile = url.replace(/^\/js\//, '');
  const tags = new Set<string>();
  for (const f of reachableChunks(entryFile, JS_DIR)) {
    let body = '';
    try { body = readFileSync(join(JS_DIR, f), 'utf8'); } catch { continue; }
    for (const t of extractDefinedTags(body)) tags.add(t);
  }
  return tags;
}

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n !== 'node_modules' && n !== '.git') out.push(...walk(p, exts));
    } else if (exts.some(e => n.endsWith(e)) &&
               !n.endsWith('.test.ts') && !n.endsWith('.spec.ts') &&
               !n.endsWith('.test.vue') && !n.endsWith('.spec.vue')) {
      out.push(p);
    }
  }
  return out;
}

// ui5-announcement-area is an internal sub-component slotted into ui5-shell-bar's
// shadow DOM by the framework — it is never authored in markup directly and is
// registered transitively. Exclude it from coverage checks.
const INTERNAL_TAGS = new Set(['ui5-announcement-area']);

function run(): void {
  // 1. Build the registered-tags map for each entry from the built bundles.
  const registered: Record<string, Set<string>> = {};
  for (const entry of Object.keys(MAP.entryLayoutGlobs)) {
    registered[entry] = registeredTagsForEntry(entry);
    console.log(`[check-ui5-entry-coverage] ${entry}: ${registered[entry].size} tags registered`);
  }

  // 2. Walk every Hugo layout file and Vue island source file.
  const files = [
    ...walk(join(ROOT, 'hugo/layouts'), ['.html']),
    ...walk(join(ROOT, 'hugo-apps/src'), ['.vue', '.ts']),
  ];

  const failures: string[] = [];

  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    const body = readFileSync(f, 'utf8');

    // Collect <ui5-tag-name> usages in this file (HTML template / Vue template / TS JSX)
    const used = new Set([...body.matchAll(/<(ui5-[a-z0-9-]+)/g)].map(m => m[1]));
    if (!used.size) continue;

    // Which entries are loaded on pages that include/mount this file?
    const loaded = Object.keys(MAP.entryLayoutGlobs).filter(e => MAP.entryLayoutGlobs[e](rel));

    // Union of tags registered by all loaded entries
    const covered = new Set<string>();
    for (const e of loaded) for (const t of registered[e]) covered.add(t);

    for (const tag of used) {
      if (INTERNAL_TAGS.has(tag)) continue;
      if (!covered.has(tag)) {
        failures.push(
          `  ${rel}: <${tag}> not registered by any loaded entry` +
          ` (loaded: ${loaded.join(', ') || 'none'})`
        );
      }
    }
  }

  if (failures.length) {
    console.error('\n[check-ui5-entry-coverage] FAIL — coverage gaps:\n' + failures.join('\n'));
    process.exit(1);
  }

  console.log('[check-ui5-entry-coverage] OK — all rendered ui5-* elements are covered');
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirect) run();
