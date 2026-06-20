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
  let bad = 0;
  for (const f of walk(root)) {
    const found = findForbiddenMarkers(readFileSync(f, 'utf8'));
    if (found.length) {
      console.error(`[verify-qa-build] ${f} contains: ${found.join(', ')}`);
      bad++;
    }
  }
  if (bad === 0) {
    console.log(`[verify-qa-build] clean — no forbidden markers in ${root}`);
  }
  process.exit(bad ? 1 : 0);
}

// Run CLI when executed directly
const isMain = process.argv[1]?.includes('verify-qa-build');
if (isMain) {
  main();
}
