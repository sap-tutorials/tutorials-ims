# `check-slug-lookups` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `scripts/check-slug-lookups.ts`, a Tier-1 build-time check that fails the build on direct `where({ slug ... })` calls unmarked by `// slug-canonical: <reason>`, plus an audit pass that annotates every existing call-site, all wired into `postbuild:apps`.

**Architecture:** Pure-function regex/classifier modules + tiny `main()` (matches `check-icon-imports.ts` / `check-xs-app-mta.ts` / `check-srv-qa-cp-list.ts`). Spawn-based vitest with temp fixture roots (matches the existing 4 build-time-check test files). Two commits: (1) check + tests + wiring, (2) audit pass on existing call-sites. Both ship in the same PR so CI sees green at merge.

**Tech Stack:** Node 20, TypeScript via `tsx`, Vitest. No new deps — `fs`, `path`, `url` only.

**Source spec:** [docs/superpowers/specs/2026-06-06-check-slug-lookups-design.md](../specs/2026-06-06-check-slug-lookups-design.md)

**Branch:** `chore/check-slug-lookups` (already created off `main`; spec already committed).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `scripts/check-slug-lookups.ts` | CREATE | The check — exports pure functions + ESM-guarded `main()`. ~250 LOC. |
| `test/unit/check-slug-lookups.test.ts` | CREATE | 9 spawn-based tests — pass-path, every auto-pass shape, marker placement, empty reason, node_modules exclusion. ~220 LOC. |
| `package.json` | MODIFY | Append `&& tsx scripts/check-slug-lookups.ts` to `postbuild:apps`. |
| ~30 files under `srv/`, `srv-qa/`, `scripts/` | MODIFY | Audit pass — add `// slug-canonical: <reason>` markers OR `.toLowerCase()` inline. Per-file changes are 1–3 lines each. |

---

## Task 1: Skeleton + first failing test (pass-path baseline)

**Files:**
- Create: `scripts/check-slug-lookups.ts`
- Create: `test/unit/check-slug-lookups.test.ts`

- [ ] **Step 1.1: Create the test file with the spawn harness and ONE pass-path test**

Use this exact content for `test/unit/check-slug-lookups.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn-based test for scripts/check-slug-lookups.ts.
// Mirrors the test pattern of check-icon-imports / check-xs-app-mta /
// check-srv-qa-cp-list — drop a synthetic repo into a tmp root, point
// the script at it via env var, assert on the spawn result.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-slug-lookups.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'slug-lookups-'));
  mkdirSync(join(root, 'srv', 'lib'), { recursive: true });
  mkdirSync(join(root, 'srv-qa'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  return root;
}

function writeFile(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function run(root: string): RunResult {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT], {
      env: { ...process.env, CHECK_SLUG_LOOKUPS_ROOT: root },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      status: e.status ?? 1,
    };
  }
}

describe('scripts/check-slug-lookups.ts', () => {
  let root: string;
  beforeEach(() => { root = fixture(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes when every call-site is auto-pass or marked', () => {
    writeFile(root, 'srv/lib/sample.js', `
// slug-canonical: caller-canonicalizes
const a = await SELECT.one.from(T).where({ slug });
const b = await SELECT.one.from(T).where({ slug: '__nav__' });
const c = await SELECT.one.from(T).where({ slug: SHELL_SLUG });
const d = await SELECT.one.from(T).where({ slug: input.toLowerCase() });
const e = await SELECT.one.from(T).where({ slug: lcSlug });
const f = await SELECT.from(T).where({ slug: { in: list } });
`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK — 6 lookup\(s\) inspected/);
  });
});
```

