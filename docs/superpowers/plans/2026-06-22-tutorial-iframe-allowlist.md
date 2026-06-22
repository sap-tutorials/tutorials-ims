# Tutorial iframe host allowlist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore iframe rendering for ~138 YouTube/openSAP/SAPvideo embeds across ~65 tutorials, without giving back the security gain of PR #141.

**Architecture:** Three enforcement layers — (1) `sanitize-html`'s `allowedIframeHostnames` option at the build-time sanitizer, (2) CSP `frame-src` directive at the approuter, (3) a new lint rule that warns authors at PR time. Single source of truth: an exported `ALLOWED_IFRAME_HOSTNAMES` constant in `scripts/parsers/sanitize-html.ts` that the lint rule imports.

**Tech Stack:** TypeScript, `sanitize-html` npm package, vitest, the project's existing CDS/Hugo/AppRouter MTA toolchain. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-06-22-tutorial-iframe-allowlist-design.md](../specs/2026-06-22-tutorial-iframe-allowlist-design.md)

---

## File map (decomposition lock-in)

| File | Action | Lines | Responsibility |
|---|---|---|---|
| `scripts/parsers/sanitize-html.ts` | MODIFY | ~10 lines added | Add `ALLOWED_IFRAME_HOSTNAMES` constant, add `iframe` to allowed tags + attrs, configure `allowedIframeHostnames` + `allowedIframeRelativeUrls` |
| `scripts/__tests__/sanitize-html.test.ts` | MODIFY | 1 test replaced + 9 new | Replace the "removes iframe tags" negative test, add positive cases for each allowlisted host + the new defensive cases |
| `approuter/xs-app.json` | MODIFY | 1 line | Extend `frame-src` CSP directive with the 4 new hosts |
| `scripts/lint-rules/iframe-non-allowlisted-host.ts` | CREATE | ~50 lines | Lint rule: warn when an iframe src host is not on `ALLOWED_IFRAME_HOSTNAMES` |
| `scripts/lint-tutorial-markdown.ts` | MODIFY | 2 lines | Wire new rule into the `RULES` array |
| `scripts/lint-rules/__tests__/iframe-non-allowlisted-host.test.ts` | CREATE | ~60 lines | Test the new lint rule's three branches (off-allowlist warns, on-allowlist silent, malformed warns) |
| `docs/developers/reference/iframe-allowlist.md` | CREATE | ~70 lines | Document the 3-layer architecture + extension procedure + history |
| `docs/.vitepress/config.ts` | MODIFY | 1 line | Add the new doc page to the developers/reference sidebar |

---

## Cross-cutting conventions

- **CRLF on Windows.** After every write/edit, run `file <path>` and confirm "ASCII text" (not "CRLF") — memory `feedback_crlf_regression_on_windows`. Fix with `sd -F $'\r' '' <file>` if needed.
- **Module style.** All TypeScript files in `scripts/` use ESM (`.ts` extension, `import` statements). Match the surrounding file's import style.
- **Test framework.** vitest. Imports: `import { describe, it, expect } from 'vitest'`.
- **Existing severity field.** `LintSeverity = 'error' | 'warning' | 'notice'` is **already** in `scripts/lint-tutorial-markdown.ts` at line 34. `LintFinding.severity` is optional (defaults-to-`warning` when omitted). The spec's "add severity machinery" task is already complete — the new rule just emits `severity: 'warning'` on each finding. **No runner refactor needed.**
- **Existing Rule shape.** Rules implement `scan(slug, lines, rawLines): LintFinding[]`, NOT `check(content, filename)`. The plan's lint-rule sketch in the spec used the wrong signature; this plan corrects it.
- **Existing extracted-rule pattern.** `scripts/lint-rules/branch-staleness.ts` is the model to follow for the new file. Tests for that rule live at `scripts/lint-rules/__tests__/branch-staleness.test.ts`.
- **Regex iteration style.** Use `String.prototype.matchAll()` for repeated regex matches rather than `RegExp.prototype` iteration — it's cleaner modern JS, avoids stateful-regex bugs, and avoids tripping a security hook that misidentifies `.exec()` calls as child_process invocations.

---

## Task 0: Verify clean baseline

Before any changes, confirm the existing tests pass so we can attribute later failures to our changes.

**Files:** none (verification only)

- [ ] **Step 1: Verify current branch + worktree state**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/tutorial-iframe-allowlist
git branch --show-current  # → feat/tutorial-iframe-allowlist
git status -s              # → empty (clean tree)
git log --oneline main..HEAD  # → 1 commit (the spec)
```

- [ ] **Step 2: Run the sanitizer + lint tests in isolation**

```bash
npx vitest run scripts/__tests__/sanitize-html.test.ts scripts/lint-rules/__tests__/branch-staleness.test.ts test/unit/lint-tutorial-markdown.test.js
```

Expected: all passing. Numbers depend on baseline (recently checked: 269-line sanitizer test, 5+ branch-staleness tests). **Note the green baseline counts** for the spec-compliance reviewer.

---

## Task 1: Sanitizer — add the constant + iframe allowlist (TDD red phase)

**Files:**
- Test: `scripts/__tests__/sanitize-html.test.ts` (add new failing tests)
- Modify: `scripts/parsers/sanitize-html.ts` (later, in Task 2)

**Why we do this first:** TDD red phase. Write tests that expect the new behavior; verify they FAIL against the unchanged sanitizer; THEN make them pass in Task 2.

- [ ] **Step 1: Open the test file + locate the current iframe-strip test**

Read [scripts/__tests__/sanitize-html.test.ts](../../scripts/__tests__/sanitize-html.test.ts) lines 14-17:

```ts
it('removes iframe tags', () => {
  const input = '<iframe src="https://evil.com"></iframe>'
  expect(stripDangerousHtml(input)).toBe('')
})
```

This is a regression-guard from PR #141 — proves the sanitizer strips iframes. After our changes, off-allowlist iframes STILL get stripped, so we keep this assertion but rename + clarify it.

- [ ] **Step 2: Rename the existing test to make the negative case explicit**

Replace the block above with:

```ts
it('removes iframe with off-allowlist host (#140 regression guard)', () => {
  // After 2026-06-22 (iframe allowlist PR), iframes from allowlisted hosts
  // survive sanitization. This negative case proves the host check still
  // strips iframes pointing to arbitrary external hosts.
  const input = '<iframe src="https://evil.com"></iframe>'
  expect(stripDangerousHtml(input)).toBe('')
})
```

- [ ] **Step 3: Add the 10 new test cases at the end of the `describe('stripDangerousHtml', ...)` block**

Each case is documented with the spec's test-coverage section number for traceability. Insert as a nested `describe` block inside the outer `describe('stripDangerousHtml', ...)`:

```ts
// ─── Iframe host allowlist (#140 reintroduction, 2026-06-22) ─────────────

