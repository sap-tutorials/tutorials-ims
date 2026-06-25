// scripts/check-island-ui5-imports.ts
//
// Build-time guard against Vue islands importing UI5 web components directly.
//
// The bug class (root cause of dark-mode breakage on /me/):
//   When a Vite entry under `hugo-apps/src/<island>/main.ts` does
//     import "@ui5/webcomponents/dist/Title.js";
//   Vite bundles a SECOND, independent copy of `@ui5/webcomponents` into the
//   island's output bundle. UI5 Web Components 2.x uses module-scoped state
//   for theme registration, so each copy has its own private Theme machine.
//   setTheme('sap_horizon_dark') in `hugo/assets/js/ui5-bootstrap.ts` only
//   flips the bootstrap copy; the island copy stays stuck on the default
//   sap_horizon (light) theme. Symptom on /me/: dark-on-dark text in the
//   nav popover items AND in the /me page content. See PR #575 / #627 and
//   the feedback memory `feedback_ui5_settheme_race_with_vue_islands` —
//   those shipped a race fix that doesn't apply here.
//
// Fix pattern: register every UI5 component an island uses in
// hugo/assets/js/ui5-bootstrap.ts (the shared bootstrap). The island's
// .vue templates just use <ui5-*> tags directly — Vue passes them through
// as custom elements and the bootstrap copy handles them.
//
// This script scans each Vite entry's transitive .ts cone for any import
// of @ui5/webcomponents, @ui5/webcomponents-fiori, or @ui5/webcomponents-icons
// and fails the build if it finds any. (Icon imports also create independent
// registries — same class of bug for "no glyph rendered" issues even though
// they don't cause theme drift.)
//
// .vue files are NOT scanned: their templates freely use <ui5-*> tags as
// plain custom elements, and Vue passes them through. The problem is only
// ES-module imports from the entry's main.ts (or .ts files it imports).
//
// Exit codes:
//   0  no direct UI5 imports found in any island entry's transitive .ts cone.
//   1  at least one forbidden import found, or parse failure. Stderr lists
//      every offending file:line.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = process.env.CHECK_ISLAND_UI5_IMPORTS_ROOT
  ? resolve(process.env.CHECK_ISLAND_UI5_IMPORTS_ROOT)
  : resolve(__dirname, '..');

const VITE_CONFIG_PATH = join(REPO_ROOT, 'hugo-apps', 'vite.config.ts');
const HUGO_APPS_ROOT = join(REPO_ROOT, 'hugo-apps');

// Forbidden import-specifier prefixes. Prefix-matches catch the deep paths
// like `@ui5/webcomponents/dist/Title.js` as well as the bare package name.
const FORBIDDEN_PREFIXES = ['@ui5/webcomponents'] as const;

export interface ViteEntry {
  name: string;
  src: string;
}

export interface ForbiddenImport {
  file: string;
  line: number;
  specifier: string;
  entry: string;
}

