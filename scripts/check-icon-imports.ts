// scripts/check-icon-imports.ts
//
// Build-time guard that every UI5 icon name referenced by an
// `icon="..."` attribute in Hugo layouts (and Vue islands) is also
// registered via a side-effect import of
// `@ui5/webcomponents-icons/dist/<name>.js` somewhere in the JS surface.
//
// Why this exists:
//   UI5 Web Components ships icons as per-icon ES modules. Each module's
//   import side-effect is what calls `registerIcon(name, …)`. Without an
//   import, a `<ui5-shellbar-item icon="foo">` allocates the button slot
//   but never paints the glyph — silent UX regression, no console error
//   in production where warnings are squelched.
//
//   This pattern has bitten us at least twice:
//     - #104: search / action-settings missing on shellbar
//     - #262: bbyd-active-sales missing for the Browse item added in #174
//   Both shipped because there's no compile-time link between the
//   layout's string attribute and the bootstrap's import list. This
//   script provides that link, statically.
//
// Scope (deliberate): STATIC literals only.
//   - `icon="some-name"` in .html (Hugo layouts) and .vue (islands)
//   - Hugo `dict` entries of the form `"icon" "some-name"` in .html
//     layouts (verb-spine pattern — the icon name lives in template
//     data, expanded at render time as `<ui5-icon name="{{ $vIcon }}">`,
//     so it's invisible to the attribute-style regex above).
//   - Names matching /^[a-z][a-z0-9-]*$/ (the UI5 icon-name shape;
//     skips `icon=""`, `icon="1"`, `icon="{{ .Foo }}"`, `:icon="x"`)
//   - HTML comments + Hugo `{{/* … */}}` are stripped before scanning
//   - Test fixture HTML under hugo-apps/src/**/__tests__/ is skipped —
//     it's a snapshot of layouts we already lint
//
// Out of scope (would cause false positives — the actual bug class is
// already covered above):
//   - Dynamic bindings (`:icon="x"`, `[icon]="x"`, `el.icon = …`)
//   - JS string literals (`{ icon: 'home' }` in actions.ts and friends)
//   - `data-icon="…"` (cmd-palette uses CSS-rendered SVG glyphs, not UI5)
//
// Registration sources scanned (any one is enough):
//   - hugo/assets/js/**/*.{ts,js}
//   - hugo-apps/src/**/*.{ts,js,vue}
//   The matched pattern is `@ui5/webcomponents-icons/dist/<name>.js`
//   appearing in an import or require — the side-effect import shape.
//
// Exit codes:
//   0  every static icon=" " name has a corresponding registration.
//   1  one or more icons are unregistered, OR the script could not
//      complete (parser regression). Stderr lists missing names with
//      file:line refs and the one-line fix.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = process.env.CHECK_ICON_IMPORTS_ROOT
  ? resolve(process.env.CHECK_ICON_IMPORTS_ROOT)
  : resolve(__dirname, '..');

const HUGO_LAYOUTS_DIR = join(REPO_ROOT, 'hugo', 'layouts');
const HUGO_ASSETS_JS_DIR = join(REPO_ROOT, 'hugo', 'assets', 'js');
const HUGO_APPS_SRC_DIR = join(REPO_ROOT, 'hugo-apps', 'src');

export interface IconUsage {
  /** Icon name as written, e.g. "bbyd-active-sales". */
  name: string;
  /** File path relative to repo root (forward-slashed). */
  file: string;
  /** 1-based line number. */
  line: number;
}

export interface CheckResult {
  ok: boolean;
  usages: IconUsage[];
  registered: Set<string>;
  missing: IconUsage[];
}

/**
 * Strip HTML comments and Hugo block comments. Keeps line numbers
 * stable by replacing each comment with same-length blank lines /
 * spaces, so downstream line counting remains accurate.
 */
export function stripComments(src: string): string {
  // HTML comments: <!-- … -->
  // Hugo block comments use the open/close pair {{/_ ... _/}} (greedy
  // across lines is fine — Hugo doesn't allow nesting these).
  return src
    .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, m => m.replace(/[^\n]/g, ' '));
}

/**
 * Match `icon="<name>"` where <name> is a plausible UI5 icon name.
 * Allowed: lower-alpha start, then [a-z0-9-]. Excludes:
 *   - empty string, numeric-only, mixed case
 *   - Hugo template expressions: `icon="{{ .Foo }}"`
 *   - Vue dynamic bindings: caller filters by attribute spelling — we
 *     only match a literal `icon=`, never `:icon=` or `[icon]=`.
 *
 * The leading look-behind ensures we don't match `data-icon=`, `end-icon=`
 * etc. (negative-LB on a hyphen or a letter).
 */
const ICON_RE = /(?<![-\w:])icon="([a-z][a-z0-9-]*)"/g;

/**
 * Match Hugo `dict` literal entries of the form `"icon" "<name>"` or
 * `"iconName" "<name>"`.
 *
 * Verb-spine.html (hugo/layouts/partials/homepage/verb-spine.html) stores its
 * seven tile icons in a `slice (dict … "iconName" "<name>" …)` block and
 * expands them via `<ui5-icon name="{{ $vIcon }}">` at render time. The static
 * guard runs against pre-expansion source, so the literal names are only
 * visible inside the dict — ICON_RE never sees them.
 *
 * The pattern accepts either `"icon"` or `"iconName"` (the two spellings used
 * across the Hugo layouts) followed by whitespace and a quoted UI5 icon-shaped
 * name. `iconName` was missed originally (#1029 shipped a MODEL verb with
 * `iconName: "database"` and no side-effect import — silent glyph miss on
 * homepage tile + top-nav dropdown).
 *
 * The `"icon(Name)?" "<name>"` shape is specific enough to JSON-style key+value
 * adjacency that narrative prose, CSS, etc. don't collide.
 */
