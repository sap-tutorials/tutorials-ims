// scripts/check-build-collisions.ts
//
// Build-time guard against Vite vs Hugo `js.Build` output-path collisions
// (#255, surfaced by #251).
//
// The bug class: Vite entries write to `hugo/static/js/<name>.js`. Hugo's
// pipeline copies `hugo/static/` to `hugo/public/` early, then any
// `resources.Get "js/<X>.ts" | js.Build` writes to `hugo/public/js/<X>.js`
// on top, clobbering Vite's output. Source code looks fine; the bug only
// surfaces in the deployed bundle.
//
// This script catches the collision at build time. It:
//   1. Reads Vite entry names from `hugo-apps/vite.config.ts`'s
//      `rollupOptions.input` keys (regex parse — no `vite` runtime dep).
//   2. Greps `hugo/layouts/**/*.html` for `resources.Get "js/<X>.ts" | js.Build`.
//      For each match, derives the output basename (strip `.ts`, write `<X>.js`).
//   3. Diffs the two name sets. Any overlap is a collision.
//
// Designed to run as `postbuild:apps` in package.json so it fires after
// Vite's output exists. The check itself doesn't need that — it parses
// source files, not built output — but running it post-build catches
// regressions on every CI build instead of being a one-shot manual check.
//
// Exit codes:
//   0  no collision found.
//   1  collision found OR script error (couldn't parse a config).
//      Stderr prints the colliding name(s) with file:line refs.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// __dirname-equivalent for ESM. tsx compiles this file to ESM; the
// `import.meta.url` form survives that, where `__dirname` would not.
const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = process.env.CHECK_BUILD_COLLISIONS_ROOT
  ? resolve(process.env.CHECK_BUILD_COLLISIONS_ROOT)
  : resolve(__dirname, '..');

const VITE_CONFIG_PATH = join(REPO_ROOT, 'hugo-apps', 'vite.config.ts');
const HUGO_LAYOUTS_DIR = join(REPO_ROOT, 'hugo', 'layouts');

export interface ViteEntry {
  name: string;
  /** Source file path relative to hugo-apps/, parsed from the config. */
  src: string;
}

export interface HugoJsBuildRef {
  /** Source path as written in the layout, e.g. "js/tutorial.ts". */
  src: string;
  /** Output basename (strip leading dir + `.ts`), e.g. "tutorial". */
  name: string;
  /** Layout file path relative to repo root. */
  file: string;
  /** 1-based line number in the layout file. */
  line: number;
}

export interface Collision {
  name: string;
  vite: ViteEntry;
  hugo: HugoJsBuildRef;
}

/**
 * Parse the Vite config for the entry names declared in
 * `rollupOptions.input`. Uses a regex rather than evaluating the config
 * because the config file imports `vite` types and pulls in plugins —
 * not worth the dep weight or the risk of side-effects at check time.
 */
export function parseViteEntries(content: string): ViteEntry[] {
  // Match `<key>: resolve(__dirname, 'src/<dir>/main.ts'),`
  // Key may be quoted ('foo-bar') or bare (foo).
  // Permits any whitespace, optional trailing comma.
  const re = /(?:['"]([\w-]+)['"]|(\w[\w-]*))\s*:\s*resolve\(__dirname,\s*['"]([^'"]+)['"]\)/g;
  const entries: ViteEntry[] = [];
  let m: ReturnType<typeof re.exec>;
  while ((m = re.exec(content)) !== null) {
    const name = m[1] ?? m[2];
    const src = m[3];
    if (name && src) entries.push({ name, src });
  }
  return entries;
}

/**
 * Parse a single layout file for `resources.Get "js/<X>.ts" | js.Build`
 * patterns. The leading directory is preserved in the matched string but
 * the OUTPUT name is just the basename (Hugo's js.Build emits to the
 * site root's /js/ directory regardless of input subdir, in this project).
 */
export function parseLayoutJsBuilds(file: string, content: string): HugoJsBuildRef[] {
  const lines = content.split('\n');
  const re = /resources\.Get\s+["']([^"']+\.ts)["']\s*\|\s*js\.Build\b/;
  const out: HugoJsBuildRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const src = m[1];
    // Hugo's `js.Build` strips the leading `js/` (or whatever dir) and the
    // `.ts` extension, writing to `/js/<basename>.js`. e.g. `js/tutorial.ts`
    // → `tutorial`. The input path's leading dir is just where the
    // resource lives in `hugo/assets/`, not part of the output URL.
    const basename = src.replace(/^.*\//, '').replace(/\.ts$/, '');
    out.push({ src, name: basename, file, line: i + 1 });
  }
  return out;
}

/** Recursively walk a directory, returning .html files (relative to root). */
function walkLayoutFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkLayoutFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(full);
    }
  }
  return out;
}

