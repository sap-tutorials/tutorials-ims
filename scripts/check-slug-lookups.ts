// scripts/check-slug-lookups.ts
//
// Build-time guard against direct `where({ slug ... })` lookups that
// don't canonicalize the slug input. See
// docs/superpowers/specs/2026-06-06-check-slug-lookups-design.md for
// rationale and the bug class this catches.
//
// Detection rules (per the spec):
//   1. where({ slug: '__<sentinel>__' })       → auto-pass
//   2. where({ slug: <ALL_CAPS_IDENT> })       → auto-pass
//   3. where({ slug: <expr>.toLowerCase() })   → auto-pass
//   4. where({ slug: lc<*> })                  → auto-pass (lc-prefix
//      Hungarian-notation contract)
//   5. where({ slug: { in: ... } } )           → auto-pass (operator)
//   6. anything else                            → marker required
//
// Marker syntax: // slug-canonical: <reason>
//   - same line as the .where(), OR
//   - the line immediately above the line that contains the .where()
//   - empty <reason> is rejected as if no marker were present
//
// Wired into postbuild:apps. Exits 0 on full success, 1 on parser
// drift (0 files / 0 hits), 1 on any unmarked offender.

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = process.env.CHECK_SLUG_LOOKUPS_ROOT
  ? resolve(process.env.CHECK_SLUG_LOOKUPS_ROOT)
  : resolve(__dirname, '..');

const SCAN_DIRS = ['srv', 'srv-qa', 'scripts'].map(d => join(REPO_ROOT, d));

export type Classification =
  | 'sentinel'         // rule 1
  | 'all-caps'         // rule 2
  | 'tolowercase'      // rule 3
  | 'lc-var'           // rule 4
  | 'operator'         // rule 5
  | 'marked'           // rule 6 with marker
  | 'unmarked';        // rule 6 without marker

export interface SlugLookup {
  file: string;        // repo-relative, forward-slashed
  line: number;        // 1-based
  text: string;        // the matched line, trimmed for display
  classification: Classification;
  reason?: string;     // marker reason text, when classification === 'marked'
}

const LOOKUP_RE = /\.where\s*\(\s*\{\s*slug\b/;

const MARKER_RE = /\/\/\s*slug-canonical:\s*(\S.*?)\s*$/;

function readBody(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Walk SCAN_DIRS, returning every .js/.cjs/.mjs file path. Skips
 * __tests__/ and node_modules/ unconditionally; uses realpath
 * deduplication so a Windows junction or symlink doesn't double-walk.
 */
export function walkScanDirs(): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  for (const root of SCAN_DIRS) {
    walkOne(root, out, visited);
  }
  return out;
}

function walkOne(dir: string, out: string[], visited: Set<string>): void {
  let entries: ReturnType<typeof readdirSync>;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    let real: string;
    try { real = realpathSync(full); }
    catch { real = full; }
    if (visited.has(real)) continue;
    visited.add(real);
    if (e.isDirectory()) {
      walkOne(full, out, visited);
    } else if (e.isFile() && /\.(js|cjs|mjs)$/.test(e.name)) {
      out.push(full);
    }
  }
}

/**
 * Classify the call-site at `lines[idx]`. `prevLine` is the
 * immediately preceding line (or '' if idx === 0). Order matters:
 * the auto-pass rules are checked first; the marker rule is the
 * fallback so an annotated bare lookup gets classified as 'marked'.
 */
export function classifyLookup(line: string, prevLine: string): { classification: Classification; reason?: string } {
  // The substring inside `.where({` for argument extraction. Pull
  // the slug field's value (everything between `slug:` or `slug,` or
  // `slug }` and the matching close).
  const slugFieldMatch = line.match(/\bslug\s*([:},])/);
  if (!slugFieldMatch) return { classification: 'unmarked' };

  const after = line.slice(slugFieldMatch.index! + slugFieldMatch[0].length - 1);

  // Rule 1: sentinel literal '__...__' (both quote styles).
  if (/^:\s*['"]__/.test(after)) {
    return { classification: 'sentinel' };
  }

  // Rule 5: operator form { in: ... } / { '!=': ... } / etc.
  if (/^:\s*\{/.test(after)) {
    return { classification: 'operator' };
  }

  // Rule 3: <expr>.toLowerCase()
  if (/\.toLowerCase\s*\(\s*\)/.test(after)) {
    return { classification: 'tolowercase' };
  }

  // Rule 4: lc<*> variable name. The convention is `lc` prefix means
  // "already called .toLowerCase()" (Hungarian-notation contract). The
  // spec doesn't constrain the rest of the name, so accept any \w+ that
  // begins with `lc`. Require the value to be a bare identifier
  // (not a member access or call), enforced by the trailing `[,}]`.
  const lcVarMatch = after.match(/^:\s*(lc\w+)\s*[,}]/);
  if (lcVarMatch) {
    return { classification: 'lc-var' };
  }

  // Rule 2: ALL_CAPS bare identifier.
  const allCapsMatch = after.match(/^:\s*([A-Z][A-Z0-9_]*)\s*[,}]/);
  if (allCapsMatch) {
    return { classification: 'all-caps' };
  }

  // Rule 6: marker required. Look at same line + prevLine.
  for (const candidate of [line, prevLine]) {
    const m = candidate.match(MARKER_RE);
    if (m && m[1]) return { classification: 'marked', reason: m[1] };
  }

  return { classification: 'unmarked' };
}

