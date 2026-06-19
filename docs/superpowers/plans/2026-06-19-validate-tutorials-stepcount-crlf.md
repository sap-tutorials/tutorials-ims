# validate-tutorials stepCount=0 quarantine — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the per-publish quarantine of ~30 tutorials caused by CRLF line endings tripping `parseV2Steps`'s `/^### (.+)$/` regex. Centralize line-ending normalization at `composeTutorial()` entry. Add a clearer quarantine reason for empty/whitespace-only upstream stubs.

**Architecture:** One small exported helper `normalizeLineEndings(s: string): string` in `scripts/parsers/compose.ts`, called once at the top of `composeTutorial()`. Every downstream parser (`extractFrontmatter`, `resolveImageURLs`, `convertOptionBlocks`, `extractBranchGroups`, `parseV1Steps`, `parseV2Steps`) sees consistent LF input. Validator gets a pre-loop empty-content check.

**Tech Stack:** TypeScript, Vitest. Tests use the existing `scripts/parsers/__tests__/compose.test.ts` and `test/validate-tutorials-shortcode.test.ts` patterns.

**Spec:** [docs/superpowers/specs/2026-06-19-validate-tutorials-stepcount-crlf-design.md](../specs/2026-06-19-validate-tutorials-stepcount-crlf-design.md)

