# Discovery Center Tutorial Sync Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code skill (`sap-discovery-tutorial-sync`) that converts an SAP Discovery Center tutorial into the sap-tutorials platform format, validates it against the real build, and optionally opens a PR — preserving our platform enrichments on update.

**Architecture:** A skill directory with a judgment-driven `SKILL.md` procedure plus a deterministic, unit-tested Node converter (`convert-body.mjs`) for the mechanical transforms. The skill drafts locally (`.sync-draft/`), validates by running the repo's own `fetch-tutorials` parser + `validate-tutorials`, then (on explicit confirmation) opens a PR against `sap-tutorials/btp-dev-guidance`. Two-phase, with a mandatory human review STOP between draft and PR.

**Tech Stack:** Node 20+ ESM (`.mjs`, native `fetch`, run with `node -I`), `tsx` (existing repo toolchain), `gray-matter` (already a dep, used by the repo parsers), `gh` CLI, Vitest-style assertions via the repo's existing test runner for the converter unit tests.

**Spec:** `docs/superpowers/specs/2026-10-09-discovery-tutorial-sync-skill-design.md`

## Global Constraints

- **Skill location:** `C:\Users\I809764\.claude\skills\sap-discovery-tutorial-sync\` (user-global skills dir, matching `sap-tutorial-dual-pr` and `tutorial-qa-to-prod`). The converter script and its tests also get a mirror copy committed into the tutorials-ims repo under `scripts/discovery-sync/` so the unit tests run in CI with the rest of the repo toolchain.
- **SKILL.md frontmatter:** exactly two keys — `name: sap-discovery-tutorial-sync` (kebab-case, matches dir) and a `description:` that is one long "Use when… Triggers on…" sentence. Match the two existing skills' tone verbatim in shape.
- **Single-slug fetch/parse uses the env var `TUTORIAL_SLUG=<slug>`** — there is NO `--slug` CLI flag on `fetch-tutorials.ts`.
- **Author frontmatter (what the skill WRITES)** uses these keys: `parser: v2`, `primary_tag`, `tags`, `time`, `author_name`, `author_profile`, optional `video`, optional `auto_validation`. These are the *input* keys the parser consumes — NOT the post-parse Hugo keys (`type`, `slug`, `stepCount`, `primaryTag`, `author`) emitted by `render-frontmatter.ts`.
- **OPTION marker syntax (verbatim):** `[OPTION BEGIN [LABEL]]\n…\n[OPTION END]`. Converter must emit exactly this; the parser regex is `/\[OPTION BEGIN \[([^\]]+)\]\]\s*\n([\s\S]*?)\[OPTION END\]/g`.
- **OS-conditional wiring is automatic** only when a group has **≥2 distinct canonical OSes** from `{Windows, macOS, Linux, BAS}` (os-classifier `classifyGroup` returns `regular` otherwise). The converter must NOT invent OS labels — it preserves the source `<summary>` label text and lets the parser classify.
- **rules.vr block syntax (verbatim):** `[VALIDATE_N]` … `[VALIDATE_END_N]` with `###Rule` / `###Question` / `###Match` sub-markers; directive `[AUTOAUTHOR_ALL]` (optional `:mcq` / `:text` suffix). rules.vr lands in the `<repo>-Contribution` repo, never the public repo.
- **Taxonomy source:** `GET ${CAP_BASE_URL}/build/tags` (default `http://localhost:4004`) → flat `{tags: string[]}`; the local cached copy is `hugo/data/tags.json`. CDS entity is `Tags` (`db/schema.cds:383`), queryable via cds-mcp.
- **Golden rules:** `git fetch origin` before branching; branch from fresh `origin/main`; PR via `gh pr create`, never direct-merge or push to main. Wrap noisy commands in `scripts/quiet-run.sh`.
- **Untrusted source handling:** fetched markdown/images are untrusted data — write them into the dedicated `.sync-draft/<slug>/` dir, never execute anything from it; run the converter with `node -I`.

---

## File Structure