- [ ] **Step 1.2: Run the test and confirm it fails (script doesn't exist yet)**

Run:
```bash
npx vitest run test/unit/check-slug-lookups.test.ts
```

Expected: 1 test FAIL because `scripts/check-slug-lookups.ts` doesn't exist (tsx will exit with a "Cannot find module" error → status non-zero → test sees `r.status !== 0`, expected 0).

- [ ] **Step 1.3: Create the check script with skeleton — enough to make Step 1.1 pass**

Use this exact content for `scripts/check-slug-lookups.ts`:

```ts
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

  // Rule 1: sentinel literal '__...__' (matches '__foo__', "__bar__").
  if (/^[:,]\s*['"]__/.test(slugFieldMatch[0] + after.slice(0, 5))) {
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

  // Rule 4: lc<*> variable name (lc followed by upper-case letter or
  // immediately by other chars — but require the value to be a bare
  // identifier, not a member access or call).
  const lcVarMatch = after.match(/^:\s*(lc[A-Z][\w]*|lc[A-Z])\s*[,}]/);
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
```

- [ ] **Step 1.4: Run the pass-path test, confirm it passes**

Run:
```bash
npx vitest run test/unit/check-slug-lookups.test.ts
```

Expected: 1 test PASS. Stdout matches `/OK — 6 lookup\(s\) inspected/`.

- [ ] **Step 1.5: Sanity-run the script against the real repo to confirm it parses without crashing**

Run:
```bash
npx tsx scripts/check-slug-lookups.ts; echo EXIT=$?
```

Expected: One of two outputs:
- `[check-slug-lookups] FAILED — N unmarked direct slug lookup(s):` followed by ~20 entries, EXIT=1. (This is correct — pre-audit, all bare lookups are unmarked.)
- A flag from the parser-drift sentinel if SCAN_DIRS is wrong, EXIT=1.

The first outcome is what we want. Read 3-4 of the listed entries to confirm they look like actual `where({ slug ... })` lines.

- [ ] **Step 1.6: Commit Task 1**

```bash
git add scripts/check-slug-lookups.ts test/unit/check-slug-lookups.test.ts
git commit -m "chore(check-slug-lookups): skeleton + pass-path test

Pure-function classifier + spawn-based vitest harness. Mirrors
check-icon-imports / check-xs-app-mta / check-srv-qa-cp-list shape.
Subsequent tasks add the failure-mode tests and edge cases."
```

---

## Task 2: Failure-mode test (bare unmarked lookup)

**Files:**
- Modify: `test/unit/check-slug-lookups.test.ts`

- [ ] **Step 2.1: Add the failing test**

Append (inside the existing `describe`) before the closing `})`:

```ts
  it('fails on a bare where({ slug }) with no marker, listing file:line', () => {
    writeFile(root, 'srv/lib/oops.js',
      `const t = await SELECT.one.from(Tutorials).where({ slug });\n`);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAILED — 1 unmarked direct slug lookup/);
    expect(r.stderr).toMatch(/srv\/lib\/oops\.js:1/);
    expect(r.stderr).toMatch(/where\(\{ slug \}\)/);
  });
```

- [ ] **Step 2.2: Run all tests, confirm both pass**

Run:
```bash
npx vitest run test/unit/check-slug-lookups.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 2.3: Commit Task 2**

```bash
git add test/unit/check-slug-lookups.test.ts
git commit -m "test(check-slug-lookups): bare-unmarked failure path"
```

---

## Task 3: Auto-pass shape tests (rules 1–5)

**Files:**
- Modify: `test/unit/check-slug-lookups.test.ts`

- [ ] **Step 3.1: Add five sub-tests, one per auto-pass shape**

Append inside the existing `describe`:

```ts
  it('rule 1: sentinel __slug__ literal auto-passes without marker', () => {
    writeFile(root, 'srv/lib/sentinel.js',
      `await SELECT.one.from(T).where({ slug: '__nav__' });\n`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 sentinel/);
  });

  it('rule 2: ALL_CAPS constant auto-passes without marker', () => {
    writeFile(root, 'srv/lib/caps.js',
      `await SELECT.one.from(T).where({ slug: SHELL_SLUG });\n`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 auto-pass via ALL_CAPS/);
  });

  it('rule 3: .toLowerCase() auto-passes without marker', () => {
    writeFile(root, 'srv/lib/lower.js',
      `await SELECT.one.from(T).where({ slug: input.toLowerCase() });\n`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 pre-canonicalized/);
  });

  it('rule 4: lc<*> variable name auto-passes without marker', () => {
    writeFile(root, 'srv/lib/lcvar.js',
      `await SELECT.one.from(T).where({ slug: lcSlug });\n`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 auto-pass via lc-prefix/);
  });

  it('rule 5: operator form { in: slugs } auto-passes without marker', () => {
    writeFile(root, 'srv/lib/op.js',
      `await SELECT.from(T).where({ slug: { in: list } });\n`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 operator-form/);
  });
```

- [ ] **Step 3.2: Run all tests, confirm all pass**

Run:
```bash
npx vitest run test/unit/check-slug-lookups.test.ts
```

Expected: 7 tests PASS. If any one fails, the classifier in Step 1.3 has a bug — fix the regex in `classifyLookup` rather than relaxing the test, then re-run.

- [ ] **Step 3.3: Commit Task 3**

```bash
git add test/unit/check-slug-lookups.test.ts
git commit -m "test(check-slug-lookups): auto-pass rules 1-5 (sentinel, ALL_CAPS, .toLowerCase, lc<*>, operator)"
```

---

## Task 4: Marker placement tests (line-above + same-line + window boundary)

**Files:**
- Modify: `test/unit/check-slug-lookups.test.ts`

- [ ] **Step 4.1: Add the marker-placement tests**

Append:

```ts
  it('marker on the line above the where() counts', () => {
    writeFile(root, 'srv/lib/above.js', `
// slug-canonical: caller-canonicalizes
await SELECT.one.from(T).where({ slug });
`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 marked/);
  });

  it('marker on the same line as the where() counts', () => {
    writeFile(root, 'srv/lib/same.js',
      `await SELECT.one.from(T).where({ slug }); // slug-canonical: caller-canonicalizes\n`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 marked/);
  });

  it('marker 3 lines above does NOT count (window is 2 lines)', () => {
    writeFile(root, 'srv/lib/far.js', `
// slug-canonical: caller-canonicalizes


await SELECT.one.from(T).where({ slug });
`);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unmarked/);
  });
