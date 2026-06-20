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

// Strip <script>...</script> blocks before substring matching. The forbidden
// markers are about user-visible UI (rating widget, mark-done button, progress
// bar) — DOM elements that QA pages must not render. Script blocks may
// reference these IDs defensively via getElementById/querySelector with null
// checks; those references stay in the page source even when the DOM elements
// are guarded out by Hugo templates. Without this strip, verify-qa-build flags
// the JS reference text as a forbidden marker, producing a false positive.
//
// The hugo template for tutorials (u1-object-page.html) has a 311-line inline
// script block at lines 437-748 that does multiple things: scrollspy, anchor
// bar, mobile sheet, header height observer. Some pieces are common (kept on
// QA) and some are QA-stripped UI — wrapping the WHOLE script in `{{ if not
// site.Params.qa }}` would break the common pieces. Loosening the verify here
// is the right level of fix.
//
// Discovered 2026-06-20 mid CI rebuild chain: rebuild-content-qa.yml run
// #27884205837 flagged 1390 tutorials despite all DOM elements being
// correctly QA-guarded.
export function stripScripts(html: string): string {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
}

export function findForbiddenMarkers(html: string): string[] {
  const visible = stripScripts(html);
  return FORBIDDEN.filter(m => visible.includes(m));
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