**Issue:** [#432](https://github.com/sap-tutorials/tutorials-ims/issues/432)

**Branch:** `fix/issue-432-stepcount-crlf` (already created from `main`; spec committed as `a3b1c476` + `7971ca17`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/parsers/compose.ts` | Modify | Export new `normalizeLineEndings()` helper. Call it once at the top of `composeTutorial()`. |
| `scripts/parsers/__tests__/normalize-line-endings.test.ts` | Create | Unit tests for the helper (pass-through LF, CRLF→LF, CR→LF, mixed, empty). |
| `scripts/parsers/__tests__/parser-crlf-regression.test.ts` | Create | Regression tests on `parseV2Steps` and `parseV1Steps` with CRLF input — assert non-zero steps. |
| `scripts/parsers/__tests__/compose.test.ts` | Modify | Add an integration test using a CRLF v2 fixture mirroring `btp-cockpit-setup.md`'s shape. |
| `scripts/validate-tutorials.ts` | Modify | Pre-loop check: empty/whitespace-only content gets a specific quarantine reason. |
| `test/validate-tutorials-empty.test.ts` | Create | Unit test for the new empty-content reason. Mirrors `test/validate-tutorials-shortcode.test.ts` style. |

No other files change.

---

## Task 1: Helper unit tests (RED) + helper implementation (GREEN)

**Files:**
- Create: `scripts/parsers/__tests__/normalize-line-endings.test.ts`
- Modify: `scripts/parsers/compose.ts`

- [ ] **Step 1: Confirm branch + write the failing helper tests**

```bash
cd D:/projects/tutorials-poc
git branch --show-current  # Expect: fix/issue-432-stepcount-crlf
```

Create `scripts/parsers/__tests__/normalize-line-endings.test.ts`:

```ts
// Regression tests for #432 — parseV2Steps was returning 0 steps on CRLF
// tutorials because /^### (.+)$/ doesn't match before \r in JS regex.
// Centralized line-ending normalization at composeTutorial() entry fixes
// every downstream parser at once. This file pins the helper's contract.

import { describe, it, expect } from 'vitest'
import { normalizeLineEndings } from '../compose.js'

describe('normalizeLineEndings', () => {
  it('passes LF input through unchanged', () => {
    expect(normalizeLineEndings('line one\nline two\n')).toBe('line one\nline two\n')
  })

  it('converts CRLF to LF', () => {
    expect(normalizeLineEndings('line one\r\nline two\r\n')).toBe('line one\nline two\n')
  })

  it('converts CR-only (legacy Mac) to LF', () => {
    expect(normalizeLineEndings('line one\rline two\r')).toBe('line one\nline two\n')
  })

  it('handles mixed line endings', () => {
    expect(normalizeLineEndings('lf\nthen\r\ncrlf\rcr\n')).toBe('lf\nthen\ncrlf\ncr\n')
  })

  it('preserves empty string', () => {
    expect(normalizeLineEndings('')).toBe('')
  })

  it('preserves a string with no line terminators', () => {
    expect(normalizeLineEndings('one line no terminator')).toBe('one line no terminator')
  })

  it('does NOT collapse a literal `\\r\\n` escape inside a normal string boundary', () => {
    // Only line-terminator bytes should be replaced; strings written with
    // literal CR or CRLF bytes are exactly what we want to fix.
    expect(normalizeLineEndings('a\r\nb')).toBe('a\nb')
    expect(normalizeLineEndings('a\rb')).toBe('a\nb')
  })
})
```

- [ ] **Step 2: Run the test, confirm RED**

```bash
cd D:/projects/tutorials-poc
npx vitest run scripts/parsers/__tests__/normalize-line-endings.test.ts --reporter=default
```

Expected: import error / `normalizeLineEndings is not a function` — the export doesn't exist yet. All 7 tests fail.

- [ ] **Step 3: Implement `normalizeLineEndings` and call it from `composeTutorial()`**

Open `scripts/parsers/compose.ts`. The current top of the file is:

```ts
import { extractFrontmatter } from './frontmatter.js'
import { resolveImageURLs } from './images.js'
import { convertOptionBlocks } from './options.js'
import { parseV1Steps } from './v1.js'
import { parseV2Steps } from './v2.js'
import { extractBranchGroups, BranchParseError } from './branches.js'
import type { BranchGroup } from './branches.js'
import type { TutorialStep, TutorialFrontmatter } from './types.js'
```

After the imports (and before the existing `ComposeOpts` interface), add the helper:

```ts
/**
 * Normalize line endings to LF. Catches CRLF (Windows / GitHub-via-Windows-
 * clients) and CR-only (legacy Mac) input so downstream regexes that anchor
 * on `$` see consistent line terminators.
 *
 * Why this matters: JS regex `$` (without the `m` flag) only matches before
 * `\n` or end-of-string, NOT before `\r`. The metacharacter `.` excludes
 * `\r` (and `\n`), so `/^### (.+)$/` against `### foo\r` returns null —
 * `(.+)` cannot consume the `\r`, and `$` cannot match before it. Result:
 * tutorials with CRLF source produce 0 steps from parseV2Steps even when
 * they have valid `### ` H3 step headings. Surfaced by #432 (~30 tutorials
 * quarantined per publish).
 *
 * Spec: docs/superpowers/specs/2026-06-19-validate-tutorials-stepcount-crlf-design.md
 */
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}
```

Then update `composeTutorial()` to call it. Find the current line (around line 30):

```ts
export function composeTutorial(rawMd: string, opts: ComposeOpts): ComposeResult {
  const { title, description, youWillLearn, prerequisites, level, frontmatter, body } =
    extractFrontmatter(rawMd)
```

Replace with:

```ts
export function composeTutorial(rawMd: string, opts: ComposeOpts): ComposeResult {
  // [#432] Normalize CRLF/CR-only to LF so every downstream parser sees
  // consistent line terminators. parseV2Steps's /^### (.+)$/ would otherwise
  // return 0 steps for CRLF tutorials.
  const normalized = normalizeLineEndings(rawMd)
  const { title, description, youWillLearn, prerequisites, level, frontmatter, body } =
    extractFrontmatter(normalized)
```

- [ ] **Step 4: Run helper tests, confirm GREEN**

```bash
cd D:/projects/tutorials-poc
npx vitest run scripts/parsers/__tests__/normalize-line-endings.test.ts --reporter=default
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc
git branch --show-current  # confirm fix/issue-432-stepcount-crlf
git -c core.autocrlf=false add scripts/parsers/__tests__/normalize-line-endings.test.ts scripts/parsers/compose.ts
git -c core.autocrlf=false commit -m "feat(parsers): normalizeLineEndings() at composeTutorial entry (#432)

Adds a 1-line CRLF/CR -> LF normalization at the top of composeTutorial
so every downstream parser sees consistent line terminators. JS regex \$
anchor doesn't match before \\r, which made parseV2Steps return 0 steps
for CRLF-encoded tutorials with valid ### H3 headings. Centralizing the
fix here defends extractFrontmatter, options, branches, v1, and v2
parsers all at once.

Refs #432"
```

---

## Task 2: Parser-level CRLF regression tests

**Files:**
- Create: `scripts/parsers/__tests__/parser-crlf-regression.test.ts`

These tests pin the contract: even if some future change removes the central normalization, CRLF input through `parseV2Steps` and `parseV1Steps` must still produce non-zero steps. They test the *pipeline*, not the helper — the helper's already covered.

- [ ] **Step 1: Create the regression test**

```ts
// Regression tests for #432 — pin the contract that the parsers handle CRLF
// input correctly via the centralized normalization at composeTutorial(). If
// someone later refactors and bypasses the normalization step, these fail.

import { describe, it, expect } from 'vitest'
import { composeTutorial } from '../compose.js'

const baseFrontmatter = (parser: 'v1' | 'v2') => [
  '---',
  parser === 'v2' ? 'parser: v2' : 'parser: v1',
  'title: Test',
  'time: 5',
  'tags: [tutorial>beginner]',
  'primary_tag: tutorial>beginner',
  'author_name: Tester',
  'author_profile: https://example.com',
  '---',
  '',
].join('\n')

describe('parser CRLF regression (#432)', () => {
  it('parseV2Steps via composeTutorial returns N steps for CRLF input with N H3 headings', () => {
    const lf = baseFrontmatter('v2') + [
      '# Test',
      '',
      '### Step One',
      '',
      'Content of step one.',
      '',
      '### Step Two',
      '',
      'Content of step two.',
      '',
      '### Step Three',
      '',
      'Content of step three.',
      '',
    ].join('\n')

    // Reshape to CRLF — this mirrors what GitHub serves for some tutorials
    // committed by Windows clients (the actual #432 root cause).
    const crlf = lf.replace(/\n/g, '\r\n')

    const result = composeTutorial(crlf, {
      repo: 'r', branch: 'main', slug: 's', target: 'hugo', rewriteImages: false,
    })

    expect(result.steps).toHaveLength(3)
    expect(result.steps[0].title).toBe('Step One')
    expect(result.steps[1].title).toBe('Step Two')
    expect(result.steps[2].title).toBe('Step Three')
  })

  it('parseV1Steps via composeTutorial returns N steps for CRLF input with N ACCORDION blocks', () => {
    const lf = baseFrontmatter('v1') + [
      '# Test',
      '',
      '[ACCORDION-BEGIN [Step 1: ](Step One)]',
      'Content of step one.',
      '[ACCORDION-END]',
      '',
      '[ACCORDION-BEGIN [Step 2: ](Step Two)]',
      'Content of step two.',
      '[ACCORDION-END]',
      '',
    ].join('\n')

    const crlf = lf.replace(/\n/g, '\r\n')

    const result = composeTutorial(crlf, {
      repo: 'r', branch: 'main', slug: 's', target: 'hugo', rewriteImages: false,
    })

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].title).toBe('Step One')
    expect(result.steps[1].title).toBe('Step Two')
  })

  it('mixed CR-only input also produces correct step count', () => {
    const lf = baseFrontmatter('v2') + [
      '# Test',
      '',
      '### Only Step',
      '',
      'Body.',
    ].join('\n')

    const cr = lf.replace(/\n/g, '\r')

    const result = composeTutorial(cr, {
      repo: 'r', branch: 'main', slug: 's', target: 'hugo', rewriteImages: false,
    })

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].title).toBe('Only Step')
  })
})
```

- [ ] **Step 2: Run the regression tests, confirm GREEN**

```bash
cd D:/projects/tutorials-poc
npx vitest run scripts/parsers/__tests__/parser-crlf-regression.test.ts --reporter=default
```

Expected: all 3 tests pass. (They go straight to GREEN because Task 1 already shipped the fix — these tests pin the existing behavior.)

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc
git branch --show-current
git -c core.autocrlf=false add scripts/parsers/__tests__/parser-crlf-regression.test.ts
git -c core.autocrlf=false commit -m "test(parsers): CRLF regression for parseV1/V2Steps via composeTutorial (#432)"
```