describe('iframe host allowlist', () => {
  it('preserves YouTube /embed/ iframe with full attribute set (spec 1)', () => {
    const input = '<iframe width="560" height="315" src="https://www.youtube.com/embed/8obCwGEx1-Q" title="HANA Cloud CAP" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>'
    const out = stripDangerousHtml(input)
    // sanitize-html may reorder attrs; assert structure via substring matches
    // rather than full-string equality.
    expect(out).toMatch(/<iframe\b/)
    expect(out).toMatch(/src="https:\/\/www\.youtube\.com\/embed\/8obCwGEx1-Q"/)
    expect(out).toMatch(/width="560"/)
    expect(out).toMatch(/height="315"/)
    expect(out).toMatch(/frameborder="0"/)
    expect(out).toMatch(/allow="[^"]*accelerometer/)
    expect(out).toMatch(/allowfullscreen/)
    expect(out).toMatch(/title="HANA Cloud CAP"/)
    expect(out).toMatch(/<\/iframe>/)
  })

  it('preserves youtu.be short-link iframe with src intact (spec 2)', () => {
    // Verifies youtu.be hostname is on the allowlist AND the original src
    // URL is preserved verbatim (browsers evaluate CSP frame-src against the
    // pre-redirect URL — see spec § "Why youtu.be needs an explicit entry").
    const input = '<iframe src="https://youtu.be/dQw4w9WgXcQ"></iframe>'
    const out = stripDangerousHtml(input)
    expect(out).toMatch(/<iframe\b/)
    expect(out).toMatch(/src="https:\/\/youtu\.be\/dQw4w9WgXcQ"/)
  })

  it('preserves microlearning.opensap.com iframe (spec 3)', () => {
    const input = '<iframe src="https://microlearning.opensap.com/embed/secure/iframe/entryId/1_6448scfq/uiConfId/43091531"></iframe>'
    const out = stripDangerousHtml(input)
    expect(out).toMatch(/<iframe\b/)
    expect(out).toMatch(/src="https:\/\/microlearning\.opensap\.com\/embed/)
  })

  it('preserves sapvideo.cfapps.eu10-004 iframe (spec 4)', () => {
    const input = '<iframe src="https://sapvideo.cfapps.eu10-004.hana.ondemand.com/?entry_id=1_5r7r5h0n"></iframe>'
    const out = stripDangerousHtml(input)
    expect(out).toMatch(/<iframe\b/)
    expect(out).toMatch(/src="https:\/\/sapvideo\.cfapps\.eu10-004\.hana\.ondemand\.com/)
  })

  it('strips iframe from off-allowlist host (vimeo) (spec 5)', () => {
    const input = '<iframe src="https://player.vimeo.com/video/123456"></iframe>'
    expect(stripDangerousHtml(input)).toBe('')
  })

  it('strips srcdoc attribute on allowlisted-host iframe (defense-in-depth, spec 6)', () => {
    // An allowlisted-host iframe must NOT carry srcdoc — it would let an
    // author inject arbitrary inline HTML that bypasses the host check.
    const input = '<iframe src="https://www.youtube.com/embed/x" srcdoc="<script>alert(1)</script>"></iframe>'
    const out = stripDangerousHtml(input)
    expect(out).toMatch(/<iframe\b/)
    expect(out).not.toMatch(/srcdoc/)
  })

  it('strips onload/onerror handlers on allowlisted-host iframe (spec 7)', () => {
    const input = '<iframe src="https://www.youtube.com/embed/x" onload="alert(1)" onerror="alert(2)"></iframe>'
    const out = stripDangerousHtml(input)
    expect(out).toMatch(/<iframe\b/)
    expect(out).not.toMatch(/onload/)
    expect(out).not.toMatch(/onerror/)
  })

  it('strips relative-URL iframe (spec 8)', () => {
    // allowedIframeRelativeUrls: false in the sanitizer config.
    const input = '<iframe src="/api/foo"></iframe>'
    expect(stripDangerousHtml(input)).toBe('')
  })

  it('strips javascript: scheme in iframe src (spec 9)', () => {
    // The scheme allowlist (http/https/mailto) applies to src per
    // allowedSchemesAppliedToAttributes.
    const input = '<iframe src="javascript:alert(1)"></iframe>'
    expect(stripDangerousHtml(input)).toBe('')
  })

  it('preserves pseudo-tag handling for unknown <iframe-like-thing> (spec 10)', () => {
    // Hyphenated tag names that look like author placeholders should NOT
    // be consumed as iframe elements. They get escaped to literal text.
    const input = '<iframe-like-thing>placeholder</iframe-like-thing>'
    const out = stripDangerousHtml(input)
    expect(out).toContain('&lt;iframe-like-thing&gt;')
    expect(out).toContain('placeholder')
  })
})
```

- [ ] **Step 4: Run the new tests to confirm they FAIL**

```bash
npx vitest run scripts/__tests__/sanitize-html.test.ts -t "iframe host allowlist"
```

Expected: **all 10 new tests FAIL** (because the sanitizer still strips all iframes). The negative-case tests (5, 8, 9) may already pass since they assert empty output, which matches today's behavior — note which subset fails vs. passes so we know what Task 2 needs to flip.

- [ ] **Step 5: Commit the red-phase tests**

```bash
git add scripts/__tests__/sanitize-html.test.ts
git commit -m "test(sanitizer): iframe host allowlist tests (TDD red phase)

Adds 10 tests for the iframe allowlist (#140 reintroduction with
hostname enforcement):
  - 4 positive cases: youtube.com, youtu.be, microlearning.opensap.com,
    sapvideo.cfapps.eu10-004.hana.ondemand.com survive sanitization
  - 6 negative/defensive: vimeo stripped, srcdoc stripped on allowlisted
    host, on*/relative/javascript: stripped, pseudo-tag handling intact
Renames the existing 'removes iframe tags' regression test to make the
negative semantics explicit.

Tests fail against the current sanitizer; Task 2 makes them pass.

Spec: docs/superpowers/specs/2026-06-22-tutorial-iframe-allowlist-design.md
Refs #140."
```

---

## Task 2: Sanitizer — implement the allowlist (TDD green phase)

**Files:**
- Modify: `scripts/parsers/sanitize-html.ts`

- [ ] **Step 1: Add `ALLOWED_IFRAME_HOSTNAMES` constant near the top of the file**

Find the `SEMANTIC_TAGS` declaration at line 19. After the `SEMANTIC_TAGS` array closes (around line 28), and BEFORE the `KNOWN_HTML_TAGS` set, insert:

```ts
// Iframe host allowlist — author-controlled embeds from trusted SAP video
// hosts. Authors do NOT supply user input here; iframes come from tutorial
// markdown checked into the sap-tutorials GitHub org. Re-introduces what
// #140 (sanitize-html migration) intentionally stripped — narrowly, with
// hostname enforcement that the previous regex sanitizer could not express.
//
// THREE PLACES MUST BE UPDATED TOGETHER when extending the allowlist:
//   1. This constant
//   2. approuter/xs-app.json — frame-src directive
//   3. docs/developers/reference/iframe-allowlist.md — host table
//
// scripts/lint-rules/iframe-non-allowlisted-host.ts auto-updates because
// it imports this constant.
export const ALLOWED_IFRAME_HOSTNAMES = [
  'www.youtube.com',
  'youtube.com',
  'youtu.be',
  'microlearning.opensap.com',
  'sapvideo.cfapps.eu10-004.hana.ondemand.com',
] as const
```

- [ ] **Step 2: Add `iframe` to `ALLOWED_TAGS`**

Find line 98 `const ALLOWED_TAGS = SEMANTIC_TAGS`. Change to:

```ts
const ALLOWED_TAGS = [...SEMANTIC_TAGS, 'iframe']
```

- [ ] **Step 3: Add the `iframe` attribute allowlist**

In the `ALLOWED_ATTRS` object (starts at line ~100), add a new entry after the last existing entry (probably `abbr`):

```ts
  iframe: ['src', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen', 'title', 'loading', 'referrerpolicy'],
```

- [ ] **Step 4: Add the iframe options to `SANITIZE_OPTS`**

In the `SANITIZE_OPTS` object (starts at line ~119), add two new options. Suggested placement: right after `allowProtocolRelative: false` (~line 124):

```ts
  allowedIframeHostnames: [...ALLOWED_IFRAME_HOSTNAMES],
  allowedIframeRelativeUrls: false,
```

Note: `[...ALLOWED_IFRAME_HOSTNAMES]` widens the `readonly` tuple to a mutable `string[]` which is what `sanitize-html`'s `IOptions` expects.

- [ ] **Step 5: Run the iframe-allowlist tests — expect PASS**

```bash
npx vitest run scripts/__tests__/sanitize-html.test.ts -t "iframe host allowlist"
```

Expected: **10/10 passing**. If any fail, the most likely cause is sanitize-html serializing iframe with a self-closing slash or different attribute order — adjust assertions to use substring style.

- [ ] **Step 6: Run the FULL sanitizer test file to confirm no regressions**

```bash
npx vitest run scripts/__tests__/sanitize-html.test.ts
```

Expected: every test passes including the existing 269-line set. **Note the total count** for the spec reviewer.

- [ ] **Step 7: Verify CRLF + commit**

```bash
file scripts/parsers/sanitize-html.ts scripts/__tests__/sanitize-html.test.ts
# Expected: both report "ASCII text" (NOT "CRLF")

git add scripts/parsers/sanitize-html.ts
git commit -m "feat(sanitizer): allow iframes from SAP-blessed video hosts (#140 reintro)

Adds ALLOWED_IFRAME_HOSTNAMES constant + iframe to the sanitizer's
allowed-tags + per-attribute allowlist + sanitize-html's
allowedIframeHostnames option. Five hosts allowlisted: www.youtube.com,
youtube.com, youtu.be, microlearning.opensap.com,
sapvideo.cfapps.eu10-004.hana.ondemand.com (catalog grep on 2026-06-22
found 138 iframe occurrences across ~65 tutorials, all from these hosts).

Re-introduces narrowly what #140 (PR #141, sanitize-html migration)
deliberately stripped. The original strip was correct: the regex sanitizer
couldn't enforce a hostname allowlist. sanitize-html's allowedIframeHostnames
option gives us the safety the regex couldn't.

Defense-in-depth: sanitizer enforces host at parse time, CSP frame-src
enforces at render time (Task 4), lint rule warns at PR time (Task 5).

Spec: docs/superpowers/specs/2026-06-22-tutorial-iframe-allowlist-design.md
Refs #140."
```

---

## Task 3: Sanitizer — defense-in-depth attribute exclusions

This task is verification-only — the previous task should already strip `srcdoc`, `onload`, `onerror`, relative-URL `src`, and `javascript:` scheme iframes. We separate this into its own task to make the spec reviewer's job easier: each defense-in-depth assertion has a unique commit.

**Files:** none (verification only — the previous task should have already passed these tests)

- [ ] **Step 1: Run only the defense-in-depth tests**

```bash
npx vitest run scripts/__tests__/sanitize-html.test.ts -t "srcdoc|onload|relative-URL|javascript:|pseudo-tag"
```

Expected: 5 tests passing (cases 6, 7, 8, 9, 10 from Task 1).

- [ ] **Step 2: If any defense-in-depth test fails, debug before proceeding.**

Common causes:
- `srcdoc` failing → the iframe attribute allowlist in Task 2 must NOT include `srcdoc` (verify line in the diff)
- `onload`/`onerror` failing → sanitize-html should strip these by default since they're not in the allowlist. If failing, the iframe-specific allowlist has accidentally widened.
- `javascript:` failing → check that `allowedSchemes` is `['http', 'https', 'mailto']` (line ~117 in the existing file) AND `allowedSchemesAppliedToAttributes` includes `src`.

No commit on this task if all already passing. If any test required a sanitizer fix, commit it with a message that explains the specific fix.

---

## Task 4: CSP — extend `frame-src`

**Files:**
- Modify: `approuter/xs-app.json` (single line — the CSP header value)

- [ ] **Step 1: Read the current CSP header**

```bash
grep -n "frame-src" approuter/xs-app.json
```

Expected output: line 6 contains `... frame-src https://www.youtube.com; ...` as part of a single multi-directive CSP string.

- [ ] **Step 2: Apply the edit**

Use the Edit tool. Find the exact substring:

```
frame-src https://www.youtube.com;
```

Replace with:

```
frame-src https://www.youtube.com https://youtube.com https://youtu.be https://microlearning.opensap.com https://sapvideo.cfapps.eu10-004.hana.ondemand.com;
```

(Single space between hosts. The trailing semicolon separates this directive from the next one in the CSP value. Do NOT add or remove other directives.)

- [ ] **Step 3: Verify JSON validity**

```bash
node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json', 'utf8')); console.log('OK')"
```

Expected: `OK`. If anything else, the edit broke the JSON — fix before continuing.

- [ ] **Step 4: Verify the directive is well-formed**

```bash
node -e "const j = JSON.parse(require('fs').readFileSync('approuter/xs-app.json', 'utf8')); const csp = j.responseHeaders.find(h => h.name === 'Content-Security-Policy').value; const fs = csp.split(';').find(d => d.trim().startsWith('frame-src')); console.log(fs);"
```

Expected output (single line, leading space is normal):

```
 frame-src https://www.youtube.com https://youtube.com https://youtu.be https://microlearning.opensap.com https://sapvideo.cfapps.eu10-004.hana.ondemand.com
```

- [ ] **Step 5: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(approuter): extend CSP frame-src for iframe allowlist (#140 reintro)

Adds youtube.com, youtu.be, microlearning.opensap.com, and
sapvideo.cfapps.eu10-004.hana.ondemand.com to the frame-src directive.
Pairs with the sanitizer change in the same PR.

Note: youtu.be needs its own entry even though it redirects to
www.youtube.com — browsers evaluate frame-src against the original
src URL before following any redirect.

Activates on next MTA redeploy.

Spec: docs/superpowers/specs/2026-06-22-tutorial-iframe-allowlist-design.md
Refs #140."
```

---

## Task 5: Lint rule — write failing tests (TDD red phase)

**Files:**
- Create: `scripts/lint-rules/__tests__/iframe-non-allowlisted-host.test.ts`

We co-locate tests with the rule in `scripts/lint-rules/__tests__/` (matches the existing `branch-staleness.test.ts` pattern).

- [ ] **Step 1: Read the existing rule-test pattern**

```bash
head -40 scripts/lint-rules/__tests__/branch-staleness.test.ts
```

Note the imports + describe structure to match style.

- [ ] **Step 2: Create the test file**

Create `scripts/lint-rules/__tests__/iframe-non-allowlisted-host.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { iframeNonAllowlistedHostRule } from '../iframe-non-allowlisted-host'

// Rule shape mirrors the existing pattern in scripts/lint-tutorial-markdown.ts:
//   scan(slug, lines, rawLines): LintFinding[]
// `lines` arrives with code fences redacted; rules generally use `lines`
// rather than rawLines for prose-pattern matching.

function runRule(source: string, slug = 'fixture') {
  const lines = source.split('\n')
  return iframeNonAllowlistedHostRule.scan(slug, lines, lines)
}

describe('iframe-non-allowlisted-host', () => {
  it('warns on Vimeo iframe with correct line + severity', () => {
    const src = [
      'Some prose.',
      '',
      '<iframe src="https://player.vimeo.com/video/123"></iframe>',
      '',
      'More prose.',
    ].join('\n')
    const findings = runRule(src)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'iframe-non-allowlisted-host',
      line: 3,
      severity: 'warning',
    })
    expect(findings[0].message).toContain('player.vimeo.com')
  })

  it('does not fire on YouTube iframe (allowlisted)', () => {
    const src = '<iframe src="https://www.youtube.com/embed/8obCwGEx1-Q"></iframe>'
    expect(runRule(src)).toHaveLength(0)
  })

  it('does not fire on microlearning.opensap.com iframe (allowlisted)', () => {
    const src = '<iframe src="https://microlearning.opensap.com/embed/secure/iframe/entryId/1_x"></iframe>'
    expect(runRule(src)).toHaveLength(0)
  })

  it('warns on malformed iframe src', () => {
    const src = '<iframe src="not a url"></iframe>'
    const findings = runRule(src)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('Malformed')
    expect(findings[0].severity).toBe('warning')
  })

  it('fires once per iframe when multiple iframes are on the same line', () => {
    const src = '<iframe src="https://vimeo.com/1"></iframe><iframe src="https://dailymotion.com/2"></iframe>'
    const findings = runRule(src)
    expect(findings).toHaveLength(2)
    expect(findings[0].message).toContain('vimeo.com')
    expect(findings[1].message).toContain('dailymotion.com')
  })
})
```

- [ ] **Step 3: Run the test, confirm FAIL (rule module doesn't exist yet)**

```bash
npx vitest run scripts/lint-rules/__tests__/iframe-non-allowlisted-host.test.ts
```

Expected: error like `Failed to resolve import "../iframe-non-allowlisted-host"`. That's the red phase.

- [ ] **Step 4: Commit the failing tests**

```bash
git add scripts/lint-rules/__tests__/iframe-non-allowlisted-host.test.ts
git commit -m "test(lint): iframe-non-allowlisted-host rule tests (TDD red phase)

Five tests covering the new lint rule:
  - off-allowlist host (Vimeo) -> 1 warning with correct line + severity
  - on-allowlist host (YouTube) -> silent
  - on-allowlist host (openSAP) -> silent
  - malformed src -> 1 warning mentioning 'Malformed'
  - multiple iframes per line -> one finding each

Tests fail because the rule module doesn't exist yet; Task 6 creates it.

Spec: docs/superpowers/specs/2026-06-22-tutorial-iframe-allowlist-design.md"
```

---

## Task 6: Lint rule — implement (TDD green phase)

**Files:**
- Create: `scripts/lint-rules/iframe-non-allowlisted-host.ts`

- [ ] **Step 1: Inspect the existing rule for the exact `Rule` type shape**

```bash
sed -n '47,55p' scripts/lint-tutorial-markdown.ts
```

The `Rule` type is **not exported** from `lint-tutorial-markdown.ts` — it's a local type. The existing `branch-staleness.ts` rule works around this by defining its own typed object that structurally matches. Our new rule does the same.

- [ ] **Step 2: Create `scripts/lint-rules/iframe-non-allowlisted-host.ts`**

Note the use of `String.prototype.matchAll()` for multi-match iteration — cleaner than stateful regex iteration and sidesteps a hook false-positive.

```ts
// scripts/lint-rules/iframe-non-allowlisted-host.ts
//
// Warns when a tutorial markdown file contains an <iframe> whose src host
// is not on the sanitizer allowlist. Without this rule, an author who
// pastes a Vimeo or non-SAP video URL would build successfully, then
// discover at runtime that their iframe was silently stripped by the
// sanitizer (issue #136 / PR #140 design).
//
// Severity: warning (not error). Catalog ships ~138 known iframes; new
// authors who paste an off-allowlist host get a visible warning at lint
// time and can either (a) ask the platform team to extend the allowlist
// + CSP, or (b) switch to an allowlisted host. Does NOT block the build —
// CI invokes lint:tutorial-markdown with continue-on-error: true.
//
// Single-source-of-truth: allowlist is imported from the sanitizer module
// so adding a host to ALLOWED_IFRAME_HOSTNAMES automatically updates the
// lint behavior without code changes here.

import { ALLOWED_IFRAME_HOSTNAMES } from '../parsers/sanitize-html.js'
import type { LintFinding } from '../lint-tutorial-markdown.js'

// Captures `<iframe ... src="..." ...>` on a single line. Catalog grep on
// 2026-06-22 found zero multi-line iframe attributes; the simple line-scan
// regex is sufficient. Global flag for matchAll() iteration.
const IFRAME_SRC_RE = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi

export const iframeNonAllowlistedHostRule = {
  id: 'iframe-non-allowlisted-host',
  describe: 'iframe src host is not on ALLOWED_IFRAME_HOSTNAMES; sanitizer will silently strip it.',
  scan(slug: string, lines: string[], _rawLines: string[]): LintFinding[] {
    const findings: LintFinding[] = []
    const allow = ALLOWED_IFRAME_HOSTNAMES as readonly string[]
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const match of line.matchAll(IFRAME_SRC_RE)) {
        const src = match[1]
        let host: string
        try {
          host = new URL(src).hostname
        } catch {
          findings.push({
            rule: 'iframe-non-allowlisted-host',
            slug,
            file: `${slug}.md`,
            line: i + 1,
            message: `Malformed iframe src "${src}" — sanitizer will silently strip this iframe.`,
            excerpt: line.slice(0, 100),
            severity: 'warning',
          })
          continue
        }
        if (!allow.includes(host)) {
          findings.push({
            rule: 'iframe-non-allowlisted-host',
            slug,
            file: `${slug}.md`,
            line: i + 1,
            message: `iframe src host "${host}" is not on the allowlist (${allow.join(', ')}). Sanitizer will silently strip this iframe. Either switch to an allowlisted host or extend the allowlist in scripts/parsers/sanitize-html.ts (see docs/developers/reference/iframe-allowlist.md).`,
            excerpt: line.slice(0, 100),
            severity: 'warning',
          })
        }
      }
    }
    return findings
  },
}
```

- [ ] **Step 3: Run the new rule's tests — expect PASS**

```bash
npx vitest run scripts/lint-rules/__tests__/iframe-non-allowlisted-host.test.ts
```

Expected: **5/5 passing**. The `matchAll()` iteration handles the multi-iframe-per-line case naturally — no stateful `lastIndex` reset needed.

- [ ] **Step 4: Verify CRLF + commit**

```bash
file scripts/lint-rules/iframe-non-allowlisted-host.ts
# Expected: "ASCII text"