const HUGO_DICT_ICON_RE = /"(?:icon|iconName)"\s+"([a-z][a-z0-9-]*)"/g;

export function parseIconUsages(file: string, content: string): IconUsage[] {
  const stripped = stripComments(content);
  const lines = stripped.split('\n');
  const out: IconUsage[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(ICON_RE)) {
      out.push({ name: m[1], file, line: i + 1 });
    }
    for (const m of lines[i].matchAll(HUGO_DICT_ICON_RE)) {
      out.push({ name: m[1], file, line: i + 1 });
    }
  }
  return out;
}

/**
 * Match a side-effect import of an `@ui5/webcomponents-icons` icon module:
 *   import "@ui5/webcomponents-icons/dist/foo-bar.js";
 *   import '@ui5/webcomponents-icons/dist/foo-bar.js';
 *   require("@ui5/webcomponents-icons/dist/foo-bar.js");
 * `dist/v4/` and `dist/v5/` variants don't auto-register — the top-level
 * `dist/<name>.js` is the wrapper that picks v4-vs-v5 at runtime — so we
 * only count the canonical form.
 */
const REGISTER_RE = /@ui5\/webcomponents-icons\/dist\/([a-z][a-z0-9-]*)\.js/g;

export function parseRegistrations(content: string): string[] {
  const stripped = content
    // Strip JS line + block comments so a commented-out import doesn't count.
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return Array.from(stripped.matchAll(REGISTER_RE), m => m[1]);
}

/** Recursively walk a directory, returning files matching one of `exts`. */
function walk(dir: string, exts: string[], out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if (typeof err === 'object' && err && 'code' in err && (err as { code?: string }).code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip vendored deps + test fixtures (already covered by linting the
      // real layout files those fixtures were captured from).
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      walk(full, exts, out);
    } else if (entry.isFile() && exts.some(e => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

export function checkIconImports(): CheckResult {
  // Collect static icon usages from layouts + island components.
  const usageFiles = [
    ...walk(HUGO_LAYOUTS_DIR, ['.html']),
    ...walk(HUGO_APPS_SRC_DIR, ['.vue']),
  ];
  const usages: IconUsage[] = [];
  for (const file of usageFiles) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
    const content = readFileSync(file, 'utf8');
    usages.push(...parseIconUsages(rel, content));
  }

  // Collect registrations from the JS surface.
  const regFiles = [
    ...walk(HUGO_ASSETS_JS_DIR, ['.ts', '.js']),
    ...walk(HUGO_APPS_SRC_DIR, ['.ts', '.js', '.vue']),
  ];
  const registered = new Set<string>();
  for (const file of regFiles) {
    const content = readFileSync(file, 'utf8');
    for (const name of parseRegistrations(content)) registered.add(name);
  }

  const missing = usages.filter(u => !registered.has(u.name));
  return { ok: missing.length === 0, usages, registered, missing };
}

function main(): void {
  let result: CheckResult;
  try {
    result = checkIconImports();
  } catch (err) {
    console.error('[check-icon-imports] failed:', err);
    process.exit(1);
  }

  // Sanity: if BOTH sides parsed nothing, the regex has drifted. We can't
  // distinguish "regex broken" from "test fixture is empty" here, so we
  // require both to be zero before bailing — a real failure (someone
  // removed an import) has usages>0 + registered>0 with non-empty `missing`,
  // and goes through the normal failure branch below.
  if (result.usages.length === 0 && result.registered.size === 0) {
    console.error('[check-icon-imports] WARNING: parsed 0 usages AND 0 registrations.');
    console.error('  This likely means both regexes drifted from source syntax,');
    console.error('  OR the project layout moved (hugo/layouts, hugo/assets/js, hugo-apps/src).');
    console.error('  Failing the build to surface the regression.');
    process.exit(1);
  }

  if (result.ok) {
    // De-duplicate for the count — same icon used N times still counts once.
    const uniqueUsed = new Set(result.usages.map(u => u.name)).size;
    console.log(
      `[check-icon-imports] OK — ${uniqueUsed} unique icon(s) referenced, ` +
      `all registered (${result.registered.size} imports found).`
    );
    return;
  }

  // De-dup so one missing icon used in N places surfaces as one error
  // group (with all call-sites listed below it).
  const byName = new Map<string, IconUsage[]>();
  for (const u of result.missing) {
    const arr = byName.get(u.name) ?? [];
    arr.push(u);
    byName.set(u.name, arr);
  }

  console.error('[check-icon-imports] FAILED — unregistered UI5 icon(s):');
  console.error('');
  for (const [name, usagesForName] of byName) {
    console.error(`  ERROR: icon="${name}" is not imported anywhere.`);
    for (const u of usagesForName) {
      console.error(`    referenced from ${u.file}:${u.line}`);
    }
    console.error(`  Fix: add to hugo/assets/js/ui5-bootstrap.ts:`);
    console.error(`    import "@ui5/webcomponents-icons/dist/${name}.js";`);
    console.error('');
  }
  process.exit(1);
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirect) main();