---

## Task 3: Compose integration test against the real-world shape

**Files:**
- Modify: `scripts/parsers/__tests__/compose.test.ts`

This integration test mirrors the actual `btp-cockpit-setup.md` shape that surfaced in the bug report — `parser: v2`, mostly LF but with CRLF leakage, valid `### ` headings.

- [ ] **Step 1: Append a new describe block to `compose.test.ts`**

Open `scripts/parsers/__tests__/compose.test.ts`. Find the end of the file. Append:

```ts

describe('composeTutorial CRLF regression (#432)', () => {
  it('produces non-zero steps for a real-world CRLF v2 tutorial shape', () => {
    // This fixture mirrors the actual structure of btp-cockpit-setup.md as it
    // arrived in the upstream repo: parser: v2 declared, three ### H3 step
    // headings, and \r\n line endings throughout.
    const md = [
      '---',
      'parser: v2',
      'author_name: Tester',
      'time: 5',
      'tags: [tutorial>beginner, software-product>sap-business-technology-platform]',
      'primary_tag: software-product>sap-business-technology-platform',
      '---',
      '',
      '# Get an SAP BTP Account for Tutorials',
      '<!-- description --> Learn which account model on SAP Business Technology Platform is best suited for your purposes.',
      '',
      '## You will learn',
      '  - How to decide which account model is suited for you',
      '',
      '---',
      '',
      '### Understanding Trial vs. Free Tier',
      '',
      'Body of step one.',
      '',
      '### Which to choose?',
      '',
      'Body of step two.',
      '',
      '### How to set up an account',
      '',
      'Body of step three.',
    ].join('\r\n')  // <- critical: full CRLF input

    const result = composeTutorial(md, {
      repo: 'sap-tutorials/sap-cloud-platform',
      branch: 'main',
      slug: 'btp-cockpit-setup',
      target: 'hugo',
      rewriteImages: false,
    })

    expect(result.steps).toHaveLength(3)
    expect(result.steps.map(s => s.title)).toEqual([
      'Understanding Trial vs. Free Tier',
      'Which to choose?',
      'How to set up an account',
    ])
  })
})
```