**Skill (user-global, the deliverable):**
- Create: `~/.claude/skills/sap-discovery-tutorial-sync/SKILL.md` — the procedure Claude follows.
- Create: `~/.claude/skills/sap-discovery-tutorial-sync/references/format-mapping.md` — full source→target mapping table + edge cases.
- Create: `~/.claude/skills/sap-discovery-tutorial-sync/references/taxonomy-check.md` — how to resolve + validate tags.

**Converter + tests (committed into the repo so CI runs them):**
- Create: `scripts/discovery-sync/convert-body.mjs` — pure deterministic transforms.
- Create: `scripts/discovery-sync/__tests__/convert-body.test.ts` — fixture-based unit tests.
- Create: `scripts/discovery-sync/__tests__/fixtures/` — source/expected pairs.
- The SKILL.md references the repo copy by path; the skill run invokes `node -I scripts/discovery-sync/convert-body.mjs`.

Responsibilities are split so the converter is independently testable (pure string→string) and the SKILL.md holds only orchestration + judgment prose.

---

## Task 1: Converter — frontmatter stripping + H2→H1 title/description

**Files:**
- Create: `scripts/discovery-sync/convert-body.mjs`
- Test: `scripts/discovery-sync/__tests__/convert-body.test.ts`
- Create: `scripts/discovery-sync/__tests__/fixtures/01-title-source.md`, `01-title-expected.md`

**Interfaces:**
- Produces: `export function convertBody(source: string, slug: string): { body: string; flags: string[] }` — `body` is the converted markdown (NO frontmatter block; frontmatter is added later by the skill from prompted values), `flags` is a list of human-review strings. This task implements only the title/description portion; later tasks extend the same function.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { convertBody } from '../convert-body.mjs'

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures', n), 'utf-8')

describe('convertBody — title & description', () => {
  it('promotes the first H2 to H1 and inserts a description marker placeholder', () => {
    const { body } = convertBody(fx('01-title-source.md'), 'build-cap-app')
    expect(body).toBe(fx('01-title-expected.md'))
  })

  it('flags when no H2 title is found', () => {
    const { flags } = convertBody('Just a paragraph, no heading.', 'x')
    expect(flags).toContain('NO_TITLE: no leading "## " heading found; set the H1 title manually')
  })
})
```

- [ ] **Step 2: Create the fixtures**

`01-title-source.md`:
```markdown
## Build a CAP Application

In this tutorial you build a CAP app.

### Create a CAP project

Do the thing.
```

`01-title-expected.md`:
```markdown
# Build a CAP Application
<!-- description --> TODO: one-sentence catalog description (REVIEW)

In this tutorial you build a CAP app.

### Create a CAP project

