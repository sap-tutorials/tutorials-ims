# Preview API — Validation Question Support (F-8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close gaps raised in [#655](https://github.com/sap-tutorials/tutorials-ims/issues/655): teach `POST /preview/render` about the companion `rules.vr` file and let the validation widget hydrate in preview with a global reset + uniform AI-feature notice.

**Architecture:** Extend the preview payload to `{ markdown, rulesVr? }`. Re-bundle `srv-qa/lib/parsers.bundle.mjs` to include `parseRulesVrEnriched` (still no GitHub-fetch code reaches srv-qa). Drop the Hugo gate around `validation.js` and emit `data-preview` / `data-ai-involved` data-attrs on mount divs so the widget self-governs. Add a preview-only banner partial with "Reset all answers" + "Reveal AI rules" controls wired by window-level CustomEvents. Render a uniform static notice + source rules.vr block for any AI-involved step (free-text grading, `[AUTOAUTHOR_*]`, `[CODECHECK_N]`, Joule step-help). No DB access, no outbound HTTP, no AI Core quota burn during preview.

**Tech Stack:** Node.js (Express, esbuild bundle), Hugo (Go templates), Vue 3 + Vite, Vitest (unit + smoke), UI5 Web Components (banner controls).

**Spec:** [`docs/superpowers/specs/2026-06-26-655-preview-validation-design.md`](../specs/2026-06-26-655-preview-validation-design.md)

---

## File Structure (decomposition map)

**New files:**

- `hugo/layouts/partials/preview-banner.html` — Hugo partial rendering the banner UI (only when `previewMode`).
- `hugo-apps/src/validation/PreviewAINotice.vue` — Vue component for the static "AI features previewable after publish" notice + source rules.vr `<pre>` block.
- `hugo-apps/src/validation/preview-banner.ts` — Vite entry; wires banner UI events to localStorage sweep + window events.
- `hugo-apps/src/validation/Validation.preview.test.ts` — unit tests for widget's preview-mode branches.
- `hugo-apps/src/validation/preview-banner.test.ts` — unit tests for banner script.

**Modified files (server-side):**

- `scripts/parsers/index.ts` — re-export `parseRulesVrEnriched` and AI-graded helpers so they enter the bundle.
- `scripts/parsers/compose.ts` — extend `ComposeOpts` with `rulesVr?: string`; when present, parse and merge validation + codecheck + AI flags into `composed.steps`.
- `srv-qa/preview-renderer.js` — accept `rulesVr` arg; thread it into `composeTutorial`.
- `srv-qa/server.js` — accept optional `rulesVr` field in request body; pass to renderer.
- `srv-qa/lib/parsers.bundle.mjs` — rebuilt artifact (committed). Produced by `npm run prebuild:parsers-bundle`.

**Modified files (Hugo layouts):**

- `hugo/layouts/_default/baseof.html` — render `preview-banner` partial + emit `<body data-has-ai="…">` + load `preview-banner.js` (all gated on `previewMode`).
- `hugo/layouts/tutorials/u1-object-page.html` — remove `previewMode` gate around `<script src="/js/validation.js">`.
- `hugo/layouts/shortcodes/tutorial-step.html` — emit `data-preview="true"` + `data-ai-involved="…"` + `data-rules-block-id="…"` on `.step-validation-mount` when `previewMode`.
- `hugo/layouts/partials/codecheck-mount.html` — preview branch renders `<div class="step-codecheck-preview-mount" data-rules-block-id="…">` when `previewMode`; existing prod path unchanged.
- `hugo/layouts/partials/joule-step-help.html` — preview branch renders inline "Joule step help available after publish" notice when `previewMode`.

**Modified files (Vue widget):**

- `hugo-apps/src/validation/Validation.vue` — read `data-preview` / `data-ai-involved` / `data-rules-block-id`; suppress network calls + listen for reset event + render `<PreviewAINotice>` for AI-involved questions.
- `hugo-apps/vite.config.ts` — add `preview-banner` Vite entry point.

**Modified files (tests):**

- `test/srv-qa/preview-renderer.test.js` — extend with `rulesVr` cases.
- `test/srv-qa/server.test.js` — extend with payload validation.
- `test/smoke/qa-routes.test.ts` — extend with new smoke cases.

### Decomposition rationale