export function parseViteEntries(content: string): ViteEntry[] {
  const re = /(?:['"]([\w-]+)['"]|(\w[\w-]*))\s*:\s*resolve\(__dirname,\s*['"]([^'"]+)['"]\)/g;
  const out: ViteEntry[] = [];
  let m: ReturnType<typeof re.exec>;
  while ((m = re.exec(content)) !== null) {
    const name = m[1] ?? m[2];
    const src = m[3];
    if (name && src) out.push({ name, src });
  }
  return out;
}

export function extractImports(content: string): { spec: string; line: number }[] {
  const lines = content.split('\n');
  const out: { spec: string; line: number }[] = [];
  // import ... from "spec"  |  import "spec"  |  export ... from "spec"
  const re = /^\s*(?:import|export)\b[^'"]*?["']([^"']+)["']/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) out.push({ spec: m[1], line: i + 1 });
  }
  return out;
}

function isForbidden(spec: string): boolean {
  return FORBIDDEN_PREFIXES.some(p => spec === p || spec.startsWith(p + '/') || spec.startsWith(p + '-'));
}

export function walkEntry(entrySrc: string): ForbiddenImport[] {
  const findings: ForbiddenImport[] = [];
  const visited = new Set<string>();

  function visit(absPath: string, entryName: string): void {
    if (visited.has(absPath)) return;
    visited.add(absPath);
    if (!existsSync(absPath)) return;
    const content = readFileSync(absPath, 'utf8');
    const rel = relative(REPO_ROOT, absPath).replace(/\\/g, '/');
    const imports = extractImports(content);
    for (const imp of imports) {
      if (isForbidden(imp.spec)) {
        findings.push({ file: rel, line: imp.line, specifier: imp.spec, entry: entryName });
        continue;
      }
      if (imp.spec.startsWith('.')) {
        const baseDir = dirname(absPath);
        const candidates = [
          `${imp.spec}.ts`,
          `${imp.spec}.js`,
          `${imp.spec}/index.ts`,
          `${imp.spec}/index.js`,
          imp.spec,
        ];
        for (const cand of candidates) {
          const candAbs = resolve(baseDir, cand);
          if (existsSync(candAbs)) {
            visit(candAbs, entryName);
            break;
          }
        }
      }
    }
  }

  const absEntry = resolve(HUGO_APPS_ROOT, entrySrc);
  visit(absEntry, entrySrc);
  return findings;
}

export function checkIslandUi5Imports(): {
  ok: boolean;
  findings: ForbiddenImport[];
  viteEntries: ViteEntry[];
} {
  const viteContent = readFileSync(VITE_CONFIG_PATH, 'utf8');
  const viteEntries = parseViteEntries(viteContent);
  const findings: ForbiddenImport[] = [];
  for (const e of viteEntries) findings.push(...walkEntry(e.src));
  return { ok: findings.length === 0, findings, viteEntries };
}

function main(): void {
  let result: ReturnType<typeof checkIslandUi5Imports>;
  try {
    result = checkIslandUi5Imports();
  } catch (err) {
    console.error('[check-island-ui5-imports] failed to parse Vite config:', err);
    process.exit(1);
  }

  if (result.viteEntries.length === 0) {
    console.error('[check-island-ui5-imports] WARNING: no Vite entries parsed from hugo-apps/vite.config.ts');
    console.error('  Regex in parseViteEntries() may have drifted from config syntax. Failing build.');
    process.exit(1);
  }

  if (result.ok) {
    console.log(
      `[check-island-ui5-imports] OK — ${result.viteEntries.length} Vite entries scanned, ` +
      'no direct @ui5/* imports in any entry transitive cone.'
    );
    return;
  }

  console.error('[check-island-ui5-imports] FAILED — direct @ui5/* import(s) in Vite island entry:');
  console.error('');
  for (const f of result.findings) {
    console.error(`  ERROR: ${f.file}:${f.line} imports "${f.specifier}"`);
    console.error(`    (reached from Vite entry hugo-apps/${f.entry})`);
  }
  console.error('');
  console.error('  Why this breaks: Vite bundles a second independent copy of @ui5/webcomponents');
  console.error('  into the island bundle. That copy has its own module-scoped Theme state, so');
  console.error("  setTheme() in ui5-bootstrap.ts doesn't reach it — the island stays stuck on");
  console.error('  the default sap_horizon (light) theme regardless of data-theme="dark".');
  console.error('  Symptom: dark-on-dark text in island content. See PR #575 / #627 and the');
  console.error('  feedback_ui5_settheme_race_with_vue_islands memory.');
  console.error('');
  console.error('  Fix: add the same `import "@ui5/webcomponents/dist/X.js"` line to');
  console.error('  hugo/assets/js/ui5-bootstrap.ts and remove it from the island entry.');
  console.error('  The .vue template can still use <ui5-x> tags — Vue passes custom elements');
  console.error('  through, and the bootstrap copy will handle them.');
  process.exit(1);
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirect) main();
