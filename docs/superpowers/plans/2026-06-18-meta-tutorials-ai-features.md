# Meta-Tutorials Showcase for AI Features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a 4-tutorial mission ("Tutorial Platform Features for Authors") to developers.sap.com that demonstrates the platform's recent AI features (code-check, free-text grader, AI-authored quizzes) and other new authoring syntax (OS-conditional content, branched tutorials, mermaid, codetabs, glossary, lightbox), sourced from a new `tutorials/` folder in `sap-tutorials/meta-tutorials` plus a new `sap-tutorials/meta-tutorials-Contribution` repo for `rules.vr` files. The mission is registered post-publish via `/admin-ui/#missions-display`.

**Architecture:** A one-line change in `tutorials-ims/scripts/parsers/github.ts` (remove `'meta-tutorials'` from `EXCLUDED_REPOS`) lets the existing discovery + fetch + Hugo + publish pipeline pick up the new content with no new code. Discovery already only reads each repo's `tutorials/<slug>/` subtree, so no path-prefix filter is needed. Three repos change: tutorials-ims (the github.ts change + a unit test pinning the contract + a "Live examples" callout in writing-tutorials.md), meta-tutorials (4 tutorial folders), and a new meta-tutorials-Contribution (3 rules.vr files). One post-publish admin step registers the mission.

**Tech Stack:** Node.js 20, TypeScript, Vitest, Hugo, GitHub (gh CLI), CAP backend (already deployed; no changes), `@sap-tutorials/*` repos, BTP admin UI.

**Spec:** [`docs/superpowers/specs/2026-06-18-meta-tutorials-ai-features-design.md`](../specs/2026-06-18-meta-tutorials-ai-features-design.md)