- **`composeTutorial` is the natural seam.** The existing fetch-tutorials path already does `parseRulesVrEnriched` → merge into steps → write sidecars. We move *only* the merge into compose (under an opt-in arg), preserving the fetch-tutorials path's sidecar-writing logic (which the preview never needs).
- **Banner script is its own Vite entry** because it must execute *before* widget hydration (auto-reset). Folding it into validation.js would create an ordering contract no defer attribute can express cleanly.
- **`data-preview` + `data-ai-involved` + `data-rules-block-id` carry all the widget needs to know.** The widget never reads global state or window flags — pure DOM input.
- **rules.vr source transport is via a single `<script type="application/json" id="rules-vr-source">` element on the page** (decided per spec's "open implementation tactic" guidance). Simpler than per-step extraction for v1.

### TDD posture per task

Each task follows: failing test → minimal impl → green → commit. The parser bundle is the one exception — its tests live at the renderer level (no separate test for the bundle artifact itself; we assert renderer behavior end-to-end).

### Frequent commits

Each task ends with a commit.

### Branch prep

The feature branch `feature/655-preview-validation` already exists and the spec is committed to it (`d6f791b5`). All Task 1–12 commits land on this branch. Verify before starting:

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/655-preview-validation
git branch --show-current
```

Expected: `feature/655-preview-validation`.

---

## Task 1: Extend `composeTutorial` to accept `rulesVr` and merge into steps

**Files:**
- Modify: `scripts/parsers/types.ts`
- Modify: `scripts/parsers/compose.ts`
- Test: `scripts/parsers/__tests__/compose-rules-vr.test.ts` (NEW)

- [ ] **Step 1: Write failing test for compose-with-rulesVr merge**

Create `scripts/parsers/__tests__/compose-rules-vr.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { composeTutorial } from '../compose'

const BASE_MD = `---
parser: v2
title: Test
description: x
time: 5
---
## You will learn
- thing

## Prerequisites
- none

### Step 1
Body of step 1.

### Step 2
Body of step 2.
`

const RULES_VR = `[VALIDATE_1]
###Question
What is 2+2?
###Rule mcq
- [X] 4
- [ ] 5
[VALIDATE_END_1]
`

describe('composeTutorial with rulesVr', () => {
  const baseOpts = {
    repo: '__preview__', branch: '__preview__', slug: '__preview__',
    target: 'hugo' as const, rewriteImages: false,
  }

  it('omitted rulesVr leaves steps with no validation', () => {
    const r = composeTutorial(BASE_MD, baseOpts)
    expect(r.steps[0]?.validation).toBeUndefined()
  })

  it('empty rulesVr behaves identically to omitted', () => {
    const r = composeTutorial(BASE_MD, { ...baseOpts, rulesVr: '' })
    expect(r.steps[0]?.validation).toBeUndefined()
  })

  it('valid rulesVr merges validation onto matching step', () => {
    const r = composeTutorial(BASE_MD, { ...baseOpts, rulesVr: RULES_VR })
    expect(r.steps[0]?.validation).toHaveLength(1)
    expect(r.steps[0]?.validation?.[0]?.question).toBe('What is 2+2?')
  })

  it('rulesVr referencing missing step is dropped silently', () => {
    const rules = RULES_VR.replace('VALIDATE_1', 'VALIDATE_99').replace('VALIDATE_END_1', 'VALIDATE_END_99')
    const r = composeTutorial(BASE_MD, { ...baseOpts, rulesVr: rules })
    expect(r.steps[0]?.validation).toBeUndefined()
    expect(r.steps[1]?.validation).toBeUndefined()
  })

  it('AI-graded text question sets aiInvolved on its step', () => {
    const aiRules = `[VALIDATE_1]
###Question
Describe what you learned.
###Rule ai-graded
###Answer
The user should mention concepts.
[VALIDATE_END_1]
`
    const r = composeTutorial(BASE_MD, { ...baseOpts, rulesVr: aiRules })
    expect(r.steps[0]?.aiInvolved).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/655-preview-validation
npx vitest run scripts/parsers/__tests__/compose-rules-vr.test.ts
```

Expected: FAIL (TypeScript error — `rulesVr` not in `ComposeOpts`, `aiInvolved` not on `TutorialStep`).

- [ ] **Step 3: Add `aiInvolved` flag to TutorialStep type**

Read `scripts/parsers/types.ts` to find the `TutorialStep` interface. Add to it:

```typescript
  /**
   * [#655] Preview-mode hint: true when this step's validation or codecheck
   * block involves AI (free-text aiGrading, AUTOAUTHOR-expanded, or
   * [CODECHECK_N] spec). Drives Hugo + widget rendering of the static
   * "AI features previewable after publish" notice. Not present in non-preview
   * builds — fetch-tutorials.ts doesn't set this field.
   */
  aiInvolved?: boolean
```

- [ ] **Step 4: Add `rulesVr` to `ComposeOpts` and implement merge**

Edit `scripts/parsers/compose.ts`:

Add imports at top (alongside existing imports):

```typescript
import { parseRulesVrEnriched } from './rules.js'
import { parseCodeCheckBlocks, attachCodeCheckSpecs } from './codecheck.js'
```

Extend `ComposeOpts`:

```typescript
export interface ComposeOpts {
  repo: string
  branch: string
  slug: string
  target: 'hugo' | 'vitepress'
  rewriteImages: boolean
  /**
   * [#655] Optional rules.vr companion content. When provided, this function
   * parses it and merges validation + codecheck + AI flags into `steps`.
   * The standard fetch-tutorials path does NOT use this — it merges separately
   * because it also writes sidecar JSON files. Preview is the only consumer.
   */
  rulesVr?: string
}
```

After the existing `branchGroups` merge loop (around line 116), and before the `return` statement, add:

```typescript
  // [#655] Preview-mode rules.vr merge. Only runs when rulesVr is supplied
  // (preview path). Fetch-tutorials.ts has its own merge that also writes
  // sidecar JSON files; this stays a separate code path.
  if (opts.rulesVr && opts.rulesVr.trim()) {
    const enriched = parseRulesVrEnriched(opts.rulesVr)
    for (const [validateNum, questions] of enriched.map) {
      if (!questions.length) continue
      const target = steps.find(s => s.number === validateNum)
      if (target) {
        target.validation = [...(target.validation ?? []), ...questions]
        if (questions.some(q => q.aiGrading)) target.aiInvolved = true
      }
    }
    // AUTOAUTHOR_ALL marks every step AI-involved (we never expand the
    // questions themselves in preview — the directive itself is shown via
    // the AI notice).
    if (enriched.allDirective) {
      for (const step of steps) step.aiInvolved = true
    }
    const codeCheckMap = parseCodeCheckBlocks(opts.rulesVr)
    if (codeCheckMap.size) {
      attachCodeCheckSpecs(steps, codeCheckMap)
      for (const step of steps) {
        if (step.codeCheck) step.aiInvolved = true
      }
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run scripts/parsers/__tests__/compose-rules-vr.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 6: Run the full parser test suite to verify no regression**

```bash
npx vitest run scripts/parsers/
```

Expected: all parser tests PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/parsers/types.ts scripts/parsers/compose.ts scripts/parsers/__tests__/compose-rules-vr.test.ts
git commit -m "feat(#655): composeTutorial accepts rulesVr opt-in arg

When opts.rulesVr is set, parse it and merge validation + codecheck
into composed.steps. Flag steps with AI-involved content
(aiGrading: true, codecheck spec, AUTOAUTHOR directive) so downstream
preview rendering can show a static notice instead of attempting AI calls.

Preview path only; fetch-tutorials.ts continues to handle its own merge
+ sidecar JSON write."
```

---

## Task 2: Rebuild `parsers.bundle.mjs` and extend `renderPreview`

**Files:**
- Modify: `srv-qa/preview-renderer.js`
- Modify: `srv-qa/lib/parsers.bundle.mjs` (regenerated artifact)
- Test: `test/srv-qa/preview-renderer.test.js`

- [ ] **Step 1: Rebuild the parser bundle**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/655-preview-validation
npm run prebuild:parsers-bundle
```

Expected: `srv-qa/lib/parsers.bundle.mjs` regenerated. Verify `parseRulesVrEnriched` is now reachable:

```bash
grep -c "parseRulesVrEnriched\|parseCodeCheckBlocks" srv-qa/lib/parsers.bundle.mjs
```

Expected: ≥ 2 occurrences.

- [ ] **Step 2: Sanity check — bundle does NOT include GitHub-fetch code**

```bash
grep -c "fetchRulesVr\|fetchGitHubMeta\|raw.githubusercontent.com" srv-qa/lib/parsers.bundle.mjs
```

Expected: 0. If non-zero, the bundle pulled in `scripts/parsers/github.ts` transitively. **STOP** and either add `--external:` flag to the esbuild command in package.json OR refactor `compose.ts` imports to avoid pulling the github module. Do not commit until this is 0.

- [ ] **Step 3: Write failing test for renderer + rulesVr happy path**

Edit `test/srv-qa/preview-renderer.test.js`. After the existing happy-path test, add:

```javascript
import { describe, it, expect, vi } from 'vitest'
import { renderPreview } from '../../srv-qa/preview-renderer.js'

const BASE_MD = `---
parser: v2
title: Test
description: x
time: 5
---
## You will learn
- thing

## Prerequisites
- none

### Step 1
Body of step 1.
`

const RULES_VR = `[VALIDATE_1]
###Question
What is 2+2?
###Rule mcq
- [X] 4
- [ ] 5
[VALIDATE_END_1]
`

describe('renderPreview with rulesVr', () => {
  it('rulesVr undefined: HTML does not contain question text', async () => {
    const { html, status } = await renderPreview(BASE_MD)
    expect(status).toBe('ok')
    expect(html).not.toContain('What is 2+2?')
  })

  it('rulesVr empty string: behaves like undefined', async () => {
    const { html, status } = await renderPreview(BASE_MD, '')
    expect(status).toBe('ok')
    expect(html).not.toContain('What is 2+2?')
  })

  it('valid rulesVr: rendered HTML contains the question text', async () => {
    const { html, status } = await renderPreview(BASE_MD, RULES_VR)
    expect(status).toBe('ok')
    expect(html).toContain('What is 2+2?')
  })

  it('zero outbound fetch calls during render with rulesVr', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await renderPreview(BASE_MD, RULES_VR)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
```

- [ ] **Step 4: Run test to verify failure**

```bash
npx vitest run test/srv-qa/preview-renderer.test.js
```

Expected: the new tests FAIL — `renderPreview` doesn't accept a second arg yet, so all 3 active-content tests render without rules.

- [ ] **Step 5: Implement renderer change**

Edit `srv-qa/preview-renderer.js`. Change the function signature and the `composeTutorial` call:

```javascript
export async function renderPreview(markdown, rulesVr) {
  const t0 = Date.now();
  if (!markdown || !markdown.trim()) {
    return { html: errorHtml('Preview error', 'Markdown payload is empty.'), status: 'parse_error', durationMs: Date.now() - t0, bytes: 0, _tmpDir: null };
  }

  let tmpDirPath = null;
  try {
    tmpDirPath = mkdtempSync(join(tmpdir(), 'tut-preview-'));

    let composed;
    try {
      composed = composeTutorial(markdown, {
        repo: '__preview__', branch: '__preview__', slug: '__preview__',
        target: 'hugo', rewriteImages: false,
        rulesVr: rulesVr && rulesVr.trim() ? rulesVr : undefined,
      });
    } catch (err) {
      // ... existing catch unchanged ...
```

(Leave the rest of the function intact.)

Also: extend the frontmatter emit so the rules.vr source AND a precomputed `hasAi` boolean are available to Hugo. Find the `renderHugoFrontmatter(...)` call in the renderer and add two sibling fields:

```javascript
    const hasAi = composed.steps.some(s => s.aiInvolved === true);
    const fmMarkdown = renderHugoFrontmatter({
      slug: '__preview__',
      // ... existing fields ...
      hasOsOptions: composed.hasOsOptions,
      // [#655] Pass through rules.vr source so baseof.html can emit
      // <script id="rules-vr-source"> for PreviewAINotice components.
      rulesVrSource: rulesVr && rulesVr.trim() ? rulesVr : '',
      // [#655] Precomputed flag — baseof.html uses this for <body data-has-ai="…">.
      // Computing in the renderer (Node) avoids depending on Hugo's range
      // semantics over a nested .Params.steps structure.
      hasAi,
    });
```

`renderHugoFrontmatter` will need to accept both fields. Check `scripts/parsers/render-frontmatter.ts` and add `rulesVrSource: string` + `hasAi: boolean` to its input type. Write them under `params:` in the YAML output. Rebuild the bundle after the change.

- [ ] **Step 6: Re-run bundle build (rules.vr passthrough needs the new field)**

```bash
npm run prebuild:parsers-bundle
```

- [ ] **Step 7: Run renderer tests to verify pass**

```bash
npx vitest run test/srv-qa/preview-renderer.test.js
```

Expected: all preview-renderer tests PASS (existing + new).

- [ ] **Step 8: Commit**

```bash
git add srv-qa/preview-renderer.js srv-qa/lib/parsers.bundle.mjs test/srv-qa/preview-renderer.test.js scripts/parsers/render-frontmatter.ts
git commit -m "feat(#655): renderPreview accepts optional rulesVr arg

Threads rulesVr through to composeTutorial. Also passes the verbatim
rules.vr source through Hugo frontmatter as params.rulesVrSource so
baseof.html can emit a <script id='rules-vr-source'> for PreviewAINotice
components to read.

Re-bundle parsers.bundle.mjs to include parseRulesVrEnriched +
parseCodeCheckBlocks (still excludes GitHub-fetch code — verified
via grep). Tests cover the four cases in the spec's error-handling matrix."
```

---

## Task 3: Accept `rulesVr` in `POST /preview/render` handler

**Files:**
- Modify: `srv-qa/server.js`
- Test: `test/srv-qa/server.test.js` (extend if exists)

- [ ] **Step 1: Verify test file location**

```bash
ls test/srv-qa/server.test.js 2>/dev/null && echo "exists" || echo "needs creating"
```

If "needs creating," put the test alongside in `test/srv-qa/preview-renderer.test.js` and treat as an integration test against the handler.

- [ ] **Step 2: Write failing test for payload validation**

```javascript
import request from 'supertest'

describe('POST /preview/render body validation', () => {
  it('rejects rulesVr that is not a string', async () => {
    const res = await request(app)
      .post('/preview/render')
      .set('Authorization', `Bearer ${validAuthorToken}`)
      .send({ markdown: '# x', rulesVr: 123 })
    expect(res.status).toBe(400)
  })

  it('accepts rulesVr === "" (treated as omitted)', async () => {
    const res = await request(app)
      .post('/preview/render')
      .set('Authorization', `Bearer ${validAuthorToken}`)
      .send({ markdown: '# x', rulesVr: '' })
    expect(res.status).toBe(200)
    expect(res.type).toMatch(/text\/html/)
  })

  it('accepts valid string rulesVr', async () => {
    const res = await request(app)
      .post('/preview/render')
      .set('Authorization', `Bearer ${validAuthorToken}`)
      .send({ markdown: '# x', rulesVr: '[VALIDATE_1]\n[VALIDATE_END_1]\n' })
    expect(res.status).toBe(200)
  })
})
```

If the existing harness mocks auth differently, follow that pattern.

- [ ] **Step 3: Run test to verify failure**

```bash
npx vitest run test/srv-qa/server.test.js
```

Expected: the 400 case FAILS.

- [ ] **Step 4: Implement handler change**

Edit `srv-qa/server.js`. Find the handler (around line 96-116). Modify the body-validation block:

```javascript
        const markdown = req.body?.markdown;
        if (typeof markdown !== 'string') {
          res.status(400).json({ error: 'expected JSON body { markdown: string, rulesVr?: string }' });
          return;
        }
        // [#655] Optional companion rules.vr content. Empty string treated
        // as omitted. Non-string with field present is a hard 400.
        const rulesVr = req.body?.rulesVr;
        if (rulesVr !== undefined && typeof rulesVr !== 'string') {
          res.status(400).json({ error: 'rulesVr must be a string when provided' });
          return;
        }
        const { html, status, durationMs, bytes } = await renderPreview(markdown, rulesVr);
        console.log(JSON.stringify({
          event: 'preview.render',
          status,
          ms: durationMs,
          bytes,
          hasRulesVr: typeof rulesVr === 'string' && rulesVr.length > 0,
          totalMs: Date.now() - t0,
        }));
```

- [ ] **Step 5: Run tests to verify pass**

```bash
npx vitest run test/srv-qa/server.test.js
```

Expected: all server tests PASS.

- [ ] **Step 6: Commit**

```bash
git add srv-qa/server.js test/srv-qa/server.test.js
git commit -m "feat(#655): /preview/render accepts optional rulesVr field

Strict typing — non-string rulesVr returns 400; empty string treated
as omitted. Log line includes hasRulesVr flag for observability."
```

---

## Task 4: Add smoke tests for the new server contract

**Files:**
- Modify: `test/smoke/qa-routes.test.ts`

- [ ] **Step 1: Read the existing smoke test file**

```bash
grep -n "preview/render" test/smoke/qa-routes.test.ts | head -10
```

Note existing fixtures, auth pattern, helpers.

- [ ] **Step 2: Add new smoke test cases**

Add to `test/smoke/qa-routes.test.ts`:

```typescript
describe('/preview/render — rulesVr smoke tests (#655)', () => {
  const baseMd = `---
parser: v2
title: Smoke test
description: smoke
time: 5
---
## You will learn
- testing

## Prerequisites
- none

### Step 1
Body.
`

  it('rulesVr with [VALIDATION_1] → HTML contains question text', async () => {
    const rulesVr = '[VALIDATE_1]\n###Question\nWhat is 2+2?\n###Rule mcq\n- [X] 4\n- [ ] 5\n[VALIDATE_END_1]\n'
    const res = await fetch(`${SRV_URL_QA}/preview/render`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SMOKE_QA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: baseMd, rulesVr }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('What is 2+2?')
  })

  it('rulesVr with [AUTOAUTHOR_ALL] → HTML contains AI notice text', async () => {
    const rulesVr = '[AUTOAUTHOR_ALL]\n'
    const res = await fetch(`${SRV_URL_QA}/preview/render`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SMOKE_QA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: baseMd, rulesVr }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toMatch(/AI features can only be fully previewed/i)
  })

  it('malformed rulesVr → 200 with parse-error HTML or plain ok', async () => {
    const malformed = '[VALIDATE_1]\n###Rule ai-graded\n###Answer\n'
    const res = await fetch(`${SRV_URL_QA}/preview/render`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SMOKE_QA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: baseMd, rulesVr: malformed }),
    })
    expect(res.status).toBe(200)
  })

  it('markdown only → 200, banner renders, Reveal AI toggle hidden', async () => {
    const res = await fetch(`${SRV_URL_QA}/preview/render`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SMOKE_QA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: baseMd }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toMatch(/data-has-ai="false"/)
    expect(html).toMatch(/data-preview-banner/)
  })

  it('non-string rulesVr → 400', async () => {
    const res = await fetch(`${SRV_URL_QA}/preview/render`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SMOKE_QA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: baseMd, rulesVr: 123 }),
    })
    expect(res.status).toBe(400)
  })
})
```

These run only when `SRV_URL_QA` + `SMOKE_QA_TOKEN` are present in env. The AI-notice and banner cases need Tasks 7–11 to fully green; they're acceptance checks for the whole feature.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/qa-routes.test.ts
git commit -m "test(#655): smoke tests for preview/render rulesVr contract

5 cases: valid rulesVr, AUTOAUTHOR notice, malformed input,
markdown-only (banner without AI toggle), non-string rulesVr → 400.

Some will turn green only after Hugo + Vue changes ship (Tasks 6-11);
they are valid acceptance checks for the full feature."
```

---

## Task 5: Preview-mode flag on the body element + Hugo data-attr emission

**Files:**
- Modify: `hugo/layouts/_default/baseof.html`
- Modify: `hugo/layouts/shortcodes/tutorial-step.html`

- [ ] **Step 1: Read baseof.html to locate `<body>` and current previewMode usage**

```bash
grep -n "previewMode\|<body" hugo/layouts/_default/baseof.html | head -20
```

- [ ] **Step 2: Emit `data-has-ai` on `<body>` + the rules-vr-source script tag (preview only)**

Edit `hugo/layouts/_default/baseof.html`.

At the `<body>` element, emit `data-has-ai` from the precomputed param set in Task 2:

```go-html
<body {{ if site.Params.previewMode }}data-has-ai="{{ if .Params.hasAi }}true{{ else }}false{{ end }}"{{ end }} ...>
```

(Match existing attribute conventions in the file. Slot `data-has-ai` alongside any existing `data-page-slug` etc.)

Emit the rules-vr-source `<script>` element in `<head>` (preview only, only when source is non-empty):

```go-html
{{ if and site.Params.previewMode .Params.rulesVrSource }}
<script type="application/json" id="rules-vr-source">{{ .Params.rulesVrSource | jsonify }}</script>
{{ end }}
```

- [ ] **Step 3: Update tutorial-step.html shortcode to emit preview data-attrs**

Edit `hugo/layouts/shortcodes/tutorial-step.html`. Find the `.step-validation-mount` div (around line 17). Replace with:

```go-html
<div class="step-validation-mount"
     data-step="{{ $number }}"
     {{ if site.Params.previewMode }}
     data-preview="true"
     data-ai-involved="{{ if .aiInvolved }}true{{ else }}false{{ end }}"
     data-rules-block-id="rules-vr-source"
     {{ end }}></div>
```

(Verify `.aiInvolved` is accessible from the step context — depends on how the shortcode receives step data. May need to thread it through; follow the same pattern existing fields like `validation` use.)

- [ ] **Step 4: Hugo build sanity check**

```bash
cd hugo && hugo --quiet --logLevel error
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/_default/baseof.html hugo/layouts/shortcodes/tutorial-step.html
git commit -m "feat(#655): emit preview data-attrs + rules-vr-source script

baseof.html: <body data-has-ai='…'> driven by any step's aiInvolved
flag. <script id='rules-vr-source'> carries the full rules.vr content
for PreviewAINotice components to read (preview only; prod unchanged).

tutorial-step.html: .step-validation-mount gains data-preview='true' +
data-ai-involved + data-rules-block-id when previewMode is on. Widget
will read these in Task 8."
```

---

## Task 6: Preview banner partial + script registration

**Files:**
- Create: `hugo/layouts/partials/preview-banner.html`
- Modify: `hugo/layouts/_default/baseof.html`
- Modify: `hugo/assets/css/skeletons.css` (or appropriate CSS module)

- [ ] **Step 1: Create the preview-banner partial**

Write `hugo/layouts/partials/preview-banner.html`:

```go-html
{{/* [#655] Preview-only banner. Renders only when site.Params.previewMode is true.
     Controls:
       - "Reset all answers" — wipes localStorage prefix
                               tutorial-validation-__preview__-* and emits
                               tutorial-preview:reset-answers event.
       - "Reveal AI rules"   — toggles visibility of <PreviewAINotice> rules.vr
                               <pre> blocks. Hidden when <body data-has-ai="false">.
     Behavior is wired by /js/preview-banner.js. */}}
{{ if site.Params.previewMode }}
<aside data-preview-banner role="region" aria-label="Tutorial preview controls" class="preview-banner">
  <span class="preview-banner__label">Preview mode</span>
  <ui5-button id="preview-banner-reset" design="Transparent">Reset all answers</ui5-button>
  <ui5-switch id="preview-banner-reveal-ai" data-reveal-ai
              accessible-name="Reveal AI rules"
              text-on="AI rules"
              text-off="AI rules"></ui5-switch>
</aside>
{{ end }}
```

- [ ] **Step 2: Render the partial from baseof.html and add the script tag**

Edit `hugo/layouts/_default/baseof.html`. Just inside `<body>`, before `<main>`:

```go-html
{{ partial "preview-banner.html" . }}
```

Add the preview-banner script tag — preview mode only, deferred so it runs before validation.js hydrates:

```go-html
{{ if site.Params.previewMode }}
<script type="module" src="/js/preview-banner.js" defer></script>
{{ end }}
```

- [ ] **Step 3: Add banner CSS**

Append to `hugo/assets/css/skeletons.css`:

```css
/* [#655] Preview-only banner. Selectors scoped to the data-attr so prod CSS
   is unaffected if the file is shared. */
[data-preview-banner] {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  gap: 1rem;
  align-items: center;
  padding: 0.5rem 1rem;
  background: var(--sapInformationBackground, #ebf8ff);
  border-bottom: 1px solid var(--sapInformationBorderColor, #0a6ed1);
  font-size: 0.875rem;
}
[data-preview-banner] .preview-banner__label {
  font-weight: 600;
}
body[data-has-ai="false"] [data-preview-banner] [data-reveal-ai] {
  display: none;
}
```

- [ ] **Step 4: Hugo build sanity check**

```bash
cd hugo && hugo --quiet --logLevel error
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/partials/preview-banner.html hugo/layouts/_default/baseof.html hugo/assets/css/skeletons.css
git commit -m "feat(#655): preview-banner partial + style + script registration

Sticky banner at top of preview-mode pages with Reset + Reveal-AI controls.
Reveal-AI toggle hidden via CSS when <body data-has-ai='false'>.
preview-banner.js loaded (defer) preview-mode only."
```

---

## Task 7: `PreviewAINotice.vue` component

**Files:**
- Create: `hugo-apps/src/validation/PreviewAINotice.vue`
- Test: `hugo-apps/src/validation/PreviewAINotice.test.ts` (NEW)

- [ ] **Step 1: Write failing test**

```typescript
// hugo-apps/src/validation/PreviewAINotice.test.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PreviewAINotice from './PreviewAINotice.vue'

describe('PreviewAINotice', () => {
  it('renders the static notice text', () => {
    const w = mount(PreviewAINotice, { props: { rulesBlock: '[VALIDATE_1]\n###Rule ai-graded\n' } })
    expect(w.text()).toMatch(/AI features can only be fully previewed/i)
  })

  it('renders rulesBlock in a <pre> element', () => {
    const w = mount(PreviewAINotice, { props: { rulesBlock: 'SAMPLE_BLOCK' } })
    expect(w.find('pre').text()).toContain('SAMPLE_BLOCK')
  })

  it('hides the <pre> by default; shows after tutorial-preview:reveal-ai-rules event', async () => {
    const w = mount(PreviewAINotice, { props: { rulesBlock: 'X' }, attachTo: document.body })
    expect(w.find('pre').isVisible()).toBe(false)
    window.dispatchEvent(new CustomEvent('tutorial-preview:reveal-ai-rules', { detail: { on: true } }))
    await w.vm.$nextTick()
    expect(w.find('pre').isVisible()).toBe(true)
    w.unmount()
  })
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
npx vitest run hugo-apps/src/validation/PreviewAINotice.test.ts
```

Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Create the component**

```vue
<!-- hugo-apps/src/validation/PreviewAINotice.vue -->
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

defineProps<{
  /** Source rules.vr block (verbatim). Rendered in a <pre> when revealed. */
  rulesBlock: string
}>()

const revealed = ref(false)

function onReveal(ev: Event) {
  const detail = (ev as CustomEvent).detail as { on?: boolean } | undefined
  revealed.value = Boolean(detail?.on)
}

onMounted(() => {
  window.addEventListener('tutorial-preview:reveal-ai-rules', onReveal)
})
onUnmounted(() => {
  window.removeEventListener('tutorial-preview:reveal-ai-rules', onReveal)
})
</script>

<template>
  <div role="note" class="preview-ai-notice">
    <h4 class="preview-ai-notice__title">AI features can only be fully previewed once deployed</h4>
    <p class="preview-ai-notice__body">
      This section uses an AI-driven feature (free-text grading, AI-authored quiz,
      code-check, or Joule step help). The author-side rules are shown below; full
      runtime behavior validates after the next QA publish.
    </p>
    <pre v-show="revealed" class="preview-ai-notice__rules"><code>{{ rulesBlock }}</code></pre>
  </div>
</template>

<style scoped>
.preview-ai-notice {
  border: 1px dashed var(--sapInformationBorderColor, #0a6ed1);
  background: var(--sapInformationBackground, #ebf8ff);
  border-radius: 4px;
  padding: 1rem;
  margin: 1rem 0;
}
.preview-ai-notice__title {
  margin: 0 0 0.5rem 0;
  font-size: 1rem;
}
.preview-ai-notice__body {
  margin: 0 0 0.5rem 0;
  font-size: 0.875rem;
}
.preview-ai-notice__rules {
  background: var(--sapNeutralBackground, #f5f5f5);
  padding: 0.5rem;
  border-radius: 3px;
  overflow-x: auto;
  font-size: 0.75rem;
}
</style>
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run hugo-apps/src/validation/PreviewAINotice.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/validation/PreviewAINotice.vue hugo-apps/src/validation/PreviewAINotice.test.ts
git commit -m "feat(#655): PreviewAINotice component

Static 'AI features previewable after publish' notice. Renders rules.vr
block in a <pre> revealed on tutorial-preview:reveal-ai-rules window event
(driven by preview-banner toggle)."
```

---

## Task 8: Teach `Validation.vue` about preview mode

**Files:**
- Modify: `hugo-apps/src/validation/Validation.vue`
- Create: `hugo-apps/src/validation/Validation.preview.test.ts`

- [ ] **Step 1: Read current Validation.vue mount logic**

```bash
grep -n "onMounted\|data-step\|fetch\|/feedback" hugo-apps/src/validation/Validation.vue | head -20
```

Note where mount-time DOM-attr reading happens and where network calls live.

- [ ] **Step 2: Write failing test for preview-mode behavior**

```typescript
// hugo-apps/src/validation/Validation.preview.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import Validation from './Validation.vue'

const aiQuestion = {
  id: 'q1',
  question: 'Describe what you learned.',
  type: 'text',
  aiGrading: true,
}

const mcqQuestion = {
  id: 'q2',
  question: 'What is 2+2?',
  type: 'multiple-choice',
  options: [{ label: '4', correct: true }, { label: '5', correct: false }],
}

describe('Validation.vue preview mode', () => {
  let store: Record<string, string>

  beforeEach(() => {
    store = {}
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { store = {} },
      get length() { return Object.keys(store).length },
      key: (i: number) => Object.keys(store)[i] ?? null,
    })
    // Provide the rules-vr-source script the widget reads via data-rules-block-id.
    const scriptEl = document.createElement('script')
    scriptEl.type = 'application/json'
    scriptEl.id = 'rules-vr-source'
    scriptEl.textContent = JSON.stringify('[VALIDATE_1]\n###Rule ai-graded\n')
    document.body.appendChild(scriptEl)
  })

  it('data-preview="true" + non-AI question: no network calls', async () => {
    mount(Validation, {
      props: { slug: '__preview__', stepNumber: 1, questions: [mcqQuestion] },
      attrs: { 'data-preview': 'true', 'data-ai-involved': 'false' },
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('data-preview="true" + AI question: renders PreviewAINotice, no input field', async () => {
    const w = mount(Validation, {
      props: { slug: '__preview__', stepNumber: 1, questions: [aiQuestion] },
      attrs: { 'data-preview': 'true', 'data-ai-involved': 'true', 'data-rules-block-id': 'rules-vr-source' },
    })
    expect(w.findComponent({ name: 'PreviewAINotice' }).exists()).toBe(true)
    expect(w.find('input[type="text"]').exists()).toBe(false)
  })

  it('listens for tutorial-preview:reset-answers and clears localStorage prefix', async () => {
    store['tutorial-validation-__preview__-1'] = '{"answered": true}'
    mount(Validation, {
      props: { slug: '__preview__', stepNumber: 1, questions: [mcqQuestion] },
      attrs: { 'data-preview': 'true', 'data-ai-involved': 'false' },
      attachTo: document.body,
    })
    window.dispatchEvent(new CustomEvent('tutorial-preview:reset-answers'))
    expect(store).not.toHaveProperty('tutorial-validation-__preview__-1')
  })
})
```

- [ ] **Step 3: Verify failure**

```bash
npx vitest run hugo-apps/src/validation/Validation.preview.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Update Validation.vue**

Edit `hugo-apps/src/validation/Validation.vue`:

In the `<script setup>` section, add (or extend existing):

```typescript
import { ref, onMounted, onUnmounted, useTemplateRef } from 'vue'
import PreviewAINotice from './PreviewAINotice.vue'

const isPreview = ref(false)
const aiInvolved = ref(false)
const rulesBlockText = ref<string>('')

// Use the existing root template ref. If none exists, add ref="rootEl" to the
// outermost element in the template and declare:
//   const rootEl = useTemplateRef<HTMLElement>('rootEl')

onMounted(() => {
  // Read preview-mode signals from the mount-host element's data-attrs.
  //
  // IMPORTANT: Vue's createApp(...).mount(host) REPLACES the host element by
  // default — its data-attrs are lost. Two ways to read them reliably:
  //   1) Read attrs from the host BEFORE calling .mount() and pass as props.
  //   2) Set the Vue root's template to <div ref="rootEl" v-bind="$attrs"> and
  //      rely on attribute fallthrough.
  // Check how the widget's existing .step-validation-mount integration reads
  // data-step today — mirror that pattern. If unsure, look at main.ts to see
  // the mount call site; the data-step path likely reads attrs before mount.
  const host = rootEl.value as HTMLElement | null
  if (host) {
    isPreview.value = host.dataset.preview === 'true'
    aiInvolved.value = host.dataset.aiInvolved === 'true'
    const blockId = host.dataset.rulesBlockId
    if (blockId) {
      const scriptEl = document.getElementById(blockId) as HTMLScriptElement | null
      if (scriptEl?.textContent) {
        try {
          rulesBlockText.value = JSON.parse(scriptEl.textContent)
        } catch {
          rulesBlockText.value = scriptEl.textContent
        }
      }
    }
  }
  if (isPreview.value) {
    window.addEventListener('tutorial-preview:reset-answers', onPreviewReset)
  }
})

onUnmounted(() => {
  window.removeEventListener('tutorial-preview:reset-answers', onPreviewReset)
})

function onPreviewReset(): void {
  // Clear any in-memory answer state. The exact ref names depend on the
  // widget's existing variables (selectedOption, freeText, graded, etc.) —
  // mirror what readPersisted() loads.
  // Also wipe the persisted __preview__ keys.
  if (typeof localStorage !== 'undefined') {
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(`tutorial-validation-${props.slug}-`)) {
        toRemove.push(key)
      }
    }
    for (const k of toRemove) localStorage.removeItem(k)
  }
}
```

Gate network calls — wherever the widget calls `fetch('/feedback/submit', …)` or any grader endpoint:

```typescript
if (!isPreview.value) {
  await fetch('/feedback/submit', { /* ... */ })
}
```

Render `PreviewAINotice` instead of the input field for AI-involved questions. In the template, locate the conditional block that renders the free-text input (typically `v-if="question.aiGrading"` or `question.type === 'text'`). Wrap with:

```vue
<template v-if="isPreview && aiInvolved">
  <PreviewAINotice :rules-block="rulesBlockText" />
</template>
<template v-else>
  <!-- existing input / MCQ markup -->
</template>
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run hugo-apps/src/validation/Validation.preview.test.ts
npx vitest run hugo-apps/src/validation/Validation.test.ts hugo-apps/src/validation/Validation.dom-attr.test.ts
```

Expected: all preview tests PASS, all existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/validation/Validation.vue hugo-apps/src/validation/Validation.preview.test.ts
git commit -m "feat(#655): Validation.vue self-governs in preview mode

Read data-preview / data-ai-involved / data-rules-block-id on mount.
Suppress network calls when isPreview. Render <PreviewAINotice> instead
of input field for AI-involved questions. Listen for
tutorial-preview:reset-answers to clear local state."
```

---

## Task 9: Drop the Hugo gate around `validation.js`

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html`

- [ ] **Step 1: Verify current state**

```bash
grep -n "validation.js" hugo/layouts/tutorials/u1-object-page.html
```

Expected: `438: {{ if not site.Params.previewMode }}<script type="module" src="/js/validation.js" defer></script>{{ end }}`.

- [ ] **Step 2: Remove the gate**

Edit line 438. Replace:

```go-html
{{ if not site.Params.previewMode }}<script type="module" src="/js/validation.js" defer></script>{{ end }}
```

With:

```go-html
<script type="module" src="/js/validation.js" defer></script>
```

- [ ] **Step 3: Build to verify**

```bash
cd hugo && hugo --quiet --logLevel error
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html
git commit -m "feat(#655): un-gate validation.js in preview mode

Widget reads data-preview attr on mount and self-governs preview
behavior. Template gate no longer needed."
```

---

## Task 10: Preview banner Vite entry + script

**Files:**
- Create: `hugo-apps/src/validation/preview-banner.ts`
- Modify: `hugo-apps/vite.config.ts`
- Test: `hugo-apps/src/validation/preview-banner.test.ts` (NEW)

- [ ] **Step 1: Write failing test**

```typescript
// hugo-apps/src/validation/preview-banner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('preview-banner.ts', () => {
  let store: Record<string, string>

  beforeEach(() => {
    store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { store = {} },
      get length() { return Object.keys(store).length },
      key: (i: number) => Object.keys(store)[i] ?? null,
    })
    // Build the DOM fixture with createElement (avoid innerHTML).
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
    const banner = document.createElement('aside')
    banner.setAttribute('data-preview-banner', '')
    const resetBtn = document.createElement('ui5-button')
    resetBtn.id = 'preview-banner-reset'
    const revealSwitch = document.createElement('ui5-switch')
    revealSwitch.id = 'preview-banner-reveal-ai'
    revealSwitch.setAttribute('data-reveal-ai', '')
    banner.appendChild(resetBtn)
    banner.appendChild(revealSwitch)
    document.body.appendChild(banner)
  })

  it('Reset button: wipes tutorial-validation-__preview__-* keys + emits event', async () => {
    store['tutorial-validation-__preview__-1'] = '{}'
    store['tutorial-validation-__preview__-2'] = '{}'
    store['unrelated-key'] = 'x'
    const eventFired = new Promise<void>(resolve => {
      window.addEventListener('tutorial-preview:reset-answers', () => resolve(), { once: true })
    })
    await import('./preview-banner')
    document.getElementById('preview-banner-reset')!.dispatchEvent(new MouseEvent('click'))
    await eventFired
    expect(store['tutorial-validation-__preview__-1']).toBeUndefined()
    expect(store['tutorial-validation-__preview__-2']).toBeUndefined()
    expect(store['unrelated-key']).toBe('x')
  })

  it('Reveal toggle: emits tutorial-preview:reveal-ai-rules with on/off', async () => {
    const captured: boolean[] = []
    window.addEventListener('tutorial-preview:reveal-ai-rules', (ev) => {
      captured.push((ev as CustomEvent).detail.on)
    })
    await import('./preview-banner')
    const sw = document.getElementById('preview-banner-reveal-ai')!
    sw.dispatchEvent(new CustomEvent('change', { detail: { checked: true } }))
    sw.dispatchEvent(new CustomEvent('change', { detail: { checked: false } }))
    expect(captured).toEqual([true, false])
  })

  it('auto-reset on load: clears tutorial-validation-__preview__-* keys', async () => {
    store['tutorial-validation-__preview__-stale'] = '{"old": true}'
    await import('./preview-banner')
    expect(store['tutorial-validation-__preview__-stale']).toBeUndefined()
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
npx vitest run hugo-apps/src/validation/preview-banner.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement preview-banner.ts**

```typescript
// hugo-apps/src/validation/preview-banner.ts
/**
 * [#655] Preview-only banner controller.
 *
 * Wires the Reset button and Reveal-AI-rules toggle to window-level
 * CustomEvents that Validation.vue + PreviewAINotice.vue listen for.
 * Also runs an auto-reset on load to wipe stale __preview__ localStorage
 * keys from prior preview sessions.
 *
 * Loaded by /js/preview-banner.js only when site.Params.previewMode is true.
 */

const PREVIEW_PREFIX = 'tutorial-validation-__preview__-'

function wipePreviewLocalStorage(): void {
  if (typeof localStorage === 'undefined') return
  const toRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(PREVIEW_PREFIX)) toRemove.push(key)
  }
  for (const k of toRemove) localStorage.removeItem(k)
}

function emit(name: string, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

function wireBanner(): void {
  const resetBtn = document.getElementById('preview-banner-reset')
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      wipePreviewLocalStorage()
      emit('tutorial-preview:reset-answers')
    })
  }
  const revealSwitch = document.getElementById('preview-banner-reveal-ai')
  if (revealSwitch) {
    revealSwitch.addEventListener('change', (ev) => {
      const on = (ev as CustomEvent).detail?.checked === true
      emit('tutorial-preview:reveal-ai-rules', { on })
    })
  }
}

// Auto-reset on load — prevents stale state across edits in the VSCode webview.
wipePreviewLocalStorage()

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireBanner)
} else {
  wireBanner()
}
```

- [ ] **Step 4: Add Vite entry**

Edit `hugo-apps/vite.config.ts`. In `build.rollupOptions.input`, add:

```typescript
'preview-banner': resolve(__dirname, 'src/validation/preview-banner.ts'),
```

(Match the existing entry-naming convention.)

- [ ] **Step 5: Run tests + build**

```bash
npx vitest run hugo-apps/src/validation/preview-banner.test.ts
cd hugo-apps && npm run build
```

Expected: all tests PASS, Vite emits `hugo/static/js/preview-banner.js`.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/validation/preview-banner.ts hugo-apps/src/validation/preview-banner.test.ts hugo-apps/vite.config.ts
git commit -m "feat(#655): preview-banner script + Vite entry

Reset button: wipes tutorial-validation-__preview__-* localStorage keys,
emits tutorial-preview:reset-answers. Reveal toggle: emits
tutorial-preview:reveal-ai-rules with on/off. Auto-reset on load
prevents stale state across edits."
```

---

## Task 11: AI notice in codecheck + Joule step-help partials

**Files:**
- Modify: `hugo/layouts/partials/codecheck-mount.html`
- Modify: `hugo/layouts/partials/joule-step-help.html`

- [ ] **Step 1: Read current codecheck-mount.html gate**

```bash
cat hugo/layouts/partials/codecheck-mount.html
```

Note the existing `{{ if and (not site.Params.qa) (not site.Params.previewMode) }}` gate.

- [ ] **Step 2: Add preview branch to codecheck-mount**

Edit `hugo/layouts/partials/codecheck-mount.html` to add a preview branch alongside the existing prod branch. Pattern:

```go-html
{{- /* [#655] In preview mode, render a PreviewAINotice mount with the
       page-level rules-vr-source. Prod path unchanged. */ -}}
{{- $cc := .codeCheck -}}
{{- if and site.Params.previewMode $cc -}}
<div class="step-codecheck-preview-mount"
     data-rules-block-id="rules-vr-source"></div>
{{- else if and (not site.Params.qa) (not site.Params.previewMode) $cc -}}
{{- /* existing prod path — leave intact */ -}}
... existing markup ...
{{- end -}}
```

(Read the file's full contents first; preserve the existing prod branch verbatim.)

A future task can hydrate `.step-codecheck-preview-mount` with a small Vue component that wraps `PreviewAINotice`; for v1 the same notice text + revealed rules.vr block is sufficient. **For this plan, defer that hydration to a follow-up** — the markup alone is enough for the Sage demo.

- [ ] **Step 3: Add preview branch to joule-step-help**

Edit `hugo/layouts/partials/joule-step-help.html`. Current gate (line 8) is `{{ if and (not site.Params.qa) (not site.Params.previewMode) }}`. Replace with:

```go-html
{{- /* [#655] In preview mode, render a small inline notice instead of the FAB.
       Authors should know step-help is published-only without seeing nothing. */ -}}
{{- if and (not site.Params.qa) site.Params.previewMode -}}
<div role="note" class="preview-joule-notice" aria-label="Joule step help (preview)">
  <small>Joule step help available after publish</small>
</div>
{{- else if and (not site.Params.qa) (not site.Params.previewMode) -}}
{{- /* existing FAB markup — leave intact */ -}}
... existing markup ...
{{- end -}}
```

(Preserve existing prod markup verbatim.)

- [ ] **Step 4: Hugo build sanity check**

```bash
cd hugo && hugo --quiet --logLevel error
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/partials/codecheck-mount.html hugo/layouts/partials/joule-step-help.html
git commit -m "feat(#655): codecheck + Joule preview notices

codecheck-mount.html: preview branch renders a PreviewAINotice mount
keyed off the page-level rules-vr-source script. Prod unchanged.

joule-step-help.html: preview branch renders 'available after publish'
inline notice instead of FAB. Prod unchanged."
```

---

## Task 12: End-to-end verification + spec backlink + PR

**Files:**
- Modify: `docs/superpowers/specs/2026-05-23-vscode-author-preview-design.md`

- [ ] **Step 1: Local smoke-test the full chain**

Start srv-qa locally and curl the endpoint:

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/655-preview-validation
npm run dev:hybrid &
sleep 8

curl -sS -X POST http://localhost:5000/preview/render \
  -H "Authorization: Bearer $LOCAL_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "markdown": "---\nparser: v2\ntitle: T\ndescription: x\ntime: 5\n---\n## You will learn\n- x\n## Prerequisites\n- none\n### Step 1\nBody.\n",
    "rulesVr": "[VALIDATE_1]\n###Question\nWhat is 2+2?\n###Rule mcq\n- [X] 4\n- [ ] 5\n[VALIDATE_END_1]\n"
  }' | grep -c "What is 2+2?"
```

Expected: ≥ 1 (question text in rendered HTML).

- [ ] **Step 2: Run the full unit test suite**

```bash
npm test
```

Expected: all unit tests PASS.

- [ ] **Step 3: Add backlink to original Preview API spec**

Edit `docs/superpowers/specs/2026-05-23-vscode-author-preview-design.md`. Find the "Out of scope (deferred follow-ups)" section. Add:

```markdown
- **F-8: Validation question support (rules.vr in preview).** Implemented in [2026-06-26-655-preview-validation-design.md](2026-06-26-655-preview-validation-design.md).
```

- [ ] **Step 4: Commit and push**

```bash
git add docs/superpowers/specs/2026-05-23-vscode-author-preview-design.md
git commit -m "docs(#655): backlink original Preview API spec → F-8 implementation"
git push
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create \
  --repo sap-tutorials/tutorials-ims \
  --base main \
  --head feature/655-preview-validation \
  --title "feat(#655): preview API validation question support (F-8)" \
  --body "Closes #655.

Brings POST /preview/render parity with the live render path for validation questions and AI-involved features:

- Accepts optional companion rulesVr in the request body
- Validation widget hydrates in preview with global Reset + Reveal-AI-rules controls
- AI-involved sections (free-text grading, AUTOAUTHOR, codecheck, Joule step-help) render a uniform static notice + source rules.vr block — no AI Core quota burn

Spec: docs/superpowers/specs/2026-06-26-655-preview-validation-design.md
Plan: docs/superpowers/plans/2026-06-26-655-preview-validation.md

Test coverage:
- Unit: composeTutorial+rulesVr, renderPreview+rulesVr, server payload validation, Validation.vue preview branches, PreviewAINotice, preview-banner
- Smoke: 5 new /preview/render cases

Backward-compat: existing { markdown }-only callers continue to work unchanged."
```

---

## Done criteria

- [ ] All Task 1-12 checkboxes completed
- [ ] All unit tests pass (`npm test`)
- [ ] All smoke tests pass against deployed srv-qa (post-CI deploy)
- [ ] Manual demo on srv-qa covers: hand-authored `[VALIDATE_N]`, `[AUTOAUTHOR_*]`, `[CODECHECK_N]`
- [ ] PR opened, reviewed, merged
- [ ] Issue #655 closed via PR

## Reviewer cross-references

- @superpowers/test-driven-development — every task follows red → green → refactor → commit.
- @superpowers/verification-before-completion — Task 12's local smoke before opening PR.
- @superpowers/requesting-code-review — subagent code review before PR.
- @feedback-pr-over-direct-merge — never fast-merge to main without PR.
- @feedback-srv-qa-cp-list — when touching srv-qa/lib/, re-walk transitive deps and confirm everything is in `.deploy/mta.yaml`'s `srv-qa` cp list. **Sanity check after Task 2** — bundle file is the only new srv-qa runtime dep; confirm it's already in the cp list.
- @feedback-skip-hybrid-test-costs-two-pr-cycles — preview is stateless, no DB access, so no hybrid test is required (verified in spec § Testing).
- @feedback-check-srv-qa-when-changing-srv — N/A (changes are inside srv-qa only).