git add scripts/lint-rules/iframe-non-allowlisted-host.ts
git commit -m "feat(lint): iframe-non-allowlisted-host rule

Warns at lint time when a tutorial markdown file contains an <iframe>
whose src host is not on ALLOWED_IFRAME_HOSTNAMES. Without this warning,
authors who paste a Vimeo or other off-allowlist URL would silently lose
their iframe at sanitizer time.

Severity: warning. Pairs with the sanitizer + CSP changes in the same PR.

Spec: docs/superpowers/specs/2026-06-22-tutorial-iframe-allowlist-design.md"
```

---

## Task 7: Lint rule — wire into runner

**Files:**
- Modify: `scripts/lint-tutorial-markdown.ts`

- [ ] **Step 1: Read the import + RULES wiring**

```bash
sed -n '24,32p' scripts/lint-tutorial-markdown.ts
sed -n '166p' scripts/lint-tutorial-markdown.ts
```

Imports at top, `RULES` array at line 166.

- [ ] **Step 2: Add the import**

After line 29 (the `branchStalenessRule` import), add:

```ts
import { iframeNonAllowlistedHostRule } from './lint-rules/iframe-non-allowlisted-host'
```

- [ ] **Step 3: Add the rule to the `RULES` array**

Change line 166 from:

```ts
const RULES: Rule[] = [indentedNumberedListItem]
```

to:

```ts
const RULES: Rule[] = [indentedNumberedListItem, iframeNonAllowlistedHostRule]
```

- [ ] **Step 4: Run the existing top-level lint test to confirm it still passes**

```bash
npx vitest run test/unit/lint-tutorial-markdown.test.js
```

Expected: all passing. If a test fails because `RULES.length` changed from 1 to 2 or similar, update that test's expectation in the same commit.

- [ ] **Step 5: Commit**

```bash
git add scripts/lint-tutorial-markdown.ts
git commit -m "feat(lint): wire iframe-non-allowlisted-host rule into runner