- [ ] **Step 2: Run the test, confirm GREEN**

```bash
cd D:/projects/tutorials-poc
npx vitest run scripts/parsers/__tests__/compose.test.ts --reporter=default
```

Expected: all existing tests pass + the new test passes. If anything other than the new test fails, **stop** — that's a regression and needs investigation.

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc
git branch --show-current
git -c core.autocrlf=false add scripts/parsers/__tests__/compose.test.ts
git -c core.autocrlf=false commit -m "test(compose): CRLF integration for real-world btp-cockpit-setup shape (#432)"
```

---

## Task 4: Validator empty-content check (RED → GREEN)

**Files:**
- Create: `test/validate-tutorials-empty.test.ts`
- Modify: `scripts/validate-tutorials.ts`

The validator currently emits `Missing required frontmatter field: type` for 0-byte upstream stubs. That's accurate but unhelpful — the frontmatter is empty because the file is empty. Replace with a specific reason.

- [ ] **Step 1: Extract the empty-content check as a testable pure function**

The current validator is mostly imperative top-level code. To unit-test the new behavior, extract a small pure helper alongside the existing exported `shortcodeBalanceCheck`. Open `scripts/validate-tutorials.ts`. Find the existing `shortcodeBalanceCheck` export (around line 31) and add a sibling helper directly below it (before the `const files = ...` line):

```ts
/**
 * Returns a quarantine reason for a tutorial whose source is empty or
 * whitespace-only — typically an empty stub committed to the upstream
 * repo (e.g. `abap-environment-create-tile.md` has been 0 bytes for
 * months as of 2026-06-19).
 *
 * Without this short-circuit, the validator quarantines the file with
 * `Missing required frontmatter field: type` — accurate but unhelpful
 * because the frontmatter is empty as a consequence of the file being
 * empty. Surfaced by #432.
 *
 * @returns reason string for quarantine, or `null` if content is non-empty.
 */
export function emptyContentCheck(content: string): string | null {
  if (content.trim().length === 0) {
    return 'Tutorial source is empty or whitespace-only — likely an empty stub in the upstream repo'
  }
  return null
}
```

- [ ] **Step 2: Write the failing test**

Create `test/validate-tutorials-empty.test.ts`:

```ts
// Regression test for #432 — empty/whitespace-only upstream stubs (e.g.
// abap-environment-create-tile.md is literally 0 bytes in the source repo)
// got the cryptic "Missing required frontmatter field: type" reason. The
// new emptyContentCheck() short-circuits with an actionable message.