```

- [ ] **Step 4.2: Run all tests**

Run:
```bash
npx vitest run test/unit/check-slug-lookups.test.ts
```

Expected: 10 tests PASS.

- [ ] **Step 4.3: Commit Task 4**

```bash
git add test/unit/check-slug-lookups.test.ts
git commit -m "test(check-slug-lookups): marker placement (line-above, same-line, window boundary)"
```

---

## Task 5: Empty-reason rejection test

**Files:**
- Modify: `test/unit/check-slug-lookups.test.ts`

- [ ] **Step 5.1: Add the empty-reason test**

Append:

```ts
  it('marker with empty reason (// slug-canonical:) is rejected as unmarked', () => {
    writeFile(root, 'srv/lib/empty.js', `
// slug-canonical:
await SELECT.one.from(T).where({ slug });
`);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unmarked/);
  });
```

- [ ] **Step 5.2: Run all tests, confirm 11 pass**

Run:
```bash
npx vitest run test/unit/check-slug-lookups.test.ts
```

Expected: 11 tests PASS. The empty-reason rejection works because `MARKER_RE` requires `(\S.*?)` — at least one non-space char after the colon. If this test fails, the regex was relaxed somewhere; tighten it.

- [ ] **Step 5.3: Commit Task 5**

```bash
git add test/unit/check-slug-lookups.test.ts
git commit -m "test(check-slug-lookups): empty marker reason rejected as unmarked"
```

---

## Task 6: node_modules / __tests__ exclusion test

**Files:**
- Modify: `test/unit/check-slug-lookups.test.ts`

- [ ] **Step 6.1: Add the exclusion test**

Append:

```ts
  it('does NOT scan __tests__/ or node_modules/ directories', () => {
    // Files under either dir would otherwise produce unmarked findings;
    // we expect the check to skip them entirely. Add a real, marked
    // call-site outside both dirs so the parser-drift sentinel doesn't
    // false-fire (filesScanned > 0 AND lookups > 0).
    writeFile(root, 'srv/__tests__/should-be-skipped.js',
      `await SELECT.one.from(T).where({ slug });\n`);
    writeFile(root, 'srv-qa/node_modules/some-pkg/lib/should-be-skipped.js',
      `await SELECT.one.from(T).where({ slug });\n`);
    writeFile(root, 'srv/lib/real.js', `
// slug-canonical: caller-canonicalizes
await SELECT.one.from(T).where({ slug });
`);
    const r = run(root);
    expect(r.status).toBe(0);
    // Only the real.js lookup should be counted.
    expect(r.stdout).toMatch(/1 lookup\(s\) inspected/);
  });