/**
 * Parse one file's slug-lookups. Returns one entry per matched line.
 */
export function parseSlugLookups(file: string, content: string): SlugLookup[] {
  const out: SlugLookup[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!LOOKUP_RE.test(line)) continue;
    const prevLine = i > 0 ? lines[i - 1] : '';
    const { classification, reason } = classifyLookup(line, prevLine);
    out.push({
      file: relative(REPO_ROOT, file).replace(/\\/g, '/'),
      line: i + 1,
      text: line.trim(),
      classification,
      reason,
    });
  }
  return out;
}

export interface CheckResult {
  ok: boolean;
  lookups: SlugLookup[];
  filesScanned: number;
  unmarked: SlugLookup[];
  counts: Record<Classification, number>;
}

export function checkSlugLookups(): CheckResult {
  const files = walkScanDirs();
  const lookups: SlugLookup[] = [];
  for (const f of files) {
    lookups.push(...parseSlugLookups(f, readBody(f)));
  }
  const counts: Record<Classification, number> = {
    sentinel: 0, 'all-caps': 0, tolowercase: 0, 'lc-var': 0,
    operator: 0, marked: 0, unmarked: 0,
  };
  for (const l of lookups) counts[l.classification]++;
  const unmarked = lookups.filter(l => l.classification === 'unmarked');
  return { ok: unmarked.length === 0, lookups, filesScanned: files.length, unmarked, counts };
}

function main(): void {
  let result: CheckResult;
  try { result = checkSlugLookups(); }
  catch (err) {
    console.error('[check-slug-lookups] failed:', err);
    process.exit(1);
  }

  // Parser-drift sentinel.
  if (result.filesScanned === 0 || result.lookups.length === 0) {
    console.error('[check-slug-lookups] WARNING: scanned', result.filesScanned, 'files, found', result.lookups.length, 'lookups.');
    console.error('  Either the regex drifted from the source syntax, or SCAN_DIRS is wrong.');
    console.error('  Failing the build to surface the regression.');
    process.exit(1);
  }

  if (result.ok) {
    const c = result.counts;
    console.log(
      `[check-slug-lookups] OK — ${result.lookups.length} lookup(s) inspected; ` +
      `${c.marked} marked, ${c.sentinel} sentinel, ${c.tolowercase} pre-canonicalized, ` +
      `${c.operator} operator-form, ${c['lc-var']} auto-pass via lc-prefix, ${c['all-caps']} auto-pass via ALL_CAPS.`
    );
    return;
  }

  console.error(`[check-slug-lookups] FAILED — ${result.unmarked.length} unmarked direct slug lookup(s):`);
  console.error('');
  for (const u of result.unmarked) {
    console.error(`  ${u.file}:${u.line}`);
    console.error(`    ${u.text}`);
    console.error(`    ^ unmarked. Either:`);
    console.error(`      - if the slug is canonicalized at the call source, prefix:`);
    console.error(`          // slug-canonical: <reason>`);
    console.error(`        Reasons: pre-canonicalized | sentinel | caller-canonicalizes |`);
    console.error(`                 write-path-canonicalizes | version-keyed-not-slug-keyed`);
    console.error(`      - or canonicalize inline:`);
    console.error(`          .where({ slug: <expr>.toLowerCase() })`);
    console.error('');
  }
  process.exit(1);
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirect) main();