import { describe, it, expect } from 'vitest'
import { emptyContentCheck } from '../scripts/validate-tutorials.js'

describe('emptyContentCheck (#432)', () => {
  it('returns null for non-empty content', () => {
    expect(emptyContentCheck('---\ntype: tutorials\n---\nbody')).toBeNull()
  })

  it('returns the empty-stub reason for a 0-byte file', () => {
    expect(emptyContentCheck('')).toBe(
      'Tutorial source is empty or whitespace-only — likely an empty stub in the upstream repo'
    )
  })

  it('returns the empty-stub reason for whitespace-only content', () => {
    expect(emptyContentCheck('   \n\t\n  ')).toBe(
      'Tutorial source is empty or whitespace-only — likely an empty stub in the upstream repo'
    )
  })

  it('returns null for content with leading/trailing whitespace but real body', () => {
    expect(emptyContentCheck('\n\n  hello  \n\n')).toBeNull()
  })
})
```

- [ ] **Step 3: Run, confirm GREEN (the helper export from Step 1 already exists)**

```bash
cd D:/projects/tutorials-poc
npx vitest run test/validate-tutorials-empty.test.ts --reporter=default
```

Expected: 4/4 pass.

> **Note on the TDD ordering here:** Step 1 added the helper before Step 2 created its test. That's because the helper extraction itself is the test target — there's no separate "fix" to make GREEN. If you prefer strict red-then-green discipline, swap the order: create the test file first (RED on import), then add the helper (GREEN). Either ordering produces the same final state.

- [ ] **Step 4: Wire `emptyContentCheck` into the imperative validator loop**

Find the existing per-file loop in `scripts/validate-tutorials.ts` (starts around line 48). The current shape:

```ts
for (const file of files) {
  const content = readFileSync(join(TUTORIALS_DIR, file), 'utf-8')
  let reason: string | null = null

  try {
    const { data: fm } = matter(content)
    // ... required field checks ...
  } catch (e: any) {
    reason = e.message?.slice(0, 200) ?? 'Unknown parse error'
  }
  // ...
}
```

Insert the empty-content short-circuit BEFORE the `try` block:

```ts
for (const file of files) {
  const content = readFileSync(join(TUTORIALS_DIR, file), 'utf-8')
  let reason: string | null = emptyContentCheck(content)

  if (!reason) {
    try {
      const { data: fm } = matter(content)
      // ... required field checks (UNCHANGED) ...
    } catch (e: any) {
      reason = e.message?.slice(0, 200) ?? 'Unknown parse error'
    }
  }
  // ... existing quarantine writeback (UNCHANGED) ...
}
```

The change is two lines: initialize `reason` from `emptyContentCheck(content)`, and gate the existing `try` block on `!reason`.

- [ ] **Step 5: Verify the validator file still parses (without triggering the imperative loop)**

The script's top-level imperative loop runs on `import()`, so a plain dynamic import would walk `hugo/content/tutorials/`. To check exports without side-effects, use `tsx --print` to type-check + parse the module:

```bash
cd D:/projects/tutorials-poc
# Confirm the file type-checks and the new export name appears in the source.
npx tsx --check scripts/validate-tutorials.ts 2>&1 | tail -5
grep -n "^export function" scripts/validate-tutorials.ts
```

Expected: no type errors. The grep prints both `shortcodeBalanceCheck` and the new `emptyContentCheck` lines.

If `tsx --check` isn't available in your toolchain, fall back to running the unit test from Task 4 Step 3 — if that imports `emptyContentCheck` cleanly and the assertions pass, the file is structurally valid:

```bash
npx vitest run test/validate-tutorials-empty.test.ts --reporter=default
```

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc
git branch --show-current
git -c core.autocrlf=false add scripts/validate-tutorials.ts test/validate-tutorials-empty.test.ts
git -c core.autocrlf=false commit -m "feat(validate-tutorials): clearer reason for empty upstream stubs (#432)

emptyContentCheck() short-circuits the per-file validation loop with an
actionable message ('Tutorial source is empty or whitespace-only —
likely an empty stub in the upstream repo') instead of the cryptic
'Missing required frontmatter field: type'. Same quarantine outcome,
but authors can triage without help. abap-environment-create-tile.md
is the canonical example: 0 bytes in the source repo as of 2026-06-19."
```

---