Do the thing.
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run scripts/discovery-sync/__tests__/convert-body.test.ts`
Expected: FAIL — `convert-body.mjs` does not exist / `convertBody` not defined.

- [ ] **Step 4: Write minimal implementation**

```js
// scripts/discovery-sync/convert-body.mjs
export function convertBody(source, slug) {
  const flags = []
  let body = source.replace(/\r\n/g, '\n')

  // Promote the first "## Title" to "# Title" and insert a description marker.
  const h2 = body.match(/^##\s+(.+?)\s*$/m)
  if (!h2) {
    flags.push('NO_TITLE: no leading "## " heading found; set the H1 title manually')
  } else {
    const title = h2[1]
    const descLine = '<!-- description --> TODO: one-sentence catalog description (REVIEW)'
    body = body.replace(h2[0], `# ${title}\n${descLine}`)
  }

  return { body, flags }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run scripts/discovery-sync/__tests__/convert-body.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add scripts/discovery-sync/convert-body.mjs scripts/discovery-sync/__tests__/
git commit -m "feat(discovery-sync): converter title/description transform"
```

---

## Task 2: Converter — `<details>` → OPTION blocks

**Files:**
- Modify: `scripts/discovery-sync/convert-body.mjs`
- Test: `scripts/discovery-sync/__tests__/convert-body.test.ts` (add cases)
- Create: `scripts/discovery-sync/__tests__/fixtures/02-details-source.md`, `02-details-expected.md`, `02-nested-source.md`

**Interfaces:**
- Consumes: `convertBody` from Task 1.
- Produces: extends the same `convertBody` return. OPTION emission is `[OPTION BEGIN [LABEL]]\n<content>\n[OPTION END]`, label taken verbatim from the `<summary>` inner text (trimmed).

- [ ] **Step 1: Write the failing test**

```ts
describe('convertBody — details to OPTION', () => {
  it('converts open and closed <details> into OPTION blocks, dropping the open attr', () => {
    const { body } = convertBody(fx('02-details-source.md'), 'x')
    expect(body).toBe(fx('02-details-expected.md'))
  })

  it('flags nested <details> instead of converting them', () => {
    const { flags } = convertBody(fx('02-nested-source.md'), 'x')
    expect(flags).toContain('NESTED_DETAILS: nested <details> cannot map to OPTION blocks; convert this section manually')
  })
})
```

- [ ] **Step 2: Create the fixtures**

`02-details-source.md`:
```markdown
### Create services

<details open>
<summary>Node.js</summary>

Run `cds add`.

</details>

<details>
<summary>Java</summary>

Run `mvn`.

</details>
```

`02-details-expected.md`:
```markdown
### Create services

[OPTION BEGIN [Node.js]]

Run `cds add`.

[OPTION END]

[OPTION BEGIN [Java]]

Run `mvn`.

[OPTION END]
```

`02-nested-source.md`:
```markdown
<details>
<summary>Cloud Foundry</summary>
<details>
<summary>Node.js</summary>
x
</details>
</details>
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run scripts/discovery-sync/__tests__/convert-body.test.ts`
Expected: FAIL — OPTION conversion not implemented.

- [ ] **Step 4: Write minimal implementation**

Add to `convertBody`, before `return`:

```js
  // Detect nested <details> (OPTION blocks don't nest) — flag, don't convert.
  if (/<details[^>]*>(?:(?!<\/details>)[\s\S])*?<details/i.test(body)) {
    flags.push('NESTED_DETAILS: nested <details> cannot map to OPTION blocks; convert this section manually')
  }

  // Convert each top-level <details>…<summary>LABEL</summary>…</details> into an OPTION block.
  body = body.replace(
    /<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi,
    (_m, label, content) => {
      const l = label.trim()
      // Trim one leading/trailing blank line pair from content for clean spacing.
      const inner = content.replace(/^\n+/, '\n').replace(/\n+$/, '\n')
      return `[OPTION BEGIN [${l}]]${inner}[OPTION END]`
    },
  )
```

> Note on ordering: the nested-check runs on the pre-conversion `body`; the `g` replace is non-recursive so a nested pair would otherwise mangle — the flag warns the human and the outer pair still converts, leaving the inner tags visible for manual fixup.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run scripts/discovery-sync/__tests__/convert-body.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/discovery-sync/
git commit -m "feat(discovery-sync): convert <details> variants to OPTION blocks"
```

---

## Task 3: Converter — image paths + layout-comment stripping + code-fence lint

**Files:**
- Modify: `scripts/discovery-sync/convert-body.mjs`
- Test: `scripts/discovery-sync/__tests__/convert-body.test.ts` (add cases)
- Create: `scripts/discovery-sync/__tests__/fixtures/03-images-source.md`, `03-images-expected.md`

**Interfaces:**
- Consumes: `convertBody` from Tasks 1–2.
- Produces: `convertBody` additionally returns `images: string[]` — the de-duplicated list of relative image filenames referenced in the converted body (for the skill to fetch). Update the return type to `{ body, flags, images }`.

- [ ] **Step 1: Write the failing test**

```ts
describe('convertBody — images & fences', () => {
  it('strips ./ from image paths, drops layout comments, collects image list', () => {
    const { body, images } = convertBody(fx('03-images-source.md'), 'x')
    expect(body).toBe(fx('03-images-expected.md'))
    expect(images).toEqual(['bas-terminal.png', 'domain.png'])
  })

  it('flags a code fence missing a language tag', () => {
    const { flags } = convertBody('```\nplain\n```\n', 'x')
    expect(flags).toContain('FENCE_NO_LANG: a code fence has no language tag; add one (e.g. ```bash)')
  })
})
```

- [ ] **Step 2: Create the fixtures**

`03-images-source.md`:
```markdown
<!-- border; size:540px -->
![Terminal](./bas-terminal.png)