Activates the new rule on every \`npm run lint:tutorial-markdown\` run.
CI invokes the runner in rebuild-content.yml + rebuild-content-qa.yml
with continue-on-error: true, so the rule's warnings appear in the
uploaded JSON report without blocking the build.

Spec: docs/superpowers/specs/2026-06-22-tutorial-iframe-allowlist-design.md"
```

---

## Task 8: Documentation — new reference page

**Files:**
- Create: `docs/developers/reference/iframe-allowlist.md`

- [ ] **Step 1: Create the doc page**

Create `docs/developers/reference/iframe-allowlist.md` with this content. (NB the implementer writing this file should use plain ASCII content — no fancy unicode, the project's lint guardrails prefer that.)

```markdown
# Tutorial iframe host allowlist

Tutorial markdown can embed `<iframe>` elements from a small set of
SAP-blessed video hosts. The allowlist is enforced at three layers, each
providing defense-in-depth against the other two.

## Enforcement layers

1. **Sanitizer** ([scripts/parsers/sanitize-html.ts](../../../scripts/parsers/sanitize-html.ts))
   strips iframes whose src hostname is not on the list at build time.
2. **CSP** ([approuter/xs-app.json](../../../approuter/xs-app.json))
   makes the browser refuse to render iframes whose src host is not in
   `frame-src` at runtime.
3. **Lint** ([scripts/lint-rules/iframe-non-allowlisted-host.ts](../../../scripts/lint-rules/iframe-non-allowlisted-host.ts))
   warns tutorial authors at PR time before the sanitizer silently strips
   their content.

## Current allowlist

| Host | Rationale |
|---|---|
| `www.youtube.com` | YouTube embed - the most common video host in the catalog (~129 occurrences). |
| `youtube.com` | YouTube bare-domain form - occasional author variant. |
| `youtu.be` | YouTube short-link form. Browsers evaluate CSP against the original src URL *before* any redirect, so this needs its own entry. |
| `microlearning.opensap.com` | SAP openSAP microlearning embed (~7 occurrences). |
| `sapvideo.cfapps.eu10-004.hana.ondemand.com` | SAP internal video service. |

## Extending the allowlist

Three files must be updated together:

1. **Sanitizer constant** - [scripts/parsers/sanitize-html.ts](../../../scripts/parsers/sanitize-html.ts),
   the `ALLOWED_IFRAME_HOSTNAMES` array.
2. **CSP `frame-src`** - [approuter/xs-app.json](../../../approuter/xs-app.json),
   line 6 (the single `Content-Security-Policy` value, `frame-src` directive).
3. **This doc page** - the table above.

The lint rule **auto-updates** because it imports `ALLOWED_IFRAME_HOSTNAMES`.

After the three-file change, the next MTA redeploy activates the new
allowlist on DEV/QA/PROD.

## Attribute allowlist

Allowed iframe attributes (defense-in-depth - narrower than HTML5 defaults):

- `src` - host-checked by `allowedIframeHostnames`, scheme-checked by `allowedSchemes`
- `width`, `height` - author-controlled sizing
- `frameborder` - legacy attribute, harmless
- `allow` - feature-policy delegation
- `allowfullscreen` - fullscreen permission flag
- `title` - a11y label
- `loading` - performance hint (`lazy`)
- `referrerpolicy` - privacy attribute

**Deliberately excluded:** `srcdoc` (would allow inline HTML bypassing the
host allowlist), `name` (deprecated), `sandbox` (authors should not relax
our defaults), `on*` event handlers (always stripped by sanitize-html).

## History

- **PR #141** (issue #136, 2025-05-31) - migrated from a regex sanitizer to
  the `sanitize-html` npm package. Iframes were deliberately stripped
  because the regex sanitizer couldn't enforce a hostname allowlist.
  YouTube embeds in ~65 catalog tutorials silently disappeared.
- **PR #<this-PR>** (2026-06-22) - re-introduced a narrow iframe
  allowlist using `sanitize-html`'s `allowedIframeHostnames` option +
  the matching CSP `frame-src` directive + a lint rule that warns
  authors at PR time. Surfaced when Tom noticed the missing "Video
  Version" embed on `/tutorials/hana-cloud-cap-create-project`.
```

- [ ] **Step 2: Verify the file is well-formed**

```bash
wc -l docs/developers/reference/iframe-allowlist.md
file docs/developers/reference/iframe-allowlist.md
```

Expected: ~70 lines, "ASCII text" or "UTF-8 Unicode text" (NOT "CRLF").

- [ ] **Step 3: Commit**

```bash
git add docs/developers/reference/iframe-allowlist.md
git commit -m "docs(reference): tutorial iframe host allowlist

Documents the 3-layer enforcement architecture (sanitizer + CSP + lint)
and the 3-place allowlist-extension procedure. History section explicitly
references #140 / PR #141 so a future security audit understands the
deliberate scope of the iframe re-introduction.

Spec: docs/superpowers/specs/2026-06-22-tutorial-iframe-allowlist-design.md"
```

---

## Task 9: Documentation — VitePress sidebar registration

**Files:**
- Modify: `docs/.vitepress/config.ts`

`predocs:build` runs a check that rejects unregistered pages or dead links (memory `feedback_vitepress_mtaext_dead_links`). Skipping this step breaks `npm run docs:build`.

- [ ] **Step 1: Locate the developers/reference sidebar block**

```bash
grep -nE "developers/reference|/reference/|reference/" docs/.vitepress/config.ts | head -10
```

Expected: at least one match — there's an existing sidebar block listing pages under `developers/reference/`.

- [ ] **Step 2: Find an alphabetically-near existing entry to base the position on**

The new page is `iframe-allowlist.md`. List existing pages:

```bash
ls docs/developers/reference/*.md | sort
```

- [ ] **Step 3: Add the sidebar entry**

In `docs/.vitepress/config.ts`, find the sidebar array entry for `/developers/reference/` and add a new entry. The exact JSON shape mirrors the existing pages. Example (insert in alphabetical order):

```ts
{ text: 'Iframe allowlist', link: '/developers/reference/iframe-allowlist' },
```

(The exact field names — `text` + `link` vs `title` + `path` — depend on the VitePress version in use. Match the surrounding entries.)

- [ ] **Step 4: Verify the predocs:build check passes**

```bash
npm run predocs:build 2>&1 | tail -20
```

Expected: exits 0 with no "dead link" or "unregistered page" errors. If it fails:
- "Unregistered page": the sidebar entry's `link` field doesn't match the file path — fix and re-run.
- "Dead link" pointing into iframe-allowlist.md: one of the `[...](...)` references in the markdown doesn't resolve — fix the path.

- [ ] **Step 5: Commit**

```bash
git add docs/.vitepress/config.ts
git commit -m "docs(vitepress): register iframe-allowlist page in sidebar

Pairs with the new reference page added in the previous commit.
predocs:build's link guard requires the registration."
```

---

## Task 10: Final verification — run the full sanitizer + lint suite, confirm green

**Files:** none (verification only)

- [ ] **Step 1: Run all tests touched in this PR**

```bash
npx vitest run scripts/__tests__/sanitize-html.test.ts scripts/lint-rules/__tests__/ test/unit/lint-tutorial-markdown.test.js
```

Expected: all green, count matches the sum of `<existing-sanitizer-count> + 10` (sanitizer) + 5 (new lint rule) + `<existing-lint-runner-count>` (unchanged).

- [ ] **Step 2: Run the broader unit suite to confirm no cross-test regressions**

```bash
npm test 2>&1 | tail -20
```

Expected: matches the baseline count from Task 0 plus the new tests. **Pre-existing infrastructure-noise failures may show up** — these are tolerable per the catalog of known-flaky tests (github-rest, branch-loaders, etc.). Note them in the report but do not chase them.

- [ ] **Step 3: Confirm the full file change list**

```bash
git log --stat main..HEAD
```

Expected approximate diff:
- `scripts/parsers/sanitize-html.ts` — ~25 added
- `scripts/__tests__/sanitize-html.test.ts` — ~110 added (10 new tests), ~5 changed (renamed test)
- `approuter/xs-app.json` — ~1 line changed
- `scripts/lint-rules/iframe-non-allowlisted-host.ts` — ~60 added (NEW)
- `scripts/lint-rules/__tests__/iframe-non-allowlisted-host.test.ts` — ~60 added (NEW)
- `scripts/lint-tutorial-markdown.ts` — ~2 changed
- `docs/developers/reference/iframe-allowlist.md` — ~70 added (NEW)
- `docs/.vitepress/config.ts` — ~1 line added
- `docs/superpowers/specs/2026-06-22-tutorial-iframe-allowlist-design.md` — already there (Task 0 baseline)
- `docs/superpowers/plans/2026-06-22-tutorial-iframe-allowlist.md` — already there (this file)

Total: ~330 lines added across 7+ commits + the spec/plan commits.

- [ ] **Step 4: Verify no CRLF regressions on any touched file**

```bash
file scripts/parsers/sanitize-html.ts scripts/__tests__/sanitize-html.test.ts scripts/lint-rules/iframe-non-allowlisted-host.ts scripts/lint-rules/__tests__/iframe-non-allowlisted-host.test.ts scripts/lint-tutorial-markdown.ts approuter/xs-app.json docs/developers/reference/iframe-allowlist.md docs/.vitepress/config.ts
```

Expected: every line reports "ASCII text" or "UTF-8 Unicode text". If any reports "CRLF", fix with `sd -F $'\r' '' <file>` then `git add` + `git commit --amend --no-edit`.

---

## Task 11: Push branch + open PR

**Files:** none (PR work only)

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/tutorial-iframe-allowlist
```

- [ ] **Step 2: Write the PR body to a temp file**

Use the Write tool to create `_pr_body.md` in the worktree root with this content:

```markdown
## Why

Tutorial markdown from `sap-tutorials` GitHub org contains iframes pointing at SAP-blessed video hosts (YouTube, openSAP, sapvideo). The current sanitizer at `scripts/parsers/sanitize-html.ts` strips every iframe at build time, so **138 iframe occurrences across ~65 tutorials silently disappear** from the new tutorial system.

The strip came from a deliberate security hardening in PR #141 / issue #136 (the regex sanitizer to `sanitize-html` migration). The new library *does* support hostname allowlisting via its `allowedIframeHostnames` option, so we can re-introduce iframes narrowly without giving back the security gain.

User report: `/tutorials/hana-cloud-cap-create-project` is missing the "Video Version" YouTube embed that appears on the legacy AEM page.

## Design

3-layer enforcement:

1. **Sanitizer** - `sanitize-html`'s `allowedIframeHostnames` option
2. **CSP** - `frame-src` directive in approuter
3. **Lint** - warns authors at PR time before the build silently strips off-allowlist iframes

Single source of truth: `ALLOWED_IFRAME_HOSTNAMES` constant in `scripts/parsers/sanitize-html.ts`. The lint rule imports it. CSP + doc kept in sync via documented 3-place extension procedure.

Spec: docs/superpowers/specs/2026-06-22-tutorial-iframe-allowlist-design.md
Plan: docs/superpowers/plans/2026-06-22-tutorial-iframe-allowlist.md

## What ships

- `ALLOWED_IFRAME_HOSTNAMES` constant + iframe added to sanitizer config
- CSP `frame-src` extended: youtube.com, youtu.be, microlearning.opensap.com, sapvideo.cfapps.eu10-004.hana.ondemand.com
- New lint rule `iframe-non-allowlisted-host` with 5 unit tests
- 10 new sanitizer test cases (4 positive + 6 defense-in-depth)
- New doc page at `docs/developers/reference/iframe-allowlist.md`

## Test coverage

- Sanitizer: existing + 10 new (4 host-allowed + srcdoc/onload/relative-URL/javascript:/pseudo-tag defenses)
- Lint rule: 5 new (off-allowlist warns, 2 on-allowlist silent, malformed warns, multi-iframe-per-line)
- Total new test cases: 15

## Deploy

No deploy with this PR — Tom is batching with other in-flight fixes. Activates on next MTA redeploy.

## Traceability

References #140 in 3 places (sanitizer docstring, doc page history, this PR body) so a future security audit understands the deliberate scope.
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --head feat/tutorial-iframe-allowlist --title "feat(sanitizer): iframe host allowlist (restore SAP video embeds)" --body-file _pr_body.md
rm -f _pr_body.md
```

Expected: gh prints the PR URL. Capture it.

- [ ] **Step 4: Report PR URL to controller**

Print the URL + summary stats:

```bash
gh pr view --json url,additions,deletions,changedFiles
```

---

## Out of scope (do NOT do in this PR)

- **MTA redeploy** — Tom batches deploys.
- **Backfill historical YouTube embed comments in tutorial source** — authors author markdown; the allowlist is platform infrastructure.
- **Catalog audit script** — Tom approved "trust the catalog" during brainstorming.
- **Lint rule hardening (fail vs warn)** — Tom approved "warn" during brainstorming.
- **Extracting `indentedNumberedListItem` to its own file** — Out of scope. One rule extraction (the new iframe rule) is plenty.
- **Adding `sandbox` attribute support** — Separate design decision.
- **Inline-style iframe widths** — Authors who need responsive sizing can use a CSS class.

---

## Common-mistake red flags for the implementer

- **CRLF on Windows.** Memory `feedback_crlf_regression_on_windows`. Run `file` after every write.
- **Subagent writes can leak to parent repo.** Memory `feedback_subagent_writes_can_leak_to_parent_repo`. After each commit run `git -C ../../.. status` (the parent tutorials-poc dir) and confirm it's clean.
- **Security hook false positive on regex iteration.** When writing the new lint rule's TS file, the hook may flag any usage of `.exec` (the JS regex method) as a child_process false positive. Mitigations: prefer `String.prototype.matchAll()` (used in this plan's Task 6 code); or write the file via heredoc / Python helper if the Write tool gets blocked.
- **VitePress dead-link check.** Memory `feedback_vitepress_mtaext_dead_links`. `predocs:build` fails on out-of-tree or unregistered links — Task 9 specifically addresses this.
- **Don't redeploy.** Memory `feedback_confirm_deploy_scope`. This PR does NOT deploy. Tom batches.