export function findCollisions(
  viteEntries: ViteEntry[],
  hugoRefs: HugoJsBuildRef[]
): Collision[] {
  const viteByName = new Map(viteEntries.map(e => [e.name, e]));
  const collisions: Collision[] = [];
  // De-dup by name so a single Hugo source referenced from multiple layouts
  // doesn't surface as N collisions.
  const seen = new Set<string>();
  for (const ref of hugoRefs) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    const vite = viteByName.get(ref.name);
    if (vite) collisions.push({ name: ref.name, vite, hugo: ref });
  }
  return collisions;
}

export function checkBuildCollisions(): {
  ok: boolean;
  collisions: Collision[];
  viteEntries: ViteEntry[];
  hugoRefs: HugoJsBuildRef[];
} {
  const viteContent = readFileSync(VITE_CONFIG_PATH, 'utf8');
  const viteEntries = parseViteEntries(viteContent);

  const hugoRefs: HugoJsBuildRef[] = [];
  const layoutFiles = walkLayoutFiles(HUGO_LAYOUTS_DIR);
  for (const file of layoutFiles) {
    const content = readFileSync(file, 'utf8');
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
    hugoRefs.push(...parseLayoutJsBuilds(rel, content));
  }

  const collisions = findCollisions(viteEntries, hugoRefs);
  return { ok: collisions.length === 0, collisions, viteEntries, hugoRefs };
}

function main(): void {
  let result: ReturnType<typeof checkBuildCollisions>;
  try {
    result = checkBuildCollisions();
  } catch (err) {
    console.error('[check-build-collisions] failed to parse build config:', err);
    process.exit(1);
  }

  if (result.viteEntries.length === 0) {
    console.error('[check-build-collisions] WARNING: no Vite entries parsed from hugo-apps/vite.config.ts');
    console.error('  This likely means the regex in parseViteEntries() drifted from the config syntax.');
    console.error('  Failing the build to surface the parser regression.');
    process.exit(1);
  }

  if (result.ok) {
    console.log(
      `[check-build-collisions] OK — ${result.viteEntries.length} Vite entries vs ` +
      `${result.hugoRefs.length} Hugo js.Build refs, no collisions.`
    );
    return;
  }

  console.error('[check-build-collisions] FAILED — output-path collision(s):');
  console.error('');
  for (const c of result.collisions) {
    console.error(`  ERROR: Build output collision in hugo/public/js/${c.name}.js`);
    console.error(`    - Vite entry: hugo-apps/${c.vite.src}`);
    console.error(`    - Hugo js.Build: hugo/assets/${c.hugo.src} (referenced from ${c.hugo.file}:${c.hugo.line})`);
    console.error(`  Resolution: rename one of them. See #251 for precedent.`);
    console.error('');
  }
  process.exit(1);
}

// ESM-mode entry guard. tsx compiles this file as ESM, so `require.main`
// isn't available. `import.meta.url` against `pathToFileURL(argv[1])` is
// the standard ESM equivalent — true when the file is invoked directly,
// false when it's imported by another module (e.g. the test file).
import { pathToFileURL } from 'node:url';
const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirect) main();