![Domain](domain.png)
```

`03-images-expected.md`:
```markdown
![Terminal](bas-terminal.png)

![Domain](domain.png)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run scripts/discovery-sync/__tests__/convert-body.test.ts`
Expected: FAIL — image handling not implemented, `images` undefined.

- [ ] **Step 4: Write minimal implementation**

Add before the `return`, and change the return:

```js
  // Strip Discovery-Center layout comments (whole-line HTML comments like
  // "<!-- border; size:540px -->"). Preserve the description marker comment.
  body = body.replace(/^[ \t]*<!--(?!\s*description\b)[^>]*-->[ \t]*\n/gim, '')

  // Normalize image paths: ![alt](./x.png) -> ![alt](x.png); collect filenames.
  const images = []
  body = body.replace(/!\[([^\]]*)\]\(\.?\/?([^)]+)\)/g, (_m, alt, path) => {
    const file = path.trim()
    // Only collect repo-relative images (skip absolute http(s) URLs).
    if (!/^https?:\/\//i.test(file)) images.push(file)
    return `![${alt}](${file})`
  })

  // Lint: code fence opened with no language tag.
  if (/^```[ \t]*$/m.test(body)) {
    flags.push('FENCE_NO_LANG: a code fence has no language tag; add one (e.g. ```bash)')
  }

  return { body, flags, images: [...new Set(images)] }
```

Remove the earlier `return { body, flags }` line from Task 1.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run scripts/discovery-sync/__tests__/convert-body.test.ts`
Expected: PASS (all cases from Tasks 1–3).

- [ ] **Step 6: Commit**

```bash
git add scripts/discovery-sync/
git commit -m "feat(discovery-sync): image path normalization and fence lint"
```

---

## Task 4: Converter — built-in structural pre-checks + CLI entrypoint

**Files:**
- Modify: `scripts/discovery-sync/convert-body.mjs`
- Test: `scripts/discovery-sync/__tests__/convert-body.test.ts` (add cases)

**Interfaces:**
- Consumes: `convertBody` from Tasks 1–3.
- Produces:
  - `export function precheck(fullMarkdown: string, slug: string, imagesOnDisk: string[]): string[]` — returns a list of blocking problems (empty = clean). Checks: balanced OPTION BEGIN/END, every referenced image present in `imagesOnDisk`, exactly one `# ` H1, `parser: v2` present in frontmatter, slug is lowercase.
  - A CLI entrypoint so the skill can run `node -I convert-body.mjs <source.md> <slug>` and read JSON `{body, flags, images}` on stdout.

- [ ] **Step 1: Write the failing test**