**Tracking issue:** [sap-tutorials/tutorials-ims#382](https://github.com/sap-tutorials/tutorials-ims/issues/382)

**Branch (tutorials-ims):** `feat/meta-tutorials-showcase` (already created; spec already committed)

---

## File Structure

### tutorials-ims (this repo)

| File | Action | Responsibility |
|------|--------|----------------|
| [scripts/parsers/github.ts](../../../scripts/parsers/github.ts) (line 25) | Modify (1 line) | Remove `'meta-tutorials'` from `EXCLUDED_REPOS` |
| `scripts/parsers/__tests__/github.test.ts` | Create | Unit test pinning the discovery contract for `meta-tutorials` |
| [docs/authors/writing-tutorials.md](../../authors/writing-tutorials.md) | Modify | Add "Live examples" callout at top of §3 |

### sap-tutorials/meta-tutorials (separate repo at `D:\projects\meta-tutorials`)

| File | Action | Responsibility |
|------|--------|----------------|
| `tutorials/use-codecheck-to-ai-grade-reader-code/use-codecheck-to-ai-grade-reader-code.md` | Create | Tutorial 1 (CODECHECK demo) |
| `tutorials/use-codecheck-to-ai-grade-reader-code/001-rules-vr-overview.png` | Create | Image asset |
| `tutorials/use-codecheck-to-ai-grade-reader-code/002-codecheck-grading-result.png` | Create | Image asset |
| `tutorials/use-validate-to-ai-grade-free-text-answers/use-validate-to-ai-grade-free-text-answers.md` | Create | Tutorial 2 (free-text grader) |
| `tutorials/use-validate-to-ai-grade-free-text-answers/001-text-answer-feedback.png` | Create | Image asset |
| `tutorials/use-autoauthor-to-generate-quiz-questions/use-autoauthor-to-generate-quiz-questions.md` | Create | Tutorial 3 (AUTOAUTHOR demo) |
| `tutorials/use-autoauthor-to-generate-quiz-questions/001-build-time-generation.png` | Create | Image asset |
| `tutorials/tutorial-platform-feature-cookbook/tutorial-platform-feature-cookbook.md` | Create | Tutorial 4 (cookbook of non-AI new syntax) |

### sap-tutorials/meta-tutorials-Contribution (NEW separate repo, to be created)

| File | Action | Responsibility |
|------|--------|----------------|
| `LICENSE` (or REUSE.toml) | Create | Match existing `*-Contribution` repos |
| `README.md` | Create | One-paragraph intro |
| `tutorials/use-codecheck-to-ai-grade-reader-code/rules.vr` | Create | `[CODECHECK_4]` block |
| `tutorials/use-validate-to-ai-grade-free-text-answers/rules.vr` | Create | text-style `[VALIDATE_4]` block |
| `tutorials/use-autoauthor-to-generate-quiz-questions/rules.vr` | Create | `[AUTOAUTHOR_4:mcq]` + `[AUTOAUTHOR_5:text]` directives |

---

## Task Decomposition

The plan unfolds in 6 phases. Each phase produces working, testable software. Within each phase, tasks are 2-5 minute steps.

- **Phase A — tutorials-ims pipeline change** (work in `d:/projects/tutorials-poc` on branch `feat/meta-tutorials-showcase`)
- **Phase B — Tutorial markdown authoring** (work in `D:/projects/meta-tutorials`, new branch)
- **Phase C — Contribution repo + rules.vr** (work in a NEW `D:/projects/meta-tutorials-Contribution` clone)
- **Phase D — PRs and merges** (gh CLI; coordinate with Tom)
- **Phase E — Live deploy validation**
- **Phase F — Post-publish: mission registration + writing-tutorials.md callout merge**

---

## Phase A — tutorials-ims pipeline change

### Task A1: Add discovery-contract unit test (failing)

**Files:**
- Create: `scripts/parsers/__tests__/github.test.ts`

The test stubs the GraphQL/REST clients and asserts that with `EXCLUDED_REPOS` containing only `'tutorials-ims'`, a fixture repo named `meta-tutorials` whose `HEAD:tutorials` tree contains two subdirectories yields exactly two `DiscoveredTutorial` entries — and that a sibling root file `run-book/foo.md` is NOT enumerated. The test will FAIL until Task A2 lands the EXCLUDED_REPOS change.

Look at `scripts/parsers/__tests__/branches.test.ts` for the project's vitest convention. Read [scripts/parsers/github.ts:380-460](../../../scripts/parsers/github.ts#L380-L460) to confirm the exact GraphQL function name and signature you need to stub.

- [ ] **Step 1: Read the existing discovery code** to see how to mock the GraphQL/REST clients.

```bash
cd d:/projects/tutorials-poc
sed -n '380,460p' scripts/parsers/github.ts
```

Note the function names you need to test (`discoverFromGraphql` and `discoverFromRest`) and how they obtain `repos` data (`graphqlRequest` for one, `restApiPaginated`/`restApiRequest` for the other). The test will need to mock these.

- [ ] **Step 2: Write the failing test**

Create `scripts/parsers/__tests__/github.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('discovery — meta-tutorials inclusion (#382)', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.GITHUB_TOKEN
    delete process.env.TUTORIALS_GITHUB_TOKEN
    delete process.env.INCLUDE_CONTRIBUTION_REPOS
    delete process.env.ONLY_CONTRIBUTION_REPOS
  })

  it('discoverFromGraphql enumerates meta-tutorials/tutorials/<slug> dirs and ignores siblings', async () => {
    // Mock graphqlRequest before importing github.ts so the module-level
    // import binding picks up the spy.
    vi.doMock('../graphql.js', () => ({
      graphqlRequest: vi.fn().mockResolvedValueOnce({
        organization: {
          repositories: {
            nodes: [
              {
                name: 'meta-tutorials',
                isArchived: false,
                isDisabled: false,
                isFork: false,
                defaultBranchRef: { name: 'main' },
                tutorials: {
                  entries: [
                    { name: 'use-codecheck-to-ai-grade-reader-code', type: 'tree' },
                    { name: 'use-validate-to-ai-grade-free-text-answers', type: 'tree' },
                    // sibling-style stray files — discovery should ignore them
                    { name: 'README.md', type: 'blob' },
                  ],
                },
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
          rateLimit: { cost: 1, remaining: 4999, limit: 5000, resetAt: '2026-06-18T00:00:00Z' },
        },
      }),
      Transient5xxError: class {},
    }))

    const { discoverFromGraphql } = await import('../github.js')
    const result = await discoverFromGraphql()

    expect(result.map(t => t.slug).sort()).toEqual([
      'use-codecheck-to-ai-grade-reader-code',
      'use-validate-to-ai-grade-free-text-answers',
    ])
    // Verify that no entry resembles a non-tutorial sibling dir
    expect(result.find(t => t.slug === 'run-book')).toBeUndefined()
    expect(result.find(t => t.slug === 'README.md')).toBeUndefined()
    // The repo column should always be 'meta-tutorials' for this fixture
    expect(result.every(t => t.repo === 'meta-tutorials')).toBe(true)
  })

  it('EXCLUDED_REPOS still skips tutorials-ims itself', async () => {
    // Sanity check: the one remaining excluded repo is honored. Add a second
    // repo named 'tutorials-ims' to the fixture; expect zero discoveries.
    vi.doMock('../graphql.js', () => ({
      graphqlRequest: vi.fn().mockResolvedValueOnce({
        organization: {
          repositories: {
            nodes: [
              {
                name: 'tutorials-ims',
                isArchived: false,
                isDisabled: false,
                isFork: false,
                defaultBranchRef: { name: 'main' },
                tutorials: { entries: [{ name: 'whatever', type: 'tree' }] },
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
          rateLimit: { cost: 1, remaining: 4999, limit: 5000, resetAt: '2026-06-18T00:00:00Z' },
        },
      }),
      Transient5xxError: class {},
    }))

    const { discoverFromGraphql } = await import('../github.js')
    const result = await discoverFromGraphql()
    expect(result).toHaveLength(0)
  })
})
```

> **Note for the implementer:** the import path of the GraphQL client (`'../graphql.js'`) and the function name (`graphqlRequest`) need to match what `github.ts` actually imports. Open `github.ts` lines 1-40 to confirm and adjust the `vi.doMock` path. Project uses `.js` import suffix even on `.ts` files (NodeNext module resolution).

- [ ] **Step 3: Run the test to verify it fails on the right reason**

```bash
npx vitest run scripts/parsers/__tests__/github.test.ts
```

Expected: the first test FAILS because `discoverFromGraphql` will currently return 0 entries (since `meta-tutorials` is in `EXCLUDED_REPOS`). The second test should PASS already.

If the test fails for an unrelated reason (e.g. import path wrong, mock not applied), fix the test setup until it fails for the right reason — "expected 2 entries, got 0" — before moving on.

### Task A2: Apply the one-line github.ts change

**Files:**
- Modify: `scripts/parsers/github.ts:25`

- [ ] **Step 1: Make the change**

Open `scripts/parsers/github.ts`. At line 25:

```ts
// Before:
export const EXCLUDED_REPOS = new Set(['tutorials-ims', 'meta-tutorials'])
// After:
export const EXCLUDED_REPOS = new Set(['tutorials-ims'])
```

- [ ] **Step 2: Run the failing test from A1 — it should now pass**

```bash
npx vitest run scripts/parsers/__tests__/github.test.ts
```

Expected: both tests PASS.

- [ ] **Step 3: Run the full unit-test suite to confirm no regression**

```bash
npm test -- --run scripts/
```

Expected: all parser tests pass. (If anything fails unrelated to your change — typically a flaky timing test — note it but don't fix; report at the end of Phase A.)

- [ ] **Step 4: Commit Phase A**

```bash
git add scripts/parsers/github.ts scripts/parsers/__tests__/github.test.ts
git commit -m "feat(parser): include meta-tutorials in discovery (#382)"
```

### Task A3: Update writing-tutorials.md with "Live examples" callout

**Files:**
- Modify: `docs/authors/writing-tutorials.md` (top of §3, around line 41)

The callout points authors at the live demo tutorials so they can copy syntax patterns. Note that the URLs won't resolve until Phase E completes — the callout text should mention they're available after deploy, OR you can hold this commit and apply it in Phase F. **The plan defers it to Phase F** so the docs link to live URLs (avoiding broken-link warnings during VitePress build).

- [ ] **Step 1: Note the file that needs editing in Phase F**

No action needed in Phase A. Move on to Phase B.

---

## Phase B — Tutorial markdown authoring

All work in this phase happens in `D:\projects\meta-tutorials`. Switch CWD before starting.

### Task B1: Branch the meta-tutorials repo

- [ ] **Step 1: cd to the repo, verify clean state, create a branch**

```bash
cd D:/projects/meta-tutorials
git status                       # expect: clean
git fetch origin
git checkout -b feat/ai-features-showcase origin/main
```

- [ ] **Step 2: Create the tutorials/ folder skeleton**

```bash
mkdir -p tutorials/use-codecheck-to-ai-grade-reader-code
mkdir -p tutorials/use-validate-to-ai-grade-free-text-answers
mkdir -p tutorials/use-autoauthor-to-generate-quiz-questions
mkdir -p tutorials/tutorial-platform-feature-cookbook
```

### Task B2: Author Tutorial 1 — `use-codecheck-to-ai-grade-reader-code.md`

**Files:**
- Create: `tutorials/use-codecheck-to-ai-grade-reader-code/use-codecheck-to-ai-grade-reader-code.md`

- [ ] **Step 1: Write the markdown**

Reference the spec §"Tutorial 1" (lines 122-145 of the design doc) for steps. Frontmatter MUST be exact:

```yaml
---
parser: v2
auto_validation: true
primary_tag: tutorial>intermediate
tags: [tutorial>intermediate, software-product>sap-business-technology-platform]
time: 15
author_name: Thomas Jung
author_profile: https://github.com/jung-thomas
---
```

Body shape (5 H3 steps), self-referential subject matter (the tutorial is about the platform's CODECHECK feature, demonstrated on a real CODECHECK against a small CDS-entity reference solution in step 4):

1. **What the `[CODECHECK_N]` directive does** — reader-facing experience description; reference image `001-rules-vr-overview.png` (alt text: "rules.vr file with a CODECHECK block highlighted").
2. **The `rules.vr` block format** — fenced code block (```text) showing the `[CODECHECK_3]` syntax including `###Goal`, `###Language`, `###Hints`, `###ReferenceSolution` headings (canonical shape from [scripts/parsers/codecheck.ts:30-49](../../../scripts/parsers/codecheck.ts#L30-L49)).
3. **A worked example** — narrative walkthrough of authoring a CODECHECK that asks the reader to write a 3-line YAML frontmatter block.
4. **Try it yourself** — the LIVE step. Asks the reader to paste a small CDS entity definition matching:

   ```cds
   entity Books : managed {
     key ID : Integer;
     title  : localized String(111);
   }
   ```

   The companion rules.vr (created in Task C2) carries `[CODECHECK_4]` with a matching reference solution. End the step with `![codecheck grading inline](002-codecheck-grading-result.png)` so the reader knows what to expect.
5. **Enabling code-check on your tutorial** — admin gotcha: `ChatSettings.codeCheckEnabled` must be true. Note rate limits (5/5min per step; 30/hr per user). Cross-link to [center-admin.md](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/authors/center-admin.md) so authors know who to ask.

Do NOT use raw HTML. Avoid `<br>` — use blank lines.

The H1 title and `<!-- description -->` line are required ([writing-tutorials.md §3.2](../../authors/writing-tutorials.md)). Title:

```markdown
# Use [CODECHECK_N] to AI-grade your reader's code
<!-- description -->Add a single block to your rules.vr file and an LLM will grade pasted code against your reference solution — better than exact-match, kinder than no validation at all.

## You will learn
- What the `[CODECHECK_N]` directive does
- How to write the `rules.vr` block
- What good `###Goal` text and `###Hints` look like
- How to enable AI code-check on your tutorial

## Prerequisites
- A tutorial repo under `sap-tutorials` with a matching `*-Contribution` sibling
- Edit access to the contribution repo
- An admin who can flip `ChatSettings.codeCheckEnabled` if it's off
---
```

- [ ] **Step 2: Add placeholder PNGs**

Real screenshots can be captured during Phase E. For now, create 1×1 placeholder images so the build doesn't 404 on missing referenced files:

```bash
# 1x1 transparent PNG: hex 89504e470d0a1a0a... — easier to use a tiny generator.
# If imagemagick is available:
magick -size 1x1 xc:none tutorials/use-codecheck-to-ai-grade-reader-code/001-rules-vr-overview.png
magick -size 1x1 xc:none tutorials/use-codecheck-to-ai-grade-reader-code/002-codecheck-grading-result.png
# Otherwise: cp any tiny existing png from another sap-tutorials repo, or
# omit the image references and add them in Phase E. Adjust the markdown
# accordingly if you choose the latter.
```

The Phase E acceptance criteria call for real screenshots; placeholders are a temporary build-pass measure.

### Task B3: Author Tutorial 2 — `use-validate-to-ai-grade-free-text-answers.md`

**Files:**
- Create: `tutorials/use-validate-to-ai-grade-free-text-answers/use-validate-to-ai-grade-free-text-answers.md`

- [ ] **Step 1: Write the markdown**

Mirror Tutorial 1's frontmatter shape but with `time: 10`. The 5 H3 steps follow spec §"Tutorial 2" (design doc lines 149-161). Step 4 is the LIVE demo asking "In your own words, what's the difference between a *group* and a *mission* in the tutorial system?" — companion rules.vr carries the `[VALIDATE_4]` block.

Free-text grader rules.vr canonical shape (per [scripts/parsers/rules.ts:170-220](../../../scripts/parsers/rules.ts#L170-L220)) is:

```text
[VALIDATE_4]
###Rule
text
###Question
In your own words, what's the difference between a group and a mission in the tutorial system?
###Match
A group is an ordered list of tutorials. A mission is one or more groups arranged into a learning journey, optionally with checkpoint steps and prizes.
###Grading
ai-judged
[VALIDATE_4]
```

Note: `###Grading\nai-judged` is the explicit AI-grading directive ([rules.ts:182-185](../../../scripts/parsers/rules.ts#L182-L185)). The tutorial body should show this exact syntax in a fenced code block in step 2.

H1 title:

```markdown
# Use AI-graded [VALIDATE_N] for free-text answers
<!-- description -->Ask open-ended questions; an LLM grades for correctness, not exact match.
```

Same 5-step shape as Tutorial 1 (intro, syntax, worked example, live demo, criteria best practices).

- [ ] **Step 2: Placeholder image**

```bash
magick -size 1x1 xc:none tutorials/use-validate-to-ai-grade-free-text-answers/001-text-answer-feedback.png
```

### Task B4: Author Tutorial 3 — `use-autoauthor-to-generate-quiz-questions.md`

**Files:**
- Create: `tutorials/use-autoauthor-to-generate-quiz-questions/use-autoauthor-to-generate-quiz-questions.md`

- [ ] **Step 1: Write the markdown**

Spec §"Tutorial 3" (design doc lines 165-180). Six H3 steps; `time: 15`. Steps 4-5 are the LIVE demo — they have substantive content about parser V2 vs legacy V1 (the body the LLM will read to generate questions). Companion rules.vr carries `[AUTOAUTHOR_4:mcq]` and `[AUTOAUTHOR_5:text]` directives.

Step 4 body content (the LLM consumes this to write a question):

```markdown
### Demo: an auto-authored multiple-choice question

The current parser is V2 — it uses H3 headings (`###`) to delimit steps. Each H3 becomes a navigable step in the rendered tutorial. The previous parser, V1, used `[ACCORDION-BEGIN]` / `[ACCORDION-END]` markers to delimit steps. V1 is still supported for legacy content but is not used for new tutorials.

After this build runs with `AI_AUTHOR_ENABLED=true`, you'll see a multiple-choice question below this paragraph generated from this body. The directive that produced it lives in our companion `rules.vr`:

\`\`\`text
[AUTOAUTHOR_4:mcq]
\`\`\`
```

Step 5 body content:

```markdown
### Demo: an auto-authored free-text question

Authors can opt into AI question generation per-step (`[AUTOAUTHOR_N]`) or tutorial-wide (`[AUTOAUTHOR_ALL]`). A type suffix (`:mcq` or `:text`) biases the output. Hand-authored `[VALIDATE_N]` blocks always take precedence — the AI generator skips any step that already has a hand-authored question.

The directive for this step is `[AUTOAUTHOR_5:text]`, so the AI generates a free-text question. The free-text grader (Tutorial 2) then grades the reader's answer.
```

H1 title:

```markdown
# Use [AUTOAUTHOR_*] to generate quiz questions at build time
<!-- description -->Tag a step in your rules.vr with [AUTOAUTHOR_N] and the build pipeline writes the quiz for you, with a per-tutorial cache so subsequent builds cost zero LLM calls.
```

- [ ] **Step 2: Placeholder image**

```bash
magick -size 1x1 xc:none tutorials/use-autoauthor-to-generate-quiz-questions/001-build-time-generation.png
```

### Task B5: Author Tutorial 4 — `tutorial-platform-feature-cookbook.md`

**Files:**
- Create: `tutorials/tutorial-platform-feature-cookbook/tutorial-platform-feature-cookbook.md`

- [ ] **Step 1: Write the markdown**

Spec §"Tutorial 4" (design doc lines 184-198). Eight H3 steps; `time: 20`; `auto_validation: false`. The cookbook's body IS the demo — every step both teaches the syntax AND uses it. Step 1 has actual `[OPTION BEGIN [Windows]]` blocks; step 3 has actual `[BRANCH_BEGIN ...]` markers; etc.

Frontmatter:

```yaml
---
parser: v2
auto_validation: false
primary_tag: tutorial>intermediate
tags: [tutorial>intermediate, software-product>sap-business-technology-platform]
time: 20
author_name: Thomas Jung
author_profile: https://github.com/jung-thomas
---
```

Body — 8 H3 steps. The exact mappings of the spec's step-by-step content guidance go in here:

1. `### OS-conditional content` — `[OPTION BEGIN [Windows]] / [OPTION BEGIN [Mac and Linux]]` for the step body. Add the planner's note from spec §"Tutorial 4" step 2 distinguishing OS-keyword labels (auto-wired to global picker) from generic labels (per-step tabs).
2. `### Generic option blocks` — `[OPTION BEGIN [JSON]] / [OPTION BEGIN [XML]]`.
3. `### Branched tutorials with [BRANCH_BEGIN ...]` — actual `[BRANCH_BEGIN group="deployment" key="hana" label="HANA Cloud"]` ... `[BRANCH_END]` + `[BRANCH_BEGIN group="deployment" key="postgres" label="PostgreSQL"]` ... `[BRANCH_END]`. Cross-link to [branched-tutorials.md](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/authors/branched-tutorials.md).
4. `### Skip-runs with skipIf` — explain the per-step frontmatter HTML-comment syntax. Single-tutorial context can only show syntax, not the live skip behavior.
5. `### Mermaid diagrams` — uses `{{< mermaid >}}` shortcode. Show a small flowchart.
6. `### Codetabs (multi-language code blocks)` — multiple sequential code fences with different languages (`js`, `ts`, `cds`) demonstrating cross-block sync.
7. `### Glossary tooltips` — write a sentence with first-mention of CDS, CAP, BTP and explain that hovering will reveal a popover.
8. `### Lightbox on images` — embed any one image (a screenshot of the tutorial-rendered cookbook itself, captured in Phase E) and explain the lightbox UX.

Final intro paragraph (top of the file, between H1 and the first `## You will learn`):

```markdown
> **A note on maintenance:** this tutorial is a living example of the platform's authoring syntax. If you spot drift between the syntax shown here and what's documented in `docs/authors/writing-tutorials.md`, treat the docs as the source of truth and open an issue.
```

### Task B6: Build the meta-tutorials work locally for syntax check

**Files:** none modified — this validates the markdown.

- [ ] **Step 1: Switch back to tutorials-poc to run a local fetch + Hugo build**

```bash
cd d:/projects/tutorials-poc
```

- [ ] **Step 2: Force a re-fetch** so the new `meta-tutorials/tutorials/*` content is pulled

The fetch path uses raw.githubusercontent.com on the named branch — it will NOT pick up an unpushed local branch in `D:\projects\meta-tutorials`. So either:

(a) Push your `feat/ai-features-showcase` branch to GitHub and set `TUTORIAL_BRANCH_OVERRIDE` env var (NOT supported by the current pipeline), OR
(b) Push to a dedicated test branch on `meta-tutorials` and temporarily change the discovery default-branch reference, OR
(c) Skip remote-fetch validation here and rely on Phase E's deployed-DEV smoke test.

The pragmatic choice is **(c)** — push the meta-tutorials PR to its own branch, open a draft PR, but do NOT merge until Phase A's `tutorials-ims` PR is also ready. Phase D coordinates merges so the first deployed CI run picks up everything atomically.

Document this in the meta-tutorials PR description: "do not merge before tutorials-ims#382 PR is ready to merge."

For local syntax-checking, instead use **Hugo standalone** on the markdown by copying it into `d:/projects/tutorials-poc/.tutorial-cache/`:

```bash
# Copy the raw markdown into tutorials-poc's cache so Hugo can render it locally
mkdir -p d:/projects/tutorials-poc/.tutorial-cache
for slug in use-codecheck-to-ai-grade-reader-code use-validate-to-ai-grade-free-text-answers use-autoauthor-to-generate-quiz-questions tutorial-platform-feature-cookbook; do
  cp "D:/projects/meta-tutorials/tutorials/$slug/$slug.md" "d:/projects/tutorials-poc/.tutorial-cache/$slug.md"
done
# Run the markdown linter
cd d:/projects/tutorials-poc
npm run lint:tutorial-markdown -- --slugs use-codecheck-to-ai-grade-reader-code,use-validate-to-ai-grade-free-text-answers,use-autoauthor-to-generate-quiz-questions,tutorial-platform-feature-cookbook
```

Expected: no `severity: error` items in the report. Warnings are OK to ship; errors must be fixed.

> **If the `--slugs` flag isn't supported by `lint:tutorial-markdown`** (run `npx tsx scripts/lint-tutorial-markdown.ts --help` to check), simply run the linter on the entire cache and grep for the new slugs in the report.

- [ ] **Step 3: Commit Phase B in the meta-tutorials repo**

```bash
cd D:/projects/meta-tutorials
git status                # confirm only tutorials/ folder is staged
git add tutorials/
git commit -m "feat: add tutorial-platform-features mission tutorials (sap-tutorials/tutorials-ims#382)"
```

---

## Phase C — Contribution repo + rules.vr files

### Task C1: Create the meta-tutorials-Contribution repo

**Files:** the entire new repo.

This is a privileged step — only org admins can create repos under `sap-tutorials`. Tom likely has rights via OSPO membership (per [run-book.md](https://github.com/sap-tutorials/meta-tutorials/blob/main/run-book/run-book.md)).

- [ ] **Step 1: Create the new repo via gh CLI**

```bash
gh repo create sap-tutorials/meta-tutorials-Contribution --private --add-readme --license MIT
```

If `--license MIT` doesn't match what other `*-Contribution` repos use, swap it for the correct SPDX identifier. Check by: `gh repo view sap-tutorials/abap-core-development-Contribution --json licenseInfo`.

- [ ] **Step 2: Clone locally**

```bash
cd D:/projects
gh repo clone sap-tutorials/meta-tutorials-Contribution
cd meta-tutorials-Contribution
git checkout -b feat/initial-tutorials-rules
```

- [ ] **Step 3: Create the folder skeleton**

```bash
mkdir -p tutorials/use-codecheck-to-ai-grade-reader-code
mkdir -p tutorials/use-validate-to-ai-grade-free-text-answers
mkdir -p tutorials/use-autoauthor-to-generate-quiz-questions
```

(The cookbook has `auto_validation: false` and no rules.vr.)

### Task C2: Author rules.vr for Tutorial 1 (CODECHECK)

**Files:**
- Create: `tutorials/use-codecheck-to-ai-grade-reader-code/rules.vr`

- [ ] **Step 1: Write the file**

```text
[CODECHECK_4]
###Goal
The reader writes a CDS entity definition with three required parts: an aspect (`: managed`), a key field of type Integer named ID, and a localized String title field with a length annotation. Verify that all three are present and the entity is named Books.

###Language
cds

###Hints
- The aspect comes after the entity name, separated by a colon
- Use the `key` keyword on the ID field
- The title field uses the `localized` keyword

###ReferenceSolution
entity Books : managed {
  key ID : Integer;
  title  : localized String(111);
}
```

This matches the syntax in [scripts/parsers/codecheck.ts:30-49](../../../scripts/parsers/codecheck.ts#L30-L49).

### Task C3: Author rules.vr for Tutorial 2 (free-text VALIDATE)

**Files:**
- Create: `tutorials/use-validate-to-ai-grade-free-text-answers/rules.vr`

- [ ] **Step 1: Write the file**

```text
[VALIDATE_4]
###Rule
text
###Question
In your own words, what's the difference between a group and a mission in the tutorial system?
###Match
A group is an ordered list of tutorials. A mission is one or more groups arranged into a learning journey, optionally including checkpoint steps and prize associations. The mission is the higher-level construct.
###Grading
ai-judged
[VALIDATE_4]
```

### Task C4: Author rules.vr for Tutorial 3 (AUTOAUTHOR)

**Files:**
- Create: `tutorials/use-autoauthor-to-generate-quiz-questions/rules.vr`

- [ ] **Step 1: Write the file**

```text
[AUTOAUTHOR_4:mcq]
[AUTOAUTHOR_5:text]
```

That's the complete file. The build pipeline reads the directives and generates the question content from the tutorial step body at build time (see [scripts/parsers/__tests__/rules-autoauthor.test.ts](../../../scripts/parsers/__tests__/rules-autoauthor.test.ts) for the directive grammar).

### Task C5: README and commit

- [ ] **Step 1: Add a brief README**

```bash
cat > README.md <<'EOF'
# meta-tutorials-Contribution

Validation companion repo for [`sap-tutorials/meta-tutorials`](https://github.com/sap-tutorials/meta-tutorials).

This repo holds `rules.vr` files for tutorials in the meta-tutorials repo's `tutorials/` folder. The platform fetches these at build time alongside the public markdown source.

See [`docs/authors/writing-tutorials.md`](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/authors/writing-tutorials.md) for the rules.vr authoring guide.
EOF
```

- [ ] **Step 2: Commit and push**

```bash
git add .
git commit -m "feat: add rules.vr for tutorial-platform-features mission (sap-tutorials/tutorials-ims#382)"
git push -u origin feat/initial-tutorials-rules
```

---

## Phase D — PRs and merges

### Task D1: Open the tutorials-ims PR

- [ ] **Step 1: Push the local branch**

```bash
cd d:/projects/tutorials-poc
git push -u origin feat/meta-tutorials-showcase
```

- [ ] **Step 2: Open the PR via gh**

```bash
gh pr create \
  --title "feat: include meta-tutorials in discovery for AI-features showcase mission (#382)" \
  --body "$(cat <<'EOF'
Implements design [docs/superpowers/specs/2026-06-18-meta-tutorials-ai-features-design.md](docs/superpowers/specs/2026-06-18-meta-tutorials-ai-features-design.md).

## What

- Removes \`'meta-tutorials'\` from \`EXCLUDED_REPOS\` in \`scripts/parsers/github.ts\` so the new \`tutorials/\` folder in that repo participates in the build pipeline.
- Adds a unit test pinning the discovery contract: meta-tutorials sub-directories under \`tutorials/\` are enumerated; sibling content (run-book, README) is invisible to the discovery layer regardless.
- Spec doc.

## Sibling PRs (must merge first)

- sap-tutorials/meta-tutorials: tutorial markdown + images
- sap-tutorials/meta-tutorials-Contribution: \`rules.vr\` files

## Live deploy validation history

(filled in during Phase E)

Closes #382.
EOF
)"
```

### Task D2: Open the meta-tutorials PR

```bash
cd D:/projects/meta-tutorials
git push -u origin feat/ai-features-showcase
gh pr create \
  --title "feat: add tutorial-platform-features mission tutorials (sap-tutorials/tutorials-ims#382)" \
  --body "Adds 4 tutorials under \`tutorials/\` demonstrating the platform's recent AI features and new authoring syntax. Sibling PR: sap-tutorials/meta-tutorials-Contribution (rules.vr files). Coordinator PR: sap-tutorials/tutorials-ims#382. Do not merge before the tutorials-ims PR is ready."
```

### Task D3: Open the meta-tutorials-Contribution PR

```bash
cd D:/projects/meta-tutorials-Contribution
gh pr create \
  --title "feat: initial rules.vr files for tutorial-platform-features mission (sap-tutorials/tutorials-ims#382)" \
  --body "Validation companion files for the meta-tutorials mission. See sap-tutorials/tutorials-ims#382."
```

### Task D4: Coordinate merges (manual gate — Tom's call)

- [ ] **Step 1: Surface the three PR URLs to Tom for review**

Print all three PR URLs and ask:

> "Three PRs ready. Recommended merge order: meta-tutorials-Contribution → meta-tutorials → tutorials-ims. Each is independently safe (no live deploy until tutorials-ims merges and CI runs). Confirm before I merge?"

- [ ] **Step 2: After Tom's go-ahead, merge in order**

```bash
gh pr merge <meta-tutorials-Contribution-PR-url> --squash --delete-branch
gh pr merge <meta-tutorials-PR-url> --squash --delete-branch
gh pr merge <tutorials-ims-PR-url> --squash --delete-branch
```

The `tutorials-ims` merge triggers the CI rebuild. Continue to Phase E.

---

## Phase E — Live deploy validation

After the tutorials-ims merge, the rebuild-content workflow fires. The first run will pull `meta-tutorials` for the first time AND honor the existing `AI_AUTHOR_ENABLED=true` workflow default (already in place per [.github/workflows/rebuild-content.yml:29](../../../.github/workflows/rebuild-content.yml#L29)).

### Task E1: Watch the CI rebuild

- [ ] **Step 1: Watch the workflow run**

```bash
gh run watch --repo sap-tutorials/tutorials-ims
```

- [ ] **Step 2: Confirm the meta-tutorials repo was discovered**

In the workflow log, look for the line `meta-tutorials (main): 4 tutorials` (from [scripts/parsers/github.ts:447](../../../scripts/parsers/github.ts#L447)). If the count is wrong (0, 5+), the discovery contract test from Task A1 caught the wrong shape; investigate.

- [ ] **Step 3: Confirm AUTOAUTHOR fired for Tutorial 3**

Search the log for `[#208]` lines or any `expandAiAuthoredQuestions` mentions. Cache file at `.tutorial-cache/use-autoauthor-to-generate-quiz-questions.ai-quiz-cache.json` should be written on the runner (visible in subsequent cache-restore runs).

### Task E2: Smoke-test each tutorial on DEV

DEV approuter URL pattern: `https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/tutorials/<slug>` (use the approuter, not srv, for the public-facing test):

```text
DEV approuter: https://<approuter-host>/tutorials/<slug>
```

Replace `<approuter-host>` with the value of `secrets.APPROUTER_URL_DEV` (visible in the workflow inputs UI, or via Tom).

- [ ] **Step 1: HTTP 200 check on all 4 slugs**

```bash
for slug in use-codecheck-to-ai-grade-reader-code use-validate-to-ai-grade-free-text-answers use-autoauthor-to-generate-quiz-questions tutorial-platform-feature-cookbook; do
  status=$(curl -s -o /dev/null -w "%{http_code}" "https://<approuter-host>/tutorials/$slug")
  echo "$slug: $status"
done
```

Expected: all 4 return 200. If any return 404, the publish step missed that slug — re-run `gh workflow run rebuild-content.yml` with `slug=<missing-slug>` to retry just that one.

- [ ] **Step 2: Tutorial 1 — CODECHECK live grading test**

Open `https://<approuter-host>/tutorials/use-codecheck-to-ai-grade-reader-code` in a browser. Navigate to step 4. Paste a deliberately wrong CDS entity (e.g. missing the `: managed` aspect). Submit. The AI should return feedback identifying the missing aspect. Then paste the reference solution; submit; AI returns "looks good" / similar.

If the paste-code area is missing entirely, `ChatSettings.codeCheckEnabled` is OFF on DEV. Verify via `/admin-ui/#operations-display` (Joule Chat Settings tile) and toggle ON if needed. ([feedback_check_chatsettings_after_deploy])

- [ ] **Step 3: Tutorial 2 — free-text grader test**

Open `/tutorials/use-validate-to-ai-grade-free-text-answers`. Step 4 has a text input. Submit gibberish ("xyz hello world") — expect a low-score / "not relevant" response. Then submit a correct definition of group-vs-mission — expect a high score.

- [ ] **Step 4: Tutorial 3 — AUTOAUTHOR generated questions visible**

Open `/tutorials/use-autoauthor-to-generate-quiz-questions`. Steps 4 and 5 should each have a quiz widget (MCQ for step 4, free-text input for step 5). View page source; confirm the `<script id="tutorial-data">` JSON contains entries with `aiAuthored: true`.

- [ ] **Step 5: Tutorial 4 — cookbook smoke checks**

Open `/tutorials/tutorial-platform-feature-cookbook`. Verify, in order:

| Step | Check |
|------|-------|
| 1 | OS picker visible at top of page; switching it changes step 1 content |
| 2 | Step 2 has its own per-step JSON/XML tabs, independent of OS picker |
| 3 | Branch picker visible; clicking each chip shows the matching content |
| 4 | Skip-runs syntax visible in the rendered code fence |
| 5 | Mermaid diagram renders inline (Horizon palette) |
| 6 | Cross-tab code-block sync works across multiple language fences |
| 7 | First mention of CDS / CAP / BTP shows a popover on hover |
| 8 | Image opens in a lightbox dialog when clicked |

Document any failures inline as PR comments on tutorials-ims#382, then surface to Tom for triage.

### Task E3: Capture screenshots and replace placeholder images

- [ ] **Step 1: Capture the live grading result**

Open Tutorial 1 step 4, submit a wrong solution, screenshot the inline feedback. Save as `002-codecheck-grading-result.png` in the local meta-tutorials clone. Do the same for Tutorial 1's `001-rules-vr-overview.png` (a screenshot of `tutorials/use-codecheck-to-ai-grade-reader-code/rules.vr` open in VS Code).

Tutorial 2 needs `001-text-answer-feedback.png` (a screenshot of the free-text-grader response). Tutorial 3 needs `001-build-time-generation.png` (could be a screenshot of the workflow log line showing AI generation, OR a diagram).

For Tutorial 4 step 8 (lightbox demo), use a screenshot of the rendered cookbook itself — meta-recursive but appropriate.

- [ ] **Step 2: Open a follow-up PR replacing placeholder images**

```bash
cd D:/projects/meta-tutorials
git checkout -b chore/real-screenshots
# Replace the 1x1 placeholders with real PNGs
git add tutorials/
git commit -m "chore: replace placeholder images with real screenshots"
gh pr create --title "chore: real screenshots for AI-features tutorials" --body "Follow-up to sap-tutorials/tutorials-ims#382. Replaces 1x1 placeholder PNGs with screenshots captured from the deployed DEV mission."
gh pr merge --squash --delete-branch
```

The next CI rebuild picks up the new images automatically.

### Task E4: Add deploy-validation history to the closed tutorials-ims PR

- [ ] **Step 1: Comment on the closed PR**

```bash
cd d:/projects/tutorials-poc
gh pr comment <tutorials-ims-PR-number> --body "$(cat <<'EOF'
## Live deploy validation history

DEV deployed run: <workflow-run-url>

| Tutorial | Status |
|---|---|
| use-codecheck-to-ai-grade-reader-code | ✅ AI grading on wrong/right inputs |
| use-validate-to-ai-grade-free-text-answers | ✅ AI grading low/high scores |
| use-autoauthor-to-generate-quiz-questions | ✅ AI-generated MCQ + text-style widgets render |
| tutorial-platform-feature-cookbook | ✅ OS picker, branch picker, mermaid, codetabs, glossary, lightbox all working |

ChatSettings.codeCheckEnabled = true on DEV (verified via /admin-ui/#operations-display).
EOF
)"
```

---

## Phase F — Mission registration + writing-tutorials.md callout

### Task F1: Register the mission via admin UI

This is a manual step Tom (Center Admin) performs. The plan documents it for completeness; a worker without admin access stops here and surfaces.

- [ ] **Step 1: Surface to Tom**

Print to chat:

> "All four tutorials are live on DEV. Ready for Center Admin to create the mission via [/admin-ui/#missions-display](https://<approuter-host>/admin-ui/#missions-display). Mission fields per spec §"Mission registration":
>
> - Title: Tutorial Platform Features for Authors
> - Slug: tutorial-platform-features-for-authors
> - Experience level: Intermediate
> - Tutorials (in order): use-codecheck-to-ai-grade-reader-code → use-validate-to-ai-grade-free-text-answers → use-autoauthor-to-generate-quiz-questions → tutorial-platform-feature-cookbook
> - Primary tag: tutorial>intermediate
> - Secondary tag: software-product>sap-business-technology-platform
> - Description: paragraph linking to writing-tutorials.md
>
> Confirm when done so I can run the smoke test on `/mission.tutorial-platform-features-for-authors.html` and add the writing-tutorials.md callout."

### Task F2: Smoke-test the mission landing page

- [ ] **Step 1: HTTP 200 on the mission page**

```bash
curl -s -o /dev/null -w "%{http_code}" "https://<approuter-host>/mission.tutorial-platform-features-for-authors.html"
```

Expected: 200.

- [ ] **Step 2: Open in a browser, verify the 4 tutorials are listed in order**

### Task F3: Add the "Live examples" callout to writing-tutorials.md

**Files:**
- Modify: `docs/authors/writing-tutorials.md` (right before §3.1 Frontmatter, around line 41)

- [ ] **Step 1: Branch + edit**

```bash
cd d:/projects/tutorials-poc
git checkout main && git pull
git checkout -b chore/writing-tutorials-live-examples
```

Open `docs/authors/writing-tutorials.md`. Find the line `## 3. Anatomy of a tutorial` (around line 41). Immediately after the existing intro paragraph and before `### 3.1 Frontmatter`, add:

```markdown
> **★ Live examples** — see the [Tutorial Platform Features for Authors](https://developers.sap.com/mission.tutorial-platform-features-for-authors.html) mission for working tutorials that demonstrate every piece of syntax described below: the [CODECHECK demo](https://developers.sap.com/tutorials/use-codecheck-to-ai-grade-reader-code.html), [free-text grading](https://developers.sap.com/tutorials/use-validate-to-ai-grade-free-text-answers.html), [AUTOAUTHOR](https://developers.sap.com/tutorials/use-autoauthor-to-generate-quiz-questions.html), and the [feature cookbook](https://developers.sap.com/tutorials/tutorial-platform-feature-cookbook.html) (OS variants, branches, mermaid, codetabs, glossary, lightbox).
```

> URL caveat: until the mission is also live in production (not just DEV), the `developers.sap.com` URLs will 404. If the production deploy is delayed, swap them for the DEV approuter URLs and add a TODO to update on prod-cutover.

- [ ] **Step 2: Verify the VitePress build still passes**

```bash
npm run docs:build
```

Expected: zero "dead link" warnings on the new URLs (they're external and not validated by the sidebar guard).

- [ ] **Step 3: Open and merge a small PR**

```bash
git add docs/authors/writing-tutorials.md
git commit -m "docs(authors): link to live AI-features showcase mission (#382)"
gh pr create --title "docs(authors): link to live AI-features showcase mission" --body "Cross-reference to the mission shipped in #382. URLs go live on production after the next prod cutover; on DEV they're already reachable."
```

---

## Definition of Done

- [ ] Phase A: PR open with the github.ts change + unit test; tests pass locally
- [ ] Phase B: 4 tutorial markdown files committed in `D:/projects/meta-tutorials` on `feat/ai-features-showcase` branch
- [ ] Phase C: meta-tutorials-Contribution repo created; 3 rules.vr files committed; PR open
- [ ] Phase D: All 3 PRs merged in order
- [ ] Phase E: All 4 tutorials return HTTP 200 on DEV; live AI smokes pass for tutorials 1–3; cookbook step interactions verified
- [ ] Phase E: Real screenshots replace placeholders
- [ ] Phase F: Mission registered via admin UI; mission landing page returns 200
- [ ] Phase F: writing-tutorials.md callout PR merged

---

## Risks called out for the executor

1. **Mission fields require Center Admin** — Phase F1 stops a non-admin worker. Surface to Tom.
2. **AUTOAUTHOR cache may take 1-2 builds to stabilize** — if the first build's generated questions are odd, re-run; the cache pins them after that.
3. **Placeholder images** — make sure the markdown lint and Hugo build don't choke on a 1x1 PNG. If they do, defer all image references in Phase B and add them in Phase E only.
4. **Production rollout** — this plan ships to DEV. Production cutover is a separate Tom-gated step (typically the next regularly scheduled prod deploy from CI). The writing-tutorials.md links pointing at developers.sap.com 404 until that happens.
5. **Repo-creation rights** — Phase C1 requires sap-tutorials org admin. If the executor doesn't have rights, surface to Tom to create the repo and re-run from C2.