```

- [ ] **Step 6.2: Run all tests, confirm 12 pass**

Run:
```bash
npx vitest run test/unit/check-slug-lookups.test.ts
```

Expected: 12 tests PASS.

- [ ] **Step 6.3: Commit Task 6**

```bash
git add test/unit/check-slug-lookups.test.ts
git commit -m "test(check-slug-lookups): __tests__ and node_modules exclusion"
```

---

## Task 7: Wire into postbuild:apps

**Files:**
- Modify: `package.json` line containing `postbuild:apps`

- [ ] **Step 7.1: Inspect current value**

Run:
```bash
jq '.scripts["postbuild:apps"]' package.json
```

Expected output: a string containing at minimum `tsx scripts/check-build-collisions.ts && tsx scripts/check-icon-imports.ts`. May also contain `&& tsx scripts/check-xs-app-mta.ts` and/or `&& tsx scripts/check-srv-qa-cp-list.ts` depending on which sibling PRs (#267, #270) have already merged when this lands. Capture the current value verbatim — you'll append to it.

- [ ] **Step 7.2: Append `&& tsx scripts/check-slug-lookups.ts` to the value**

Use the Edit tool: take whatever the current `"postbuild:apps": "..."` line is and append ` && tsx scripts/check-slug-lookups.ts` before the closing quote, preserving the comma. Don't replace the whole line — preserve any sibling check-script that already merged.

If the current value happens to be:
```json
"postbuild:apps": "tsx scripts/check-build-collisions.ts && tsx scripts/check-icon-imports.ts",
```
the new value is:
```json
"postbuild:apps": "tsx scripts/check-build-collisions.ts && tsx scripts/check-icon-imports.ts && tsx scripts/check-slug-lookups.ts",
```

- [ ] **Step 7.3: Verify the JSON still parses**

Run:
```bash
jq '.scripts["postbuild:apps"]' package.json
```

Expected: the value with `tsx scripts/check-slug-lookups.ts` at the end.

- [ ] **Step 7.4: DO NOT commit yet**

The check is wired up but will fail against the real repo (call-sites are still unmarked). Task 8 (the audit pass) makes the build pass; ship them in the same PR per the spec's acceptance criteria. The `package.json` edit will be amended into the audit-pass commit at the end of Task 8.

---

## Task 8: Audit pass — annotate or fix every existing call-site

**This task touches ~30 files across `srv/`, `srv-qa/`, and `scripts/`. Treat it as a single sweep with one final commit.**

**Files:** Every file currently containing `where({ slug` — see Step 8.1 for the list.

- [ ] **Step 8.1: Generate the call-site list**

Run:
```bash
npx tsx scripts/check-slug-lookups.ts 2>&1 | grep -E '^\s+[a-z]' | head -60
```

This prints `<repo-relative-path>:<line>` for every unmarked offender. Capture that list — it's the audit work-list.

Cross-check against `grep`:
```bash
grep -rnE 'where\s*\(\s*\{\s*slug' srv/ srv-qa/ scripts/ | grep -v __tests__
```

The two lists should overlap: every grep hit that ISN'T already marked or auto-pass appears in the script's list.

- [ ] **Step 8.2: For each file, decide between marker / canonicalize / no-op, then make the edit**

For EACH file in the list, do this loop:

1. **Read the file at the reported line and a few above/below.** Establish: where does `slug` come from? Function parameter? Loop variable? Already-canonicalized derived value? Sentinel? Operator?
2. **Decide one of three outcomes:**
   - **Add marker.** If the slug is canonicalized at the call source (caller already lowercased; comes from a write path that lowercases; is logically version-keyed), prepend `// slug-canonical: <reason>` on the line above `.where(...)` (multi-line chain) or on the same `.where(...)` line. Use the spec's reason vocabulary: `pre-canonicalized` / `sentinel` / `caller-canonicalizes` / `write-path-canonicalizes` / `version-keyed-not-slug-keyed`.
   - **Canonicalize inline.** If the slug is genuinely user-supplied and not already lowercased anywhere upstream, change `.where({ slug })` to `.where({ slug: slug.toLowerCase() })`. Expect 0–2 such cases per the spec.
   - **No-op (already auto-passes).** If the line already matches an auto-pass rule (sentinel literal, ALL_CAPS, etc.), it shouldn't be in the unmarked list — if it is, the classifier has a bug and you should fix the classifier, not the call-site.

3. **Document the reason in JSDoc.** When you use `caller-canonicalizes`, ALSO add a one-line JSDoc note on the function's signature: `// caller MUST pass slug.toLowerCase()` — this is the contract the marker is asserting.

**Specific guidance for known shapes** (from the spec's failure-mode examples):

| Pattern | Likely marker reason |
|---|---|
| `for (const [slug, body] of Object.entries(payload))` then `where({ slug })` | `write-path-canonicalizes` |
| `where({ slug, version: activeVersion })` inside a function whose JSDoc says "@param slug — already lowercased" | `caller-canonicalizes` |
| `where({ slug: row.slug })` where `row` came from a prior SELECT | `caller-canonicalizes` (DB rows are canonical by construction) |
| `where({ slug: '__404__' })` etc. | This shouldn't reach you — it's auto-pass via sentinel rule. If it does, the regex needs a fix. |
| Anything in a `scripts/` migration tool that takes mixed-case input | Probably `canonicalize inline` — migration scripts are exactly the case where Tom wants the canonicalization explicit. |

- [ ] **Step 8.3: After every file is touched, run the check; iterate until it passes**

Run:
```bash
npx tsx scripts/check-slug-lookups.ts; echo EXIT=$?
```

Expected: `EXIT=0` and an OK summary line listing live counts. If non-zero, fix the remaining offenders and re-run.

- [ ] **Step 8.4: Run the full unit-test suite to make sure nothing else broke**

Run:
```bash
npm test
```

Expected: All unit tests pass. (Per [[feedback_worktree_tests_hang]] this can hang on Windows — wrap with a 10-minute timeout if you're on a fresh worktree.)

- [ ] **Step 8.5: Verify failure mode works against the audited repo**

Pick any one annotated call-site, comment out its marker temporarily:

```bash
git diff srv/lib/<one-of-the-files-you-touched>.js  # confirm marker is there
```

Edit that file — change `// slug-canonical: <reason>` to `// xx slug-canonical: <reason>`. Run:

```bash
npx tsx scripts/check-slug-lookups.ts; echo EXIT=$?
```

Expected: `EXIT=1` with the exact `<file>:<line>` you broke listed in the failure output. Restore the marker:

```bash
git checkout srv/lib/<that-file>.js
```

Re-run to confirm:

```bash
npx tsx scripts/check-slug-lookups.ts; echo EXIT=$?
```

Expected: `EXIT=0`.

- [ ] **Step 8.6: Verify line endings on every audited file**

Per [[feedback_crlf_regression_on_windows]] — multi-section edits on Windows can flip LF → CRLF.

Run:
```bash
git diff --name-only HEAD | xargs file 2>/dev/null | grep -v 'JavaScript source, Unicode text, UTF-8 text' | grep -v 'JSON text data'
```

Expected: empty output. If any file shows up with `with CRLF line terminators`, normalize it:

```bash
node -e "var fs=require('fs');var p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n'))" <path>
```

- [ ] **Step 8.7: Commit Task 7 wiring + Task 8 audit pass together**

```bash
git add package.json
git add -u srv/ srv-qa/ scripts/    # only the files you actually edited
git status                           # sanity-check the staged set
git commit -m "chore(slug-lookups): annotate every existing call-site + wire check into postbuild:apps

Audit pass: walked every \`where({ slug ... })\` call-site flagged
by scripts/check-slug-lookups.ts and added the appropriate
\`// slug-canonical: <reason>\` marker (or canonicalized the input
inline where the slug arrives un-lowercased).

Reasons used:
  - caller-canonicalizes: function contract; caller passes a
    lowercased slug. JSDoc updated to make the contract explicit.
  - write-path-canonicalizes: slug came from a payload the publish
    path already lowercased.
  - pre-canonicalized: value is the result of an upstream
    .toLowerCase() call.
  - sentinel: fixed magic string outside the auto-pass __...__
    shape.
  - version-keyed-not-slug-keyed: lookup is logically keyed on
    version; the slug clause is just a join filter on a row whose
    canonical form was inserted by the same module.

Wired into postbuild:apps so any future PR adding an unmarked
\`where({ slug })\` fails npm run build:apps + CI."
```

---

## Task 9: Final verification + push + PR

**Files:** No code changes; verification only.

- [ ] **Step 9.1: Confirm commit history is clean**

Run:
```bash
git log --oneline main..HEAD
```

Expected: 3 commits in this order (oldest first):

1. `spec(slug-lookups): ...` (already committed before this plan ran)
2. `chore(check-slug-lookups): skeleton + pass-path test` (Task 1)
3. … then the 5 test-expansion commits (Tasks 2–6) …
4. `chore(slug-lookups): annotate every existing call-site + wire check into postbuild:apps` (Task 7+8)

If you accidentally squashed or split, that's fine — but the audit pass MUST be a separate commit from the check-script commits, because the spec's acceptance criterion 1 demands the diff be readable as "(1) here's the check, (2) here's the existing call-sites correctly annotated."

If the test-expansion commits feel too granular for review, you can interactively rebase to fold them into "chore(check-slug-lookups): script + 12 tests" — but keep the audit-pass commit separate.

- [ ] **Step 9.2: Run the full test + check sequence one more time**

```bash
npx vitest run test/unit/check-slug-lookups.test.ts
npx tsx scripts/check-slug-lookups.ts; echo EXIT=$?
npm run build:apps    # if you have time; full chain validates wiring
```

Expected: 12 vitest tests pass, script exits 0, `build:apps` exits 0 (or fails on something unrelated to this PR).

- [ ] **Step 9.3: Verify branch + push**

```bash
git branch --show-current        # MUST be chore/check-slug-lookups
git push -u origin chore/check-slug-lookups
```

- [ ] **Step 9.4: Open the PR**

```bash
gh pr create --base main \
  --title "chore(build): static check for direct where({ slug ... }) call-sites" \
  --body-file - <<'EOF'
## What

Adds [scripts/check-slug-lookups.ts](scripts/check-slug-lookups.ts) — a Tier-1 build-time guard that fails the build on direct `where({ slug ... })` calls unmarked by `// slug-canonical: <reason>`. Plus an audit pass that annotates every existing call-site, so CI passes at merge time.

Spec: [docs/superpowers/specs/2026-06-06-check-slug-lookups-design.md](docs/superpowers/specs/2026-06-06-check-slug-lookups-design.md).

## Why

The bug class behind issue #70: HANA slug equality is case-sensitive, but tutorials are stored canonically lowercased. A `where({ slug })` that doesn't pre-canonicalize silently returns 0 rows. **It cost 5 PRs (#86 / #94 / #113 / #123 / #126 / #128) before the architectural redesign.** [[feedback_audit_all_callers_of_buggy_primitive]] codified the *convention* but not the *enforcement*. This PR enforces it.

This is item #6 in the four-tier escalation discussed in the parent thread (after #267, #269, #270). It's Tier-1 detection enforcing Tier-4 elimination — a future PR can introduce a `findTutorialBySlug` helper and migrate the bare-lookup sites; the marker mechanism is forward-compatible.

## How

**Detection rules** (per the spec):

| # | Pattern | Auto-pass? |
|---|---|---|
| 1 | `where({ slug: '__<sentinel>__' })` | yes |
| 2 | `where({ slug: <ALL_CAPS_IDENT> })` | yes |
| 3 | `where({ slug: <expr>.toLowerCase() })` | yes |
| 4 | `where({ slug: lc<*> })` | yes |
| 5 | `where({ slug: { in/!= ... } })` | yes |
| 6 | anything else | **only with marker** |

**Marker syntax**: `// slug-canonical: <reason>` on the same line as `.where(...)` or the line immediately above. Empty reason rejected.

**Out of scope** (deferred per the spec):
- Tier-4 helper migration (separate PR).
- Hybrid HANA test for case-insensitive redirect.
- Admin Fiori Elements `.js` audit (those aren't DB lookups).

## Verification

- **Pass on current main** (after audit pass): `[check-slug-lookups] OK — N lookup(s) inspected; ...`
- **Fail mode**: removing any marker → `[check-slug-lookups] FAILED — 1 unmarked direct slug lookup` with file:line and copy-pasteable fixes.
- **12 unit tests** ([test/unit/check-slug-lookups.test.ts](test/unit/check-slug-lookups.test.ts)) — pass-path, every auto-pass shape, marker placement, empty-reason rejection, exclusion of `__tests__/` and `node_modules/`.
- **Wired into postbuild:apps** alongside the existing build-time checks.

## Commit structure

Two logical commits land together so reviewers can read them independently:

1. The check script + tests + tooling — pure tooling, no behavioural changes.
2. The audit pass — adds `// slug-canonical: <reason>` markers (and 0–2 inline `.toLowerCase()` fixes if any genuine bugs surfaced) across the existing call-sites.

## Risk

- Pure dev tooling; no runtime behavioural change beyond the ≤2 inline canonicalize fixes (called out in the audit-pass commit message).
- LF endings preserved per [[feedback_crlf_regression_on_windows]].
- Conflicts with any other `postbuild:apps`-touching PR (e.g. #267, #270 if still open) — the conflict is a single-line merge.

EOF
```

Expected: PR URL printed.

- [ ] **Step 9.5: Mark all todos completed; report PR URL back to Tom.**

---

## Acceptance Criteria (from spec)

- [ ] `npx tsx scripts/check-slug-lookups.ts` exits 0 on `main` after the audit pass commit lands. Both commits ship in the same PR so CI sees green at merge time.
- [ ] Removing any marker locally produces a failure with file:line, the matched line, and the two copy-pasteable fixes.
- [ ] All 12 unit tests pass.
- [ ] An empty marker reason (`// slug-canonical:` with nothing after the colon) is rejected as if no marker were present.
- [ ] Wired into `postbuild:apps` so `npm run build:apps` (and CI) fails on a PR that adds an unmarked bare lookup.
- [ ] `srv-qa/node_modules/` is NOT scanned (verified by Test #6 fixture).

---

## Notes for the implementer

- **Per [[feedback_verify_branch_before_commit]]**, every commit must be made in the same shell invocation as `git branch --show-current` showing `chore/check-slug-lookups`.
- **Per [[feedback_crlf_regression_on_windows]]**, after every multi-file edit (especially Task 8), run the `file` check in Step 8.6 and normalize CRLF if any sneak in.
- **Per [[feedback_pr_over_direct_merge]]**, default to opening a PR; do NOT fast-merge to main without explicit instruction.
- **Per the brainstorming session's choices**: scope is "static check + allowlist" only (NOT Tier-4 migration), allowlist style is inline comment markers, entity scope is "all entities with a slug column" (which the regex naturally covers).
- **Per the spec's Architecture section**, `classifyLookup` is a pure function — write the implementation to be testable in isolation if you ever need to debug a misclassification. The 12 spawn-based tests already cover most paths, but a unit-level test of `classifyLookup` directly is a fine future extension.
