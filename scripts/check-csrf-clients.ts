// scripts/check-csrf-clients.ts
//
// Build-time guard that fails CI if a mutating (POST/PUT/PATCH/DELETE)
// `fetch(...)` is added to the codebase without going through the shared
// `csrfFetch()` helper (hugo-apps + analytics-explorer) or the manual
// `x-csrf-token: fetch` two-step (admin ext controllers, scanner).
//
// Ships alongside #895 — deletes `csrfProtection: false` from
// approuter/xs-app.json, so AppRouter starts enforcing CSRF on all
// XSUAA routes with mutating methods.
//
// Also grep-asserts that xs-app.json contains ZERO occurrences of the
// substring `"csrfProtection"` — belt-and-braces against a future PR
// that reintroduces the flag (in either polarity).
//
// Exit codes:
//   0  clean.
//   1  guard fired OR internal error.

import { readFileSync } from 'node:fs';
import { resolve, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.CHECK_CSRF_CLIENTS_ROOT
  ? resolve(process.env.CHECK_CSRF_CLIENTS_ROOT)
  : resolve(__dirname, '..');

interface Violation {
  file: string;
  line: number;
  method: string;
  url: string | null;
  reason: string;
}

// -----------------------------------------------------------------------------
// xs-app.json invariant — zero occurrences of "csrfProtection"
// -----------------------------------------------------------------------------

function checkXsAppJson(): Violation[] {
  const path = resolve(REPO_ROOT, 'approuter/xs-app.json');
  const content = readFileSync(path, 'utf8');
  const violations: Violation[] = [];
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('csrfProtection')) {
      violations.push({
        file: 'approuter/xs-app.json',
        line: idx + 1,
        method: 'N/A',
        url: null,
        reason:
          '`csrfProtection` reappeared in xs-app.json. After #895 the file must contain zero occurrences — approuter\'s default (true) is what we want. If you have a route that legitimately needs csrf disabled, discuss it on the issue tracker first.',
      });
    }
  });
  return violations;
}

// -----------------------------------------------------------------------------
// Client-side fetch scan
// -----------------------------------------------------------------------------

const ROOTS = [
  { glob: 'hugo-apps/src/**/*.{ts,vue}', flavour: 'hugo-app' as const },
  { glob: 'app/analytics-explorer/src/**/*.{ts,vue}', flavour: 'analytics-explorer' as const },
  { glob: 'app/admin/**/webapp/**/*.js', flavour: 'admin-ext' as const },
  { glob: 'app/scanner/webapp/**/*.js', flavour: 'scanner' as const },
];

// Files that legitimately don't need CSRF because they only ever call
// `authenticationType: "none"` routes at the approuter. Keep this list
// tight — every entry is an audit trail that a human decided the call
// site targets a public endpoint.
const ANON_URL_ALLOWLIST = [
  '/feedback/',      // POST /feedback/submit — anon
  '/api/ui-event',   // POST /api/ui-event — anon
  '/api/advocates',  // GET/POST anon
  '/homepage/',      // anon
  '/api/alerts',     // anon
  '/api/ChatConfig', // anon
  '/api/devtoberfest/status',
  '/api/devtoberfest/terms',
  '/search/',        // anon
  '/build/',         // anon
  '/homepage-shelves',
  '/health',
  '/.well-known/',
  '/ord/',
  '/content/',       // POST /content/publish is server-to-server
  '/rest/',          // GET-only from clients
  '/graph/neighborhood', // anon-readable
  '/graph/Concepts',
  '/graph/ConceptEdges',
  '/graph/TutorialConceptLinks',
  '/graph/pathBetween',
  '/graph/conceptsForUser',
  '/graph/explore-data',
  '/graph/path',
  '/tutorials/',     // reader endpoints, anon
  '/concepts/',      // anon
];

// Files that legitimately mutate and MUST have csrf plumbing.
// Passes if either:
//   - the file imports `csrfFetch` from '@shared/csrf-fetch' or '../api/csrf-fetch', OR
//   - the file body references `x-csrf-token` (the manual two-step used by
//     UI5 admin ext controllers that can't import from the Vite bundle).

