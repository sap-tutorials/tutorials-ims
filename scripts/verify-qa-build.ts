import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = [
  // Joule UI
  'joule-step-fab',           // real FAB id (hugo/layouts/partials/joule-step-help.html:10)
  'joule-step-help-fab',      // legacy/aliased name from plan; defensive
  'joule-trigger',            // shellbar item id (hugo/layouts/partials/header.html:5)
  'joule-panel',              // panel container id (hugo/layouts/partials/joule-panel.html:2)
  'chat-fab',                 // generic chat marker; defensive
  // Rating
  'rating-indicator',         // matches ui5-rating-indicator element
  'tutorial-rating-mount',    // mount div id (hugo/layouts/tutorials/u1-object-page.html:285)
  // Completion
  'op-sheet-mark',            // real Mark Done button id (u1-object-page.html:318)
  'op-mark-complete',         // legacy/aliased name from plan; defensive
  // Progress
  'progress-bar',             // id/class on partials/progress-bar.html and u1-object-page.html:262
  'reading-progress',         // id at baseof.html (per Task 14 guards)
  'nav-progress',             // class/id on partials/nav-progress.html
  // Profile / leaderboard
  'me-completions',           // real id of profile widget (hugo/layouts/me/list.html:5)
  'profile-timeline',         // legacy/aliased name from plan; defensive
  'leaderboard'               // defensive (Vue app, won't render in Hugo, but cheap)
];

// Strip <script>...</script> blocks before substring matching. Defensive
// JS references to QA-stripped DOM IDs (e.g. getElementById("op-sheet-mark"))
// stay in page source even when the elements themselves are guarded out.
// Without this strip, verify-qa-build flags those references as forbidden.
//
// Discovered 2026-06-20 mid CI rebuild chain (PR #488).
export function stripScripts(html: string): string {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
}

// Match a forbidden marker only when it appears as a complete id/class
// attribute value, not as arbitrary substring. Tutorial prose and image
// filenames may legitimately contain words like "leaderboard" or
// "progress-bar" — the btp-cockpit tutorial has progress-bars-1.png as an
// image src; the ai-core-genaihub-evaluation-quickstart tutorial uses
// "leaderboard" in body text. The forbidden markers are HTML element
// IDs/classes — checking attribute position avoids both false positives.
//
// Matches:
//   id="X"            id='X'
//   class="X"         class='X'
//   class="...X..."   where X is a complete whitespace-separated token
//
// Does NOT match:
//   <img src="progress-bars-1.png">       (substring in URL)
//   <p>Set up a leaderboard</p>           (substring in prose)
//   class="nav-progress-bar"              (substring of compound class name)
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function markerAppearsAsAttribute(html: string, marker: string): boolean {
  const m = escapeRegExp(marker);
  // id="X" / id='X' exact match
  if (new RegExp(`\\bid=["']${m}["']`).test(html)) return true;
  // class="X" / class='...X...' where X is a complete whitespace-separated token
  if (new RegExp(`\\bclass=["'](?:[^"']*\\s)?${m}(?:\\s[^"']*)?["']`).test(html)) return true;
  return false;
}

export function findForbiddenMarkers(html: string): string[] {
  const visible = stripScripts(html);
  return FORBIDDEN.filter(m => markerAppearsAsAttribute(visible, m));
}

// [#1629] Guard against the QA channel baking UNHASHED island bundle paths.
//
// island-src.html resolves an island name to its content-hashed public path
// via hugo/data/island_manifest.json, falling back to the unhashed
// "/js/<name>.js" when the manifest lacks the key. The QA build sets
// `dataDir = "data-qa"` (which replaces Hugo's data root), so unless the
// manifest is synced into data-qa the fallback fires and QA references
// "/js/validation.js" — a URL Vite never emits (only the hashed
// validation-<hash>.js exists), so it 404s and the questions widget never
// mounts. This guard reads the manifest QA actually used and fails the build
// if any FINGERPRINTED island is still referenced by its bare, unhashed path
// in a QA page.

// A "fingerprinted" island is one whose manifest value differs from the bare
// "/js/<name>.js" fallback (i.e. it carries a content hash). Comparing against
// the fallback path directly — rather than pattern-matching a hash — correctly
// leaves the intentionally-unhashed entries (nav-dropdown, concepts-filter,
// whose manifest value IS "/js/<name>.js") out of the set, and avoids
// misreading a hyphenated name like "nav-dropdown" as hashed.
export function fingerprintedIslands(manifest: Record<string, string>): string[] {
  return Object.entries(manifest)
    .filter(([name, path]) => typeof path === 'string' && path !== `/js/${name}.js`)
    .map(([name]) => name);
}