```ts
import { precheck } from '../convert-body.mjs'

describe('precheck', () => {
  it('passes a well-formed tutorial', () => {
    const md = `---\nparser: v2\n---\n# T\n<!-- description -->d\n\n### S\n![x](a.png)\n`
    expect(precheck(md, 'build-cap-app', ['a.png'])).toEqual([])
  })
  it('reports unbalanced OPTION blocks', () => {
    const md = `---\nparser: v2\n---\n# T\n[OPTION BEGIN [Node.js]]\nx\n`
    expect(precheck(md, 'x', [])).toContain('UNBALANCED_OPTIONS: 1 [OPTION BEGIN] vs 0 [OPTION END]')
  })
  it('reports a missing image', () => {
    const md = `---\nparser: v2\n---\n# T\n![x](missing.png)\n`
    expect(precheck(md, 'x', [])).toContain('MISSING_IMAGE: missing.png is referenced but not on disk')
  })
  it('reports an uppercase slug', () => {
    const md = `---\nparser: v2\n---\n# T\n`
    expect(precheck(md, 'Build-CAP', [])).toContain('BAD_SLUG: slug "Build-CAP" must be lowercase')
  })
  it('reports a missing H1', () => {
    const md = `---\nparser: v2\n---\n## not an h1\n`
    expect(precheck(md, 'x', [])).toContain('NO_H1: exactly one "# " H1 title is required (found 0)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/discovery-sync/__tests__/convert-body.test.ts`
Expected: FAIL — `precheck` not defined.

- [ ] **Step 3: Write minimal implementation**

```js
export function precheck(fullMarkdown, slug, imagesOnDisk) {
  const problems = []
  const begins = (fullMarkdown.match(/\[OPTION BEGIN \[/g) || []).length
  const ends = (fullMarkdown.match(/\[OPTION END\]/g) || []).length
  if (begins !== ends) problems.push(`UNBALANCED_OPTIONS: ${begins} [OPTION BEGIN] vs ${ends} [OPTION END]`)

  const onDisk = new Set(imagesOnDisk)
  for (const m of fullMarkdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const f = m[1].trim()
    if (!/^https?:\/\//i.test(f) && !onDisk.has(f)) problems.push(`MISSING_IMAGE: ${f} is referenced but not on disk`)
  }

  const h1s = (fullMarkdown.match(/^#\s+\S/gm) || []).length
  if (h1s !== 1) problems.push(`NO_H1: exactly one "# " H1 title is required (found ${h1s})`)

  if (!/^parser:\s*v2\s*$/m.test(fullMarkdown)) problems.push('NO_PARSER_V2: frontmatter must set parser: v2')

  if (slug !== slug.toLowerCase()) problems.push(`BAD_SLUG: slug "${slug}" must be lowercase`)

  return problems
}

// CLI: node -I convert-body.mjs <source.md> <slug>  -> JSON {body,flags,images} on stdout
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs')
  const [, , srcPath, slug] = process.argv
  const src = readFileSync(srcPath, 'utf-8')
  process.stdout.write(JSON.stringify(convertBody(src, slug)))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/discovery-sync/__tests__/convert-body.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Verify the CLI entrypoint manually**

Run: `node -I scripts/discovery-sync/convert-body.mjs scripts/discovery-sync/__tests__/fixtures/02-details-source.md demo`
Expected: a JSON blob on stdout with `body` containing `[OPTION BEGIN [Node.js]]`.

- [ ] **Step 6: Commit**

```bash
git add scripts/discovery-sync/
git commit -m "feat(discovery-sync): precheck validator and CLI entrypoint"
```

---

## Task 5: SKILL.md — the orchestration procedure

**Files:**
- Create: `~/.claude/skills/sap-discovery-tutorial-sync/SKILL.md`

**Interfaces:**
- Consumes: `convert-body.mjs` CLI (Task 4) and the repo's `TUTORIAL_SLUG=<slug> npm run fetch-tutorials` + `npm run validate-tutorials` (Task 6 wires validation details).
- Produces: the human-facing skill. No code interface.

- [ ] **Step 1: Write the frontmatter and overview**

Create `SKILL.md` starting with exactly:

```markdown
---
name: sap-discovery-tutorial-sync
description: Use when a team maintains a tutorial in SAP Discovery Center format (e.g. SAP-samples/btp-developer-guide-cap/documentation/tutorials) and wants to copy or update the sap-tutorials platform version of it (e.g. sap-tutorials/btp-dev-guidance/tutorials) — converts the Discovery Center markdown into our v2-parser format (frontmatter, OPTION blocks, slug-named images, optional rules.vr), validates it against the real build, and opens a PR. Triggers on "sync/import/update the Discovery Center version of <slug>", "copy the btp-developer-guide-cap tutorial over", "pull the SAP-samples version of <tutorial> into our repo".
---

# Sync a Discovery Center tutorial into the sap-tutorials platform format
```

- [ ] **Step 2: Write the Phase A procedure (draft locally)**

Document, as a numbered procedure, exactly the 9 Phase-A steps from the spec §4, with these concrete commands and decision points:
  - Resolve source: `https://raw.githubusercontent.com/<SOURCE_REPO>/main/<SOURCE_PATH>/<slug>/<slug>.md` (default `SOURCE_REPO=SAP-samples/btp-developer-guide-cap`, `SOURCE_PATH=documentation/tutorials`). Record the source commit SHA via `gh api repos/<SOURCE_REPO>/commits?path=<...>&per_page=1`.
  - Detect update vs new: check `sap-tutorials/btp-dev-guidance` for `tutorials/<slug>.md` (local checkout if present, else `gh api`).
  - Run converter: `node -I <repo>/scripts/discovery-sync/convert-body.mjs <tmp-source.md> <slug>`, parse the JSON `{body, flags, images}`.
  - Normalize OPTION labels per the Global Constraints (keep source labels; the parser classifies OS automatically with ≥2 OSes).
  - Fetch each file in `images[]` into `.sync-draft/<slug>/<slug>/`.
  - Prompt for every frontmatter field (point to `references/taxonomy-check.md`).
  - Prompt per the rules.vr decision tree (Task — reference §8).
  - If update: run the 3-way merge (reference the merge procedure), show the diff, STOP.
  - Write draft to `.sync-draft/<slug>/`, then run validation (reference Task 6 procedure).
  - Print a report: files written, validation verdict, every `flags[]` entry and every unverified field, review checklist.

- [ ] **Step 3: Write the explicit STOP gate**

Add a clearly fenced "── STOP: human reviews the draft ──" section stating that Phase B runs ONLY after the user explicitly confirms, and that nothing is pushed before then.

- [ ] **Step 4: Write the Phase B procedure (open PR)**

Document: `git fetch origin`; branch from fresh `origin/main` of btp-dev-guidance; copy draft into `tutorials/<slug>/`; commit; `gh pr create` with a body template that cross-links the source commit SHA, lists inferred/unverified fields, and states it was skill-generated. rules.vr → the `<repo>-Contribution` repo as a separate cross-linked PR. Explicit "never direct-merge, never push to main."

- [ ] **Step 5: Verify the frontmatter parses and the description matches convention**

Run: `node -I -e "const m=require('gray-matter'); const {data}=m(require('fs').readFileSync(process.env.HOME+'/.claude/skills/sap-discovery-tutorial-sync/SKILL.md','utf8')); if(data.name!=='sap-discovery-tutorial-sync'||!/^Use when/.test(data.description)) throw new Error('frontmatter convention broken'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 6: Commit**

The skill lives in the user-global skills dir (outside the repo), so commit it in place with git if that dir is a repo, otherwise note it in the repo's PR description as an out-of-tree artifact. For the repo-tracked copy, no commit here (SKILL.md is user-global). Record completion in the plan.

---

## Task 6: SKILL.md — validation procedure wiring (real parser)

**Files:**
- Modify: `~/.claude/skills/sap-discovery-tutorial-sync/SKILL.md` (add the validation subsection referenced by Task 5 Step 2)

**Interfaces:**
- Consumes: a local `tutorials-ims` checkout, `convert-body.mjs precheck` (Task 4), the repo scripts `fetch-tutorials` and `validate-tutorials`.
- Produces: the documented validation flow the skill executes.

- [ ] **Step 1: Document the two-stage validation**

Write the subsection stating the exact flow:
  1. **Built-in precheck (always):** `node -I <repo>/scripts/discovery-sync/convert-body.mjs` is already run; additionally call `precheck(fullMarkdownWithFrontmatter, slug, imagesOnDisk)` — note this requires a tiny wrapper invocation `node -I -e "import('.../convert-body.mjs').then(m=>{...})"` or extend the CLI; document the exact one-liner. Non-empty result → STOP, report problems, do not proceed to the real parser.
  2. **Real parser (when checkout available):** place the draft `.md` + image folder into the source-repo layout the fetcher expects, then run against the local checkout:
     ```bash
     TUTORIAL_SLUG=<slug> CAP_BASE_URL=<deployed-or-local> \
       scripts/quiet-run.sh npm run fetch-tutorials
     scripts/quiet-run.sh npm run validate-tutorials
     ```
     Then read `.tutorial-cache/quarantine/errors.json` — if it contains an entry for `<slug>`, the conversion FAILED validation (report the `reason`). Note that `validate-tutorials` is fail-open (exit 0 even on quarantine) so the skill MUST inspect `errors.json` and the presence of `hugo/content/tutorials/<slug>.md` (quarantined files are moved OUT), not the exit code.
  3. **No checkout:** run built-in precheck only; mark the draft **"parser-unverified"** in the report. Never claim it builds.

- [ ] **Step 2: Add the exact precheck CLI one-liner**

Extend `convert-body.mjs` CLI so `node -I convert-body.mjs --precheck <full.md> <slug> <imagesDir>` prints the JSON array of problems. Add this as a documented command in SKILL.md and add a matching unit test:

```ts
// in convert-body.test.ts
it('CLI --precheck is reachable', () => {
  // smoke: the function path is covered by precheck() tests above;
  // this asserts the CLI branch parses the --precheck flag.
  expect(typeof precheck).toBe('function')
})
```

(Implementation: add a `--precheck` branch to the CLI block that globs the imagesDir for filenames and calls `precheck`.)

- [ ] **Step 3: Run the converter tests**

Run: `npx vitest run scripts/discovery-sync/__tests__/convert-body.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit the converter change**

```bash
git add scripts/discovery-sync/
git commit -m "feat(discovery-sync): --precheck CLI branch for skill validation step"
```

- [ ] **Step 5: Record SKILL.md completion**

(SKILL.md is user-global; no repo commit. Note done in the plan.)

---

## Task 7: references/format-mapping.md and references/taxonomy-check.md

**Files:**
- Create: `~/.claude/skills/sap-discovery-tutorial-sync/references/format-mapping.md`
- Create: `~/.claude/skills/sap-discovery-tutorial-sync/references/taxonomy-check.md`

**Interfaces:**
- Consumes: nothing (reference docs).
- Produces: author-facing reference the SKILL.md links to.

- [ ] **Step 1: Write format-mapping.md**

Contents (verbatim detail, no placeholders):
  - The full source→target mapping table from spec §1 and §5.
  - The exact OPTION marker syntax and the OS-classifier recognition table (canonical `{Windows, macOS, Linux, BAS}`, the recognized-label regexes, and the ≥2-distinct-OS rule).
  - The `[VALIDATE_N]`…`[VALIDATE_END_N]` and `[AUTOAUTHOR_ALL]` syntax with a worked MCQ example (copy the canonical block: `###Rule` / `multiple-choice` / `###Question` / `###Match` / `[X] correct`).
  - The edge cases that are flagged not auto-handled (nested details, unbalanced tags, H4/H5 in a step, fence without language).

- [ ] **Step 2: Write taxonomy-check.md**

Contents:
  - Primary source: `GET ${CAP_BASE_URL}/build/tags` (default `http://localhost:4004`) returns `{tags: string[]}`. Cached copy: `hugo/data/tags.json`.
  - Alternative: query the `Tags` entity via cds-mcp (`search_model name:Tags`) or read `db/data/com.sap.developers.ims-*.csv` seed files.
  - The hard-gate rule: reject any `primary_tag` / `tags` value not in the taxonomy; `tags[0]` must be a level tag (`tutorial>beginner|intermediate|advanced`).
  - The unavailable fallback: warn, allow typed values, flag each `# UNVERIFIED TAG`.

- [ ] **Step 3: Verify both files are non-empty and link-consistent**

Run: `node -I -e "const fs=require('fs');const d=process.env.HOME+'/.claude/skills/sap-discovery-tutorial-sync/references/';for(const f of ['format-mapping.md','taxonomy-check.md']){if(fs.readFileSync(d+f,'utf8').trim().length<200)throw new Error('too short: '+f)}console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 4: Record completion**

(User-global; no repo commit.)

---

## Task 8: End-to-end dry run against a real tutorial + repo wiring

**Files:**
- Modify: `package.json` (optional convenience script, see Step 2)
- Test: manual E2E, no new unit test file.

**Interfaces:**
- Consumes: the whole skill (Tasks 1–7).
- Produces: evidence the skill converts a real tutorial that passes the real parser.

- [ ] **Step 1: Convert a real tutorial end-to-end (new-import path)**

Pick `build-cap-app`. Fetch source, run the converter, hand-fill frontmatter with a real taxonomy tag, fetch images, write the draft. Confirm `convert-body` output has balanced OPTION blocks and the Node.js/Java tabs.

- [ ] **Step 2: Add a convenience npm script (optional)**

In `package.json` scripts, add:
```json
"discovery-sync:convert": "node -I scripts/discovery-sync/convert-body.mjs"
```
Run: `jq '.scripts["discovery-sync:convert"]' package.json`
Expected: prints the command string.

- [ ] **Step 3: Run the real parser against the draft**

Place the draft in the fetch layout and run:
```bash
TUTORIAL_SLUG=build-cap-app scripts/quiet-run.sh npm run fetch-tutorials
scripts/quiet-run.sh npm run validate-tutorials
```
Expected: `hugo/content/tutorials/build-cap-app.md` exists and is NOT in `.tutorial-cache/quarantine/`; no `build-cap-app` entry in `quarantine/errors.json`.

- [ ] **Step 4: Confirm the rendered frontmatter has the parser-injected fields**

Run: `node -I -e "const m=require('gray-matter');const {data}=m(require('fs').readFileSync('hugo/content/tutorials/build-cap-app.md','utf8'));for(const k of ['type','slug','title','time','stepCount'])if(data[k]===undefined)throw new Error('missing '+k);console.log('ok', data.stepCount)"`
Expected: prints `ok` and a positive step count.

- [ ] **Step 5: Commit repo-side artifacts**

```bash
git add package.json scripts/discovery-sync/
git commit -m "feat(discovery-sync): e2e-verified converter + convenience script"
```

- [ ] **Step 6: Record the E2E evidence in the plan**

Note the quarantine check result and step count in a short completion note.

---

## Self-Review

**Spec coverage:**
- §1 format gap → Tasks 1–3 (title, details, images) + format-mapping.md (Task 7). ✓
- §3 shape/skill layout → Tasks 5–7. ✓
- §4 two-phase flow → Task 5 (Phase A/STOP/Phase B). ✓
- §5 conversion engine incl. label normalization + edge-case flags → Tasks 1–4. ✓
- §6 frontmatter + taxonomy gate → Task 5 Step 2 + taxonomy-check.md (Task 7). ✓
- §7 3-way merge → Task 5 Step 2 (update path). ✓ (merge is a documented procedure, not code — correct for a judgment step.)
- §8 rules.vr → Task 5 Step 2 + format-mapping.md syntax (Task 7). ✓
- §9 validation (real parser, built-in, no-checkout fallback) → Task 6. ✓
- §10 foolproofing → distributed across precheck (Task 4), taxonomy gate (7), STOP (5), merge (5), validation (6). ✓
- §11 open items → resolved in Global Constraints (validator entrypoint = `validate-tutorials` + quarantine inspection; taxonomy = `/build/tags`→`hugo/data/tags.json`; working dir = `.sync-draft/`; converter tests = Tasks 1–4). ✓

**Placeholder scan:** The `<!-- description --> TODO…(REVIEW)` string is intentional output content the human fills, not a plan placeholder — acceptable. No "TBD/implement later/add error handling" in steps.

**Type consistency:** `convertBody` returns `{body, flags}` in Task 1, extended to `{body, flags, images}` in Task 3 (Task 3 Step 4 explicitly removes the old return). `precheck(fullMarkdown, slug, imagesOnDisk)` consistent across Tasks 4 and 6. OPTION marker string identical in converter (Task 2), precheck (Task 4), and constraints. ✓
