// Advisory PR check: nudges authors to add/update a committed e2e spec when
// a PR changes user-facing UI paths. ALWAYS exits 0 — it warns, never blocks.
//
// Motivation (#1371): the #1353×#1366 seam shipped a dead value-help feature
// to PROD with every gate green, because no gate exercised the deployed UI.
// A per-PR unit test can't catch a cross-PR seam; only a committed e2e spec
// that drives the real UI can. This check reminds authors to add one.
//
// It is deliberately soft: satisfiable by any test/e2e change, because a hard
// gate would just breed no-op specs. Real coverage is proven by the existing
// post-DEV-deploy e2e CI job actually running the specs, not by this nudge.

import { execFileSync } from 'node:child_process';

// Minimatch is available transitively; but to avoid a new dep we implement a
// tiny glob matcher for the two patterns we use ('**' = any depth, '*' =
// within a path segment). Only these two operators are needed for UI_GLOBS.
export const UI_GLOBS: string[] = [
  'app/admin/**',
  'app/**/webapp/**',
  'hugo/layouts/**',
  'hugo-apps/**',
];

const E2E_PREFIX = 'test/e2e/';

function globToRegExp(glob: string): RegExp {
  // Escape regex specials except * and /, then translate globs:
  //   **  -> .*      (any depth, including path separators)
  //   *   -> [^/]*   (within a single path segment)
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; }
      else { re += '[^/]*'; }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

const UI_REGEXPS = UI_GLOBS.map(globToRegExp);

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

export function classifyChangedFiles(files: string[]): {
  uiChanged: string[];
  e2eChanged: boolean;
  shouldNudge: boolean;
} {
  const norm = files.map(normalize).filter(Boolean);
  const uiChanged = norm.filter((f) => UI_REGEXPS.some((re) => re.test(f)));
  const e2eChanged = norm.some((f) => f.startsWith(E2E_PREFIX));
  return { uiChanged, e2eChanged, shouldNudge: uiChanged.length > 0 && !e2eChanged };
}

function readChangedFiles(): string[] {
  const injected = process.env.E2E_NUDGE_FILES;
  if (injected !== undefined) {
    return injected.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }
  const base = process.env.E2E_NUDGE_BASE || 'origin/main';
  const head = process.env.E2E_NUDGE_HEAD || 'HEAD';
  try {
    const out: string = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      encoding: 'utf8',
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    // Git failed (not a repo, no origin/main, etc.); treat as "cannot determine"
    // and return empty list (no nudge will be issued).
    return [];
  }
}

function main(): void {
  try {
    const files = readChangedFiles();
    const { uiChanged, shouldNudge } = classifyChangedFiles(files);
    if (shouldNudge) {
      console.log(
        '::warning title=Consider an e2e spec::This PR changes user-facing UI but no ' +
          'test/e2e/ spec changed. If a user can observe this change, add or update an ' +
          'e2e spec (see docs/developers/reference/e2e-coverage-pattern.md). Advisory only.',
      );
      console.log('[e2e-coverage-nudge] UI paths changed without a test/e2e change:');
      for (const f of uiChanged) console.log(`  ${f}`);
    } else {
      console.log('::notice title=e2e coverage nudge::No nudge — either no UI change, or an e2e spec accompanies it.');
    }
  } catch {
    // Any error (including from readChangedFiles if git fails unexpectedly):
    // exit 0 with a notice (advisory only, never blocks).
    console.log('::notice title=e2e coverage nudge::Could not determine changed files; no nudge issued.');
  }
  process.exit(0);
}

// Run main() only as a CLI, not when imported by the unit test.
if (process.argv[1] && /check-e2e-coverage-nudge\.(ts|js)$/.test(process.argv[1])) {
  main();
}