// Returns the names of fingerprinted islands referenced by their UNHASHED
// "/js/<name>.js" path as a <script src>. Quote-agnostic: Hugo's --minify
// drops attribute quotes, so the baked HTML is `src=/js/validation.js` (no
// quotes) — a quote-requiring regex would silently miss the regression. The
// trailing boundary (quote, whitespace, '>', or end) prevents matching the
// hashed "/js/validation-<hash>.js" or a longer filename.
export function findUnhashedIslandRefs(html: string, islands: string[]): string[] {
  return islands.filter(name => {
    const re = new RegExp(`\\bsrc=["']?/js/${escapeRegExp(name)}\\.js(?=["'\\s>]|$)`);
    return re.test(html);
  });
}

// Inspect the QA index.html string for required QA-specific signals.
// Returns an array of human-readable problem strings; empty means OK.
// Checks:
//   1. #tutorial-navigator carries data-search-base="/qa-search"
//   2. <script id="browse-data"> exists and its JSON has a non-empty `all` array
export function checkQaIndex(html: string): string[] {
  const problems: string[] = [];

  // 1. data-search-base="/qa-search" on the navigator mount
  if (!/id=["']?tutorial-navigator["']?[^>]*data-search-base=["']?\/qa-search/.test(html)) {
    problems.push('#tutorial-navigator is missing data-search-base="/qa-search"');
  }

  // 2. #browse-data grid populated
  const browseMatch = html.match(/<script\b[^>]*id=["']?browse-data["']?[^>]*>([\s\S]*?)<\/script>/i);
  if (!browseMatch) {
    problems.push('#browse-data script tag is absent — data-qa/browse.json was not emitted');
  } else {
    let browseJson: unknown;
    try {
      browseJson = JSON.parse(browseMatch[1]);
    } catch {
      browseJson = {};
    }
    const all = (browseJson as Record<string, unknown>).all;
    if (!Array.isArray(all) || all.length === 0) {
      problems.push('#browse-data grid is empty — data-qa/browse.json was not emitted');
    }
  }

  return problems;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith('.html')) out.push(p);
  }
  return out;
}

function main() {
  const root = process.argv[2] ?? 'hugo/public-qa';
  if (!existsSync(root)) {
    console.error(`[verify-qa-build] directory not found: ${root}`);
    process.exit(1);
  }

  // [#1629] Load the island manifest QA used (synced into data-qa by build:qa,
  // via scripts/sync-island-manifest-qa.cjs). Its absence means the sync never
  // ran, so every fingerprinted island fell back to an unhashed 404 path.
  const manifestPath = join('hugo', 'data-qa', 'island_manifest.json');
  let fingerprinted: string[] = [];
  let manifestProblem = '';
  if (!existsSync(manifestPath)) {
    manifestProblem =
      `island manifest not found at ${manifestPath} — QA baked unhashed island paths ` +
      '(run `npm run build:island-manifest` before `build:qa`; #1629)';
  } else {
    try {
      fingerprinted = fingerprintedIslands(
        JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, string>,
      );
    } catch (err) {
      manifestProblem = `could not parse ${manifestPath}: ${(err as Error).message}`;
    }
    if (!manifestProblem && fingerprinted.length === 0) {
      manifestProblem = `${manifestPath} has no fingerprinted islands — manifest looks empty/stale (#1629)`;
    }
  }

  let bad = 0;
  if (manifestProblem) {
    console.error(`[verify-qa-build] ${manifestProblem}`);
    bad++;
  }
  for (const f of walk(root)) {
    const html = readFileSync(f, 'utf8');
    const found = findForbiddenMarkers(html);
    if (found.length) {
      console.error(`[verify-qa-build] ${f} contains: ${found.join(', ')}`);
      bad++;
    }
    if (fingerprinted.length) {
      const unhashed = findUnhashedIslandRefs(html, fingerprinted);
      if (unhashed.length) {
        console.error(
          `[verify-qa-build] ${f} references unhashed island bundles (404 risk): ${unhashed
            .map(n => `/js/${n}.js`)
            .join(', ')} — island manifest not applied to QA build (#1629)`,
        );
        bad++;
      }
    }
  }
  if (bad === 0) {
    console.log(`[verify-qa-build] clean — no forbidden markers in ${root}`);
  }

  // Check QA-specific signals in index.html (data-search-base + browse-data grid)
  const indexPath = join(root, 'index.html');
  if (existsSync(indexPath)) {
    const indexHtml = readFileSync(indexPath, 'utf-8');
    for (const problem of checkQaIndex(indexHtml)) {
      console.error(`[verify-qa-build] index.html: ${problem}`);
      bad++;
    }
  }

  process.exit(bad ? 1 : 0);
}

// Run CLI when executed directly
const isMain = process.argv[1]?.includes('verify-qa-build');
if (isMain) {
  main();
}