function detectMutatingFetches(content: string, filePath: string): Array<{
  line: number;
  method: string;
  url: string | null;
}> {
  const hits: Array<{ line: number; method: string; url: string | null }> = [];
  const lines = content.split('\n');

  // Slide a small window over lines and look for a mutating method
  // declaration inside a `fetch(` or `csrfFetch(` init block. The URL is
  // usually on the previous 1–3 lines.
  //
  // Rather than a full parser we look for `method: 'POST'|"POST"|...`
  // and then walk backwards up to 6 lines for a `fetch(` or `csrfFetch(`
  // opening. The heuristic is: fetches don't nest, and init-object
  // properties are almost always co-located.
  const methodRegex = /method\s*:\s*['\"](POST|PUT|PATCH|DELETE)['\"]/;
  const fetchOpenRegex = /\b(csrfFetch|fetch)\s*\(\s*(?:['\"`]([^'\"`\)]+)['\"`]|[a-zA-Z_$][\w$.]*)/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(methodRegex);
    if (!m) continue;
    const method = m[1];

    // Walk backward up to 8 lines to find the enclosing fetch open.
    let url: string | null = null;
    let fetchLine = -1;
    let usedCsrfFetch = false;
    for (let j = i; j >= Math.max(0, i - 8); j--) {
      const fm = lines[j].match(fetchOpenRegex);
      if (fm) {
        fetchLine = j;
        usedCsrfFetch = fm[1] === 'csrfFetch';
        url = fm[2] ?? null;
        break;
      }
    }
    if (fetchLine === -1) continue; // orphan `method: 'POST'` — not our concern

    hits.push({ line: fetchLine + 1, method, url });
  }
  return hits;
}

function fileHasCsrfImport(content: string): boolean {
  return /from\s+['\"][^'\"]*csrf-fetch['\"]/.test(content);
}

function fileHasManualCsrfHandshake(content: string): boolean {
  return /x-csrf-token/i.test(content);
}

function isAnonymousUrl(url: string | null): boolean {
  if (!url) return false;
  return ANON_URL_ALLOWLIST.some((pfx) => url.startsWith(pfx));
}

function scanClientFile(
  absPath: string,
  relPath: string,
  flavour: 'hugo-app' | 'analytics-explorer' | 'admin-ext' | 'scanner',
): Violation[] {
  const content = readFileSync(absPath, 'utf8');
  const mutating = detectMutatingFetches(content, relPath);
  if (mutating.length === 0) return [];

  const hasImport = fileHasCsrfImport(content);
  const hasManual = fileHasManualCsrfHandshake(content);

  const violations: Violation[] = [];
  for (const hit of mutating) {
    // Anonymous URLs never need CSRF, regardless of file.
    if (isAnonymousUrl(hit.url)) continue;

    // Vite-bundled callers (hugo-app / analytics-explorer): must import
    // csrfFetch. The regex-based detector doesn't guarantee THIS call went
    // through csrfFetch, but the import is a strong signal + the guard is
    // paired with the runtime smoke test.
    if (flavour === 'hugo-app' || flavour === 'analytics-explorer') {
      if (!hasImport) {
        violations.push({
          file: relPath,
          line: hit.line,
          method: hit.method,
          url: hit.url,
          reason:
            'Mutating fetch() without an import of csrfFetch. Import from `@shared/csrf-fetch` (hugo-apps) or `../api/csrf-fetch` (analytics-explorer) and switch fetch() → csrfFetch(). See docs/superpowers/specs/2026-07-02-895-csrf-reenablement-design.md.',
        });
      }
      continue;
    }

    // UI5 admin ext controllers / scanner: must reference `x-csrf-token`
    // manually (they can't import from the Vite bundle).
    if (!hasManual) {
      violations.push({
        file: relPath,
        line: hit.line,
        method: hit.method,
        url: hit.url,
        reason:
          'Mutating fetch() in a UI5/admin file without a manual `x-csrf-token: fetch` handshake. Reference implementation: app/admin/verb-definitions/webapp/ext/ActionsController.js:17-36. See docs/superpowers/specs/2026-07-02-895-csrf-reenablement-design.md.',
      });
    }
  }
  return violations;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function main(): number {
  const allViolations: Violation[] = [];

  // xs-app.json invariant.
  allViolations.push(...checkXsAppJson());

  // Client fetch scans.
  for (const { glob, flavour } of ROOTS) {
    const files = globSync(glob, {
      cwd: REPO_ROOT,
      exclude: (name) =>
        // Test files are allowed to mock fetch() without going through csrfFetch;
        // production code paths are the guard target.
        /\.(test|spec)\.[jt]s$/i.test(name) ||
        /__tests__[\\/]/i.test(name) ||
        // Vendor bundles.
        /node_modules[\\/]/i.test(name) ||
        // The csrf-fetch source itself uses `fetch` internally.
        /csrf-fetch\.ts$/.test(name),
    });
    for (const rel of files) {
      const abs = resolve(REPO_ROOT, rel);
      const relPosix = relative(REPO_ROOT, abs).replace(/\\/g, '/');
      allViolations.push(...scanClientFile(abs, relPosix, flavour));
    }
  }

  if (allViolations.length === 0) {
    console.log('check-csrf-clients: OK');
    return 0;
  }

  console.error('\ncheck-csrf-clients: FAILED\n');
  console.error(`Found ${allViolations.length} violation(s):\n`);
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line}  [${v.method} ${v.url ?? '<computed>'}]`);
    console.error(`    ${v.reason}\n`);
  }
  return 1;
}

process.exit(main());