## Task 5: Run the full test suite as a safety net

- [ ] **Step 1: Run all parser tests**

```bash
cd D:/projects/tutorials-poc
npx vitest run scripts/parsers/__tests__ --reporter=default
```

Expected: all parser tests pass (existing + 3 new files).

- [ ] **Step 2: Run all `scripts/__tests__` tests**

```bash
cd D:/projects/tutorials-poc
npx vitest run scripts/__tests__ --reporter=default
```

Expected: pre-existing pass count holds. (We saw 469 pass + 1 unrelated unhandled rejection during the #433 work — that pattern should persist.)

- [ ] **Step 3: Run the validator tests in `test/`**

```bash
cd D:/projects/tutorials-poc
npx vitest run test/validate-tutorials-shortcode.test.ts test/validate-tutorials-empty.test.ts --reporter=default
```

Expected: both validator test files pass.

- [ ] **Step 4: Sanity-check the local cache reproduces the bug-fix end-to-end (optional)**

If `.tutorial-cache/btp-cockpit-setup.md` exists locally (it does in the current worktree):

```bash
cd D:/projects/tutorials-poc
npx tsx -e "
import { readFileSync } from 'node:fs'
import { composeTutorial } from './scripts/parsers/compose.ts'
const raw = readFileSync('.tutorial-cache/btp-cockpit-setup.md', 'utf-8')
const r = composeTutorial(raw, { repo:'r', branch:'main', slug:'btp-cockpit-setup', target:'hugo', rewriteImages:false })
console.log('btp-cockpit-setup steps:', r.steps.length)
if (r.steps.length === 0) { console.error('FAIL: still 0 steps'); process.exit(1) }
"
```

Expected: `btp-cockpit-setup steps: 3`. (Before the fix this printed `0`.)

If the file doesn't exist locally, skip — the unit/integration tests above are sufficient.

---

## Task 6: Push branch + open PR

- [ ] **Step 1: Verify final branch state**

```bash
cd D:/projects/tutorials-poc
git branch --show-current  # fix/issue-432-stepcount-crlf
git log --oneline main..HEAD
```

Expected: 7 commits on the branch — 2 spec, 1 plan (committed before Task 1 begins, see step 0 below), 1 helper+normalization, 1 parser regression test, 1 compose integration test, 1 validator empty-check.

> **Step 0 (commit this plan first):** Before starting Task 1, commit the plan file itself so the branch sequence reads spec → plan → impl. From the same Bash invocation:
>
> ```bash
> cd D:/projects/tutorials-poc
> git branch --show-current  # confirm fix/issue-432-stepcount-crlf
> git -c core.autocrlf=false add docs/superpowers/plans/2026-06-19-validate-tutorials-stepcount-crlf.md
> git -c core.autocrlf=false commit -m "docs(plan): fix validate-tutorials stepCount=0 quarantines (#432)"
> ```

- [ ] **Step 2: Push**

```bash
cd D:/projects/tutorials-poc
git push -u origin fix/issue-432-stepcount-crlf
```

- [ ] **Step 3: Open PR**

```bash
cd D:/projects/tutorials-poc
gh pr create \
  --repo sap-tutorials/tutorials-ims \
  --base main \
  --title "fix(parsers): normalize line endings to recover CRLF tutorials (#432)" \
  --body "$(cat <<'EOF'
## What

Centralize CRLF/CR-only → LF normalization at the entry of \`composeTutorial()\` so every downstream parser sees consistent line terminators. Add a clearer quarantine reason for empty/whitespace-only upstream stubs.

## Why

Per #432, the pre-publish validator quarantines ~30 tutorials per run with \`Invalid 'stepCount' value: 0\`. Investigation found two distinct root causes among the named slugs:

1. **CRLF line endings + \`parser: v2\`** — JS regex \`\$\` (without \`m\` flag) doesn't match before \`\r\`, only before \`\n\` or EOF. \`parseV2Steps\`'s \`/^### (.+)\$/\` returns null for \`### foo\r\` lines, so tutorials with valid H3 step headings produce \`steps.length === 0\` whenever the source uses CRLF. Verified by tracing through \`composeTutorial()\` with \`btp-cockpit-setup.md\` (76 CRLF lines, 3 H3 headings, parser=v2 → 0 steps before fix → 3 steps after).
2. **Empty source files at upstream** — e.g. \`abap-environment-create-tile.md\` is literally 0 bytes on GitHub. Author-side stub. The validator was reporting the misleading \`Missing required frontmatter field: type\`; it now reports \`Tutorial source is empty or whitespace-only — likely an empty stub in the upstream repo\`.

The carry-forward pattern in the publish session masks both classes — quarantined slugs hold their last-good content. New tutorials would silently go missing (same masking pattern as #425).

## Changes

- **\`scripts/parsers/compose.ts\`**: new exported \`normalizeLineEndings(s: string): string\` helper. \`composeTutorial()\` calls it on \`rawMd\` before any other processing. All downstream parsers (\`extractFrontmatter\`, \`resolveImageURLs\`, \`convertOptionBlocks\`, \`extractBranchGroups\`, \`parseV1Steps\`, \`parseV2Steps\`) now see consistent LF input.
- **\`scripts/validate-tutorials.ts\`**: new exported \`emptyContentCheck(content: string): string | null\` helper short-circuits the per-file loop with a specific reason for empty/whitespace-only content. Same quarantine outcome, actionable message.
- **\`scripts/parsers/__tests__/normalize-line-endings.test.ts\`**: 7 unit tests for the helper.
- **\`scripts/parsers/__tests__/parser-crlf-regression.test.ts\`**: 3 regression tests on \`parseV2Steps\`/\`parseV1Steps\` via \`composeTutorial\`.
- **\`scripts/parsers/__tests__/compose.test.ts\`**: integration test using the real-world \`btp-cockpit-setup.md\` shape (CRLF + parser: v2 + 3 H3 headings).
- **\`test/validate-tutorials-empty.test.ts\`**: 4 unit tests for \`emptyContentCheck\`.

## Out of scope (per spec)

- **Stepless overview docs** (e.g. \`btp-transport-management-cpi-01-use-case\` declares \`parser: v2\` but has no \`### \` headings — author-side content/parser mismatch).
- **Fetch-side filtering** of empty upstream sources.

## Test plan

- ✅ All new helper unit tests, parser regression tests, compose integration test, and validator empty-check tests pass.
- ✅ Existing \`scripts/parsers/__tests__/compose.test.ts\` (branches integration) still passes.
- ✅ Existing \`test/validate-tutorials-shortcode.test.ts\` (the #382 phase E regression) still passes.
- After merge, the first \`rebuild-content.yml\` run should drop the per-publish quarantine count by ~8 tutorials (the CRLF cohort). Remaining 1–2 quarantines are the genuine empty stubs and stepless overview docs — those need author-side fixes.

## Refs

- Spec: [docs/superpowers/specs/2026-06-19-validate-tutorials-stepcount-crlf-design.md](docs/superpowers/specs/2026-06-19-validate-tutorials-stepcount-crlf-design.md)
- Plan: [docs/superpowers/plans/2026-06-19-validate-tutorials-stepcount-crlf.md](docs/superpowers/plans/2026-06-19-validate-tutorials-stepcount-crlf.md)
- Related (same masking pattern): #425

Closes #432.
EOF
)"
```

Expected: PR URL printed.

---

## Notes for the implementer

- **Re-issue \`git checkout\`** as part of every commit invocation (memory: \`feedback_branch_slip_after_long_session\`). Each commit step in this plan reminds you to run \`git branch --show-current\` first.
- **Don't squash commits.** Spec → plan → helper+normalization → parser regression → compose integration → validator empty-check is a clean reviewable story (7 commits total).
- **The TDD ordering in Task 1 is RED-first** (helper test fails before helper exists). Task 4's ordering is more pragmatic (helper extracted first, then test) — see the note in Task 4 Step 3 if you want strict RED-first there too.
- **Don't tighten parser regexes** as a "while I'm here" defense-in-depth move. Spec explicitly rejects that scope.
- **Don't touch the \`btp-transport-management-cpi-01-use-case\` zero-step case.** It's an author-side content shape, not a parser bug. Out of scope.
- **Vitest fixtures use \`.replace(/\\n/g, '\\r\\n')\` to construct CRLF input** so the test source itself can be authored as a normal multiline string. Don't try to literally type \`\\r\\n\` into JS source — \`.join('\\n')\` then \`.replace(...)\` is cleaner.
