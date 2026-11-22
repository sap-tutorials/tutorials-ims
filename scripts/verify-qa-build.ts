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

// Shared helper: verify #browse-data script tag is present and (unless
// allowEmpty) non-empty. Returns problem strings (empty = OK). Used by both
// QA and prerelease checks.
//
// allowEmpty (prerelease, #3168): a prerelease channel legitimately has ZERO
// cards until an author marks a tutorial visibility=ROLE_GATED, so an empty
// `all` array is a valid steady state — the gated navigator simply renders an
// empty grid. The script tag must still be present with parseable JSON carrying
// an `all` ARRAY (a missing tag / malformed JSON / non-array `all` is still a
// real build break — browse.json never emitted). QA keeps allowEmpty=false:
// an empty QA grid means the contribution fetch failed and is a hard error.
function checkBrowseDataTag(html: string, channelLabel: string, allowEmpty = false): string[] {
  const problems: string[] = [];
  const browseMatch = html.match(/<script\b[^>]*id=["']?browse-data["']?[^>]*>([\s\S]*?)<\/script>/i);
  if (!browseMatch) {
    problems.push(`#browse-data script tag is absent — data-${channelLabel}/browse.json was not emitted`);
  } else {
    let browseJson: unknown;
    try {
      browseJson = JSON.parse(browseMatch[1]);
    } catch {
      browseJson = {};
    }
    const all = (browseJson as Record<string, unknown>).all;
    if (!Array.isArray(all)) {
      problems.push(`#browse-data grid is malformed — data-${channelLabel}/browse.json has no "all" array`);
    } else if (all.length === 0 && !allowEmpty) {
      problems.push(`#browse-data grid is empty — data-${channelLabel}/browse.json was not emitted`);
    }
  }
  return problems;
}

// Shared helper: verify the homepage-style discovery sections are absent.
// Both QA and prerelease suppress hero/featured/recent/topics.
function checkNoHomeSections(html: string, channelLabel: string): string[] {
  const problems: string[] = [];
  const FORBIDDEN_HOME_SECTIONS: Array<[RegExp, string]> = [
    [/class=["']?[^"'>]*\bhome-hero\b/, 'home-hero'],
    [/id=["']?featured-missions["']?/, 'featured-missions'],
    [/id=["']?recent-tutorials["']?/, 'recent-tutorials'],
    [/id=["']?browse-by-topic["']?/, 'browse-by-topic'],
  ];
  for (const [re, name] of FORBIDDEN_HOME_SECTIONS) {
    if (re.test(html)) {
      problems.push(`homepage section "${name}" is present — ${channelLabel} navigator must be search/filter only (#1675)`);
    }
  }
  return problems;
}

// Inspect the QA index.html string for required QA-specific signals.
// Returns an array of human-readable problem strings; empty means OK.
// Checks:
//   1. #tutorial-navigator carries data-search-base="/qa-search"
//   2. <script id="browse-data"> exists and its JSON has a non-empty `all` array
//   3. [#1675] the homepage-style discovery sections are ABSENT — the QA root /
//      /tutorial-navigator-qa/ exist purely to search & filter tutorials, so the
//      hero/featured/recent/topics sections must be gated off (site.Params.qa).
export function checkQaIndex(html: string): string[] {
  const problems: string[] = [];

  // 1. data-search-base="/qa-search" on the navigator mount
  if (!/id=["']?tutorial-navigator["']?[^>]*data-search-base=["']?\/qa-search/.test(html)) {
    problems.push('#tutorial-navigator is missing data-search-base="/qa-search"');
  }

  // 2. #browse-data grid populated
  problems.push(...checkBrowseDataTag(html, 'qa'));

  // 3. Homepage-style sections must NOT leak onto the QA navigator (#1675).
  problems.push(...checkNoHomeSections(html, 'QA'));

  return problems;
}

// Inspect the prerelease index.html string for required prerelease-specific signals.
// Returns an array of human-readable problem strings; empty means OK.
// Checks:
//   1. #tutorial-navigator carries data-nav-base="/tutorials-prerelease" and
//      data-client-search="true" (and does NOT carry data-search-base, since
//      prerelease uses client-side search only — no server search endpoint exists).
//   2. <script id="browse-data"> exists with a valid `all` array (may be EMPTY —
//      a prerelease channel has zero cards until a tutorial is marked ROLE_GATED).
//   3. [#3168] the homepage-style discovery sections are ABSENT — same as QA.
export function checkPrereleaseIndex(html: string): string[] {
  const problems: string[] = [];

  // 1a. data-nav-base="/tutorials-prerelease" on the navigator mount
  if (!/id=["']?tutorial-navigator["']?[^>]*data-nav-base=["']?\/tutorials-prerelease/.test(html)) {
    problems.push('#tutorial-navigator is missing data-nav-base="/tutorials-prerelease"');
  }

  // 1b. data-client-search="true" on the navigator mount (client-side search, no server endpoint)
  if (!/id=["']?tutorial-navigator["']?[^>]*data-client-search=["']?true/.test(html)) {
    problems.push('#tutorial-navigator is missing data-client-search="true"');
  }

  // 2. #browse-data grid present + valid, but may be empty (allowEmpty) — see #3168.
  problems.push(...checkBrowseDataTag(html, 'prerelease', true));

  // 3. Homepage-style sections must NOT leak onto the prerelease navigator (#3168).
  problems.push(...checkNoHomeSections(html, 'prerelease'));

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

  // Detect channel from the public dir name: a path containing "prerelease"
  // means we're verifying a prerelease build; everything else is QA.
  const isPrerelease = root.includes('prerelease');
  const channelLabel = isPrerelease ? 'prerelease' : 'qa';
  const dataDir = isPrerelease ? 'data-prerelease' : 'data-qa';

  // [#1629] Load the island manifest the channel used (synced into data-<channel>
  // by build:<channel>, via scripts/sync-island-manifest-qa.cjs). Its absence
  // means the sync never ran, so every fingerprinted island fell back to an
  // unhashed 404 path.
  const manifestPath = join('hugo', dataDir, 'island_manifest.json');
  let fingerprinted: string[] = [];
  let manifestProblem = '';
  if (!existsSync(manifestPath)) {
    manifestProblem =
      `island manifest not found at ${manifestPath} — ${channelLabel} baked unhashed island paths ` +
      `(run \`npm run build:island-manifest\` before \`build:${channelLabel}\`; #1629)`;
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
            .join(', ')} — island manifest not applied to ${channelLabel} build (#1629)`,
        );
        bad++;
      }
    }
  }
  if (bad === 0) {
    console.log(`[verify-qa-build] clean — no forbidden markers in ${root}`);
  }

  // Check channel-specific signals in index.html
  const checkIndex = isPrerelease ? checkPrereleaseIndex : checkQaIndex;
  const indexPath = join(root, 'index.html');
  if (existsSync(indexPath)) {
    const indexHtml = readFileSync(indexPath, 'utf-8');
    for (const problem of checkIndex(indexHtml)) {
      console.error(`[verify-qa-build] index.html: ${problem}`);
      bad++;
    }
  }

  // [#1675/#3168] The dedicated `/tutorial-navigator/` section must be emitted so
  // `publish-content:<channel>` can upload it as the `page-tutorial-navigator` BLOB.
  const navPath = join(root, 'tutorial-navigator', 'index.html');
  if (!existsSync(navPath)) {
    console.error(
      `[verify-qa-build] tutorial-navigator/index.html is absent — ${channelLabel} navigator page ` +
        `not generated (content-${channelLabel}/tutorial-navigator/_index.md missing; #1675)`,
    );
    bad++;
  } else {
    const navHtml = readFileSync(navPath, 'utf-8');
    for (const problem of checkIndex(navHtml)) {
      console.error(`[verify-qa-build] tutorial-navigator/index.html: ${problem}`);
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
